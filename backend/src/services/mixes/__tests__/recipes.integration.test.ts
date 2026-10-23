/**
 * The recipe engine on a real database. Small libraries written for each case check the query against numbers worked
 * by hand: the 1.0 line on the recipe score standardised within the library, components against the stored library
 * statistics, "low:" components, each filter, which songs are eligible, duplicates, the artist cap and its relaxation,
 * shipping short, hiding under 8 and the seeded draw. The synthetic library then checks every shipped recipe against
 * the same rules computed in TypeScript.
 */
import { prisma } from "../../../utils/db";
import { MOODS, MOOD_HEADS, type Mood } from "../../moods/heads";
import { MOOD_STATE_VERSION, READINGS, buildMoodState, loadMoodState, type MoodState, type Reading } from "../../moods/state";
import {
    MIN_MIX_TRACKS,
    RECIPES,
    parseRecipes,
    pickMixTracks,
    pickRecipeStation,
    pickRecipeTracks,
    pickStationTracks,
    type Recipe,
    type Signal,
} from "../recipes";
import {
    TRACK_COUNT,
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    seedSyntheticMoods,
} from "../../../__tests__/fixtures/syntheticLibrary";

jest.setTimeout(300_000);

const P = "crec";
const ANALYZED_AT = new Date("2026-10-23T00:00:00Z");
const UNIT = `[1${",0".repeat(MOOD_HEADS.dims - 1)}]`;
const USER = `${P}user`;
const DAY = "2026-10-23";

interface Song {
    name: string;
    /** Each song is its own artist unless named. */
    artist?: string;
    title?: string;
    /** Logits; a mood not named scores 0. */
    moods?: Partial<Record<Mood, number>>;
    arousal?: number | null;
    instrumentalness?: number | null;
    acousticness?: number | null;
    bpm?: number | null;
    bpmConfidence?: number | null;
    keyScale?: string | null;
    missing?: boolean;
    corrupt?: boolean;
    analysisStatus?: string;
    /** Its mood scores: current (the default), from an older sound vector, from other weights, or none. */
    scores?: "current" | "older-vector" | "other-weights" | "none";
}

type Stats = Partial<Record<`${Mood | Reading}_${"mean" | "sd"}`, number>>;

const id = (name: string) => `${P}${name}`;
const names = (ids: Iterable<string>) => new Set([...ids].map((x) => x.slice(P.length)));
const or = <T,>(value: T | undefined, fallback: T) => (value === undefined ? fallback : value);

/** The rows a test wrote, and every sound vector, so the library holds only what the next test writes. */
async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

/**
 * Writes `songs` as the whole library, with stored mood statistics of mean 0 and SD 1 for every mood and reading
 * unless `stats` says otherwise. Unless a song says otherwise: arousal, instrumental and acoustic 0.5 (a logit of 0),
 * 120 BPM on a steady beat, major.
 */
async function library(songs: Song[], stats: Stats = {}) {
    await cleanup();
    const artistOf = (s: Song) => s.artist ?? s.name;
    const artists = [...new Set(songs.map(artistOf))];
    await prisma.artist.createMany({
        data: artists.map((a) => ({ id: id(`art_${a}`), name: a, identityKey: id(`ak_${a}`) })),
    });
    await prisma.album.createMany({
        data: artists.map((a) => ({
            id: id(`alb_${a}`), artistId: id(`art_${a}`), rgMbid: id(`rg_${a}`), title: a, primaryType: "Album",
        })),
    });
    await prisma.track.createMany({
        data: songs.map((s) => ({
            id: id(s.name), albumId: id(`alb_${artistOf(s)}`), title: s.title ?? s.name, trackNo: 1, duration: 200,
            filePath: `/tmp/${id(s.name)}.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: s.analysisStatus ?? "completed",
            arousal: or(s.arousal, 0.5),
            instrumentalness: or(s.instrumentalness, 0.5),
            acousticness: or(s.acousticness, 0.5),
            bpm: or(s.bpm, 120),
            bpmConfidence: or(s.bpmConfidence, 3),
            keyScale: or(s.keyScale, "major"),
            missingSince: s.missing ? new Date() : null,
            corrupt: s.corrupt ?? false,
        })),
    });
    const scored = songs.filter((s) => s.scores !== "none");
    const vectorIds = scored.map((s) => id(s.name));
    await prisma.$executeRaw`
        INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
        SELECT tid, ${UNIT}::vector, ${MOOD_HEADS.model}, ${ANALYZED_AT} FROM unnest(${vectorIds}::text[]) AS tid
    `;
    await prisma.trackMood.createMany({
        data: scored.map((s) => ({
            track_id: id(s.name),
            embedded_at: s.scores === "older-vector" ? new Date(ANALYZED_AT.getTime() - 60_000) : ANALYZED_AT,
            weights: s.scores === "other-weights" ? "older-weights" : MOOD_HEADS.version,
            ...(Object.fromEntries(MOODS.map((mood) => [mood, s.moods?.[mood] ?? 0])) as Record<Mood, number>),
        })),
    });
    const neutral = Object.fromEntries([...MOODS, ...READINGS].flatMap((n) => [[`${n}_mean`, 0], [`${n}_sd`, 1]]));
    await prisma.moodState.create({
        data: {
            id: "default", version: MOOD_STATE_VERSION, fingerprint: "test", track_count: songs.length,
            ...(neutral as Required<Stats>), ...stats,
        },
    });
}

const recipe = (components: Record<string, number>, filters?: Record<string, unknown>): Recipe =>
    parseRecipes({ test: { name: "Test", components, ...(filters ? { filters } : {}) } }).get("test")!;

/** Every member of a recipe: a station refill larger than any test library. */
const membersOf = async (r: Recipe) => names(await pickStationTracks(r, { limit: 100_000 }));

const CALM = recipe({ calm: 1 });
/** Songs scoring 0 on every mood. */
const background = (n: number): Song[] => Array.from({ length: n }, (_, i) => ({ name: `bg${i}`, artist: "bg" }));
/** A song far above the line of the calm recipe in a library of mostly background songs. */
const member = (name: string, extra: Partial<Song> = {}): Song => ({ name, moods: { calm: 10 }, ...extra });

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("the line", () => {
    // calm 3, low dark 1, against stored statistics calm mean 1 SD 2, dark mean -1 SD 0.5:
    // score = (3 (calm - 1) / 2 - (dark + 1) / 0.5) / 4.
    const HAND_STATS: Stats = { calm_mean: 1, calm_sd: 2, dark_mean: -1, dark_sd: 0.5 };
    const HAND: Song[] = [
        ...Array.from({ length: 10 }, (_, i) => ({ name: `bg${i}`, moods: { calm: -1, dark: -0.5 } })), // score -1
        { name: "A", moods: { calm: 3, dark: -1.5 } }, // 1
        { name: "B", moods: { calm: 5, dark: -1.25 } }, // 1.625
        { name: "C", moods: { calm: 2, dark: -1.25 } }, // 0.5
        { name: "E", moods: { calm: 0.5, dark: -2.5 } }, // 0.5625
    ];
    const CALM_LOW_DARK = recipe({ calm: 3, "low:dark": 1 });

    it("keeps the songs at least 1 SD above the library's average recipe score (worked by hand)", async () => {
        // Scores' mean -0.4509, SD 0.9008: z of A 1.611, B 2.304, C 1.056, E 1.125, the rest -0.610.
        // C and E are in although their scores, 0.5 and 0.5625, are under 1: the line is on the standardised score.
        await library(HAND, HAND_STATS);
        expect(await membersOf(CALM_LOW_DARK)).toEqual(new Set(["A", "B", "C", "E"]));
    });

    it("draws the line at 1 standard deviation", async () => {
        // Calm alone against mean 0, SD 1: ten songs at 0 and three at 1.6875, 1.8125 and 4. Mean 0.5769, SD 1.1703;
        // z 0.949, 1.056 and 2.925.
        await library([
            ...background(10),
            { name: "z095", moods: { calm: 1.6875 } },
            { name: "z106", moods: { calm: 1.8125 } },
            { name: "z292", moods: { calm: 4 } },
        ]);
        expect(await membersOf(CALM)).toEqual(new Set(["z106", "z292"]));
    });

    it("standardises within the library: B is in above, and out of a library with more songs like it", async () => {
        // Six more songs scoring 2 and one scoring 6: mean 0.5565, SD 1.7955; z of B 0.595, of the 2s 0.804, D 3.032,
        // A 0.247, C -0.032, E 0.003.
        await library(
            [
                ...HAND,
                ...Array.from({ length: 6 }, (_, i) => ({ name: `hi${i}`, moods: { calm: 5, dark: -2 } })),
                { name: "D", moods: { calm: 15, dark: -2.5 } },
            ],
            HAND_STATS,
        );
        expect(await membersOf(CALM_LOW_DARK)).toEqual(new Set(["D"]));
    });

    it("scores each component against the stored library statistics", async () => {
        // The same songs with dark's stored SD 0.05: dark weighs ten times more. Scores -3.25, A 3.25, B 2.75,
        // C 1.625, E 7.3125; mean -1.2545, SD 3.3576; z of E 2.552, A 1.342, B 1.193, and C 0.858 falls out.
        await library(HAND, { ...HAND_STATS, dark_sd: 0.05 });
        expect(await membersOf(CALM_LOW_DARK)).toEqual(new Set(["A", "B", "E"]));
    });

    it("pushes away the songs high in a low: component", async () => {
        // Counting dark up instead: scores -0.5, A 0.5, B 1.375, C 0.25, E -0.9375; z of B 2.892, A 1.356, C 0.917,
        // E -1.168.
        await library(HAND, HAND_STATS);
        expect(await membersOf(recipe({ calm: 3, dark: 1 }))).toEqual(new Set(["A", "B"]));
        expect(await membersOf(CALM_LOW_DARK)).toEqual(new Set(["A", "B", "C", "E"]));
    });

    it("raises rather than picks when every eligible song scores the same", async () => {
        await library(background(10));
        await expect(pickStationTracks(CALM, { limit: 10 })).rejects.toThrow("every eligible song has the same score");
    });

    it("raises when the library's statistics give a component no spread", async () => {
        await library([...background(10), member("M")], { calm_sd: 0 });
        await expect(pickStationTracks(CALM, { limit: 10 })).rejects.toThrow("calm has no spread");
    });
});

describe("filters", () => {
    it("BPM band: the tempo, its double or its half inside, bounds included, on a steady beat only", async () => {
        await library([
            ...background(40),
            member("in120", { bpm: 120 }),
            member("double60", { bpm: 60 }),
            member("half240", { bpm: 240 }),
            member("low110", { bpm: 110 }),
            member("high140steady2", { bpm: 140, bpmConfidence: 2 }),
            member("out100", { bpm: 100 }),
            member("unsteady125", { bpm: 125, bpmConfidence: 1.9 }),
            member("noTempo", { bpm: null }),
            member("noConfidence", { bpmConfidence: null }),
        ]);
        expect(await membersOf(recipe({ calm: 1 }, { bpm: [110, 140] }))).toEqual(
            new Set(["in120", "double60", "half240", "low110", "high140steady2"]),
        );
    });

    it("vocals: CLAP instrumental at most or at least a bound, bounds included", async () => {
        await library([
            ...background(40),
            member("i20", { instrumentalness: 0.2 }),
            member("i50", { instrumentalness: 0.5 }),
            member("i51", { instrumentalness: 0.51 }),
            member("i74", { instrumentalness: 0.74 }),
            member("i75", { instrumentalness: 0.75 }),
            member("i99", { instrumentalness: 0.99 }),
            member("unknown", { instrumentalness: null }),
        ]);
        expect(await membersOf(recipe({ calm: 1 }, { instrumental_max: 0.5 }))).toEqual(new Set(["i20", "i50"]));
        expect(await membersOf(recipe({ calm: 1 }, { instrumental_min: 0.75 }))).toEqual(new Set(["i75", "i99"]));
    });

    it("energy band: arousal's percentile among the eligible songs, not its value", async () => {
        // 40 songs at arousal 0.1 and four members; 44 eligible, so a song's percentile is (songs below it) / 43.
        // 0.3 → 43/43, 0.2 → 42/43, 0.1 (tied with the 40) → 1/43, 0.05 → 0.
        await library([
            ...background(40).map((s) => ({ ...s, arousal: 0.1 })),
            member("a30", { arousal: 0.3 }),
            member("a20", { arousal: 0.2 }),
            member("a10", { arousal: 0.1 }),
            member("a05", { arousal: 0.05 }),
            member("unknown", { arousal: null }),
        ]);
        expect(await membersOf(recipe({ calm: 1 }, { arousal_pct: [0.5, 1] }))).toEqual(new Set(["a30", "a20"]));
        expect(await membersOf(recipe({ calm: 1 }, { arousal_pct: [0, 0.75] }))).toEqual(new Set(["a10", "a05"]));
    });

    it("minor key only", async () => {
        await library([
            ...background(40),
            member("minor", { keyScale: "minor" }),
            member("major", { keyScale: "major" }),
            member("unknown", { keyScale: null }),
        ]);
        expect(await membersOf(recipe({ calm: 1 }, { minor: true }))).toEqual(new Set(["minor"]));
    });
});

describe("eligible songs", () => {
    it("leaves a song missing a reading the recipe uses out of that recipe only", async () => {
        await library([...background(40), member("full"), member("noAcoustic", { acousticness: null })]);
        expect(await membersOf(CALM)).toEqual(new Set(["full", "noAcoustic"]));
        expect(await membersOf(recipe({ calm: 1, acoustic: 1 }))).toEqual(new Set(["full"]));
    });

    it("takes only finished analysis, a present readable file and scores current for the vector and the weights", async () => {
        await library([
            ...background(40),
            member("ok"),
            member("missing", { missing: true }),
            member("corrupt", { corrupt: true }),
            member("pending", { analysisStatus: "pending" }),
            member("olderVector", { scores: "older-vector" }),
            member("otherWeights", { scores: "other-weights" }),
            member("unscored", { scores: "none" }),
        ]);
        expect(await membersOf(CALM)).toEqual(new Set(["ok"]));
    });

    it("counts one title by one artist once, keeping the copy furthest above the line", async () => {
        await library([
            ...background(40),
            member("first", { artist: "x", title: "Same Song" }),
            member("better", { artist: "x", title: "same song", moods: { calm: 12 } }),
            member("otherArtist", { artist: "y", title: "Same Song" }),
        ]);
        expect(await membersOf(CALM)).toEqual(new Set(["better", "otherArtist"]));
    });

    it("has no members until the mood step has built statistics for these weights", async () => {
        await library([...background(40), ...Array.from({ length: 10 }, (_, i) => member(`m${i}`))]);
        expect(await pickMixTracks(CALM, { userId: USER, date: DAY })).not.toBeNull();
        await prisma.moodState.update({ where: { id: "default" }, data: { version: "older" } });
        expect(await pickMixTracks(CALM, { userId: USER, date: DAY })).toBeNull();
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        expect(await pickMixTracks(CALM, { userId: USER, date: DAY })).toBeNull();
        expect(await pickStationTracks(CALM, { limit: 50 })).toEqual([]);
    });
});

describe("the mix draw", () => {
    const members = (n: number, artistOf: (i: number) => string = (i) => `a${i}`) =>
        Array.from({ length: n }, (_, i) => member(`m${String(i).padStart(2, "0")}`, { artist: artistOf(i) }));
    const artistsOf = async (ids: string[]) => {
        const rows = await prisma.track.findMany({ where: { id: { in: ids } }, select: { album: { select: { artistId: true } } } });
        const perArtist = new Map<string, number>();
        for (const row of rows) perArtist.set(row.album.artistId, (perArtist.get(row.album.artistId) ?? 0) + 1);
        return [...perArtist.values()].sort();
    };

    it("ships at most 2 songs per artist while that still makes 8", async () => {
        await library([...background(100), ...members(12, (i) => `a${i % 4}`)]);
        const mix = await pickMixTracks(CALM, { userId: USER, date: DAY });
        expect(mix?.members).toBe(12);
        expect(await artistsOf(mix!.trackIds)).toEqual([2, 2, 2, 2]);
    });

    it("allows 3 per artist when 2 leaves fewer than 8", async () => {
        await library([...background(100), ...members(12, (i) => `a${i % 3}`)]);
        const mix = await pickMixTracks(CALM, { userId: USER, date: DAY });
        expect(await artistsOf(mix!.trackIds)).toEqual([3, 3, 3]);
    });

    it("lifts the cap when 3 per artist still leaves fewer than 8", async () => {
        await library([...background(100), ...members(10, () => "solo")]);
        const mix = await pickMixTracks(CALM, { userId: USER, date: DAY });
        expect(mix?.trackIds).toHaveLength(10);
    });

    it("ships short, and has no mix under 8 members", async () => {
        await library([...background(100), ...members(12)]);
        expect((await pickMixTracks(CALM, { userId: USER, date: DAY }))?.trackIds).toHaveLength(12);
        await library([...background(100), ...members(MIN_MIX_TRACKS)]);
        expect((await pickMixTracks(CALM, { userId: USER, date: DAY }))?.trackIds).toHaveLength(MIN_MIX_TRACKS);
        await library([...background(100), ...members(MIN_MIX_TRACKS - 1)]);
        expect(await pickMixTracks(CALM, { userId: USER, date: DAY })).toBeNull();
    });

    describe("from 30 members", () => {
        beforeAll(async () => {
            await library([...background(100), ...members(30)]);
        });

        it("draws 20 songs, the same for one recipe, day and user, others for another user, day or recipe", async () => {
            const mix = await pickMixTracks(CALM, { userId: USER, date: DAY });
            expect(mix?.members).toBe(30);
            expect(mix?.trackIds).toHaveLength(20);
            expect(new Set(mix?.trackIds).size).toBe(20);
            expect(await pickMixTracks(CALM, { userId: USER, date: DAY })).toEqual(mix);
            expect((await pickMixTracks(CALM, { userId: `${USER}2`, date: DAY }))?.trackIds).not.toEqual(mix?.trackIds);
            expect((await pickMixTracks(CALM, { userId: USER, date: "2026-10-24" }))?.trackIds).not.toEqual(mix?.trackIds);
            const otherRecipe = parseRecipes({ other: { name: "Other", components: { calm: 1 } } }).get("other")!;
            expect((await pickMixTracks(otherRecipe, { userId: USER, date: DAY }))?.trackIds).not.toEqual(mix?.trackIds);
        });

        it("reaches every member across days", async () => {
            const seen = new Set<string>();
            for (let d = 1; d <= 30; d++) {
                const date = `2026-11-${String(d).padStart(2, "0")}`;
                for (const t of (await pickMixTracks(CALM, { userId: USER, date }))!.trackIds) seen.add(t);
            }
            expect(seen.size).toBe(30);
        });

        it("refills a station with members in a fresh order each call", async () => {
            const first = await pickStationTracks(CALM, { limit: 30 });
            const second = await pickStationTracks(CALM, { limit: 30 });
            expect(new Set(first)).toEqual(new Set(second));
            expect(first).toHaveLength(30);
            expect(first).not.toEqual(second);
            expect(await pickStationTracks(CALM, { limit: 5 })).toHaveLength(5);
        });

        it("refuses a mix smaller than its own minimum, and a draw without a user or day", async () => {
            await expect(pickMixTracks(CALM, { userId: USER, date: DAY, limit: 5 })).rejects.toThrow(RangeError);
            await expect(pickMixTracks(CALM, { userId: "", date: DAY })).rejects.toThrow("drawn for a user");
            await expect(pickMixTracks(CALM, { userId: USER, date: "" })).rejects.toThrow("drawn for a day");
        });
    });

    it("refuses a recipe id it does not know", async () => {
        await expect(pickRecipeTracks("no-such-mix", { userId: USER, date: DAY })).rejects.toThrow("Unknown recipe");
        await expect(pickRecipeStation("no-such-mix", { limit: 10 })).rejects.toThrow("Unknown recipe");
    });
});

describe("every shipped recipe on the synthetic library", () => {
    const S = "crs_";
    let state: MoodState;

    interface Row {
        id: string;
        titleKey: string;
        artistId: string;
        moods: Record<Mood, number>;
        arousal: number | null;
        instrumentalness: number | null;
        acousticness: number | null;
        bpm: number | null;
        bpmConfidence: number | null;
        keyScale: string | null;
    }
    let rows: Row[];
    /** Pairs of one title by one artist, both far above the line of the sleep recipe. */
    const copies: [string, string][] = [];
    const READING_STATS = { arousal: "arousal", instrumental: "instrumental_logit", acoustic: "acoustic_logit" } as const;

    const logit = (p: number) => {
        const c = Math.min(0.99, Math.max(0.01, p));
        return Math.log(c / (1 - c));
    };
    const meanSd = (xs: number[]) => {
        const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
        return { mean, sd: Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) };
    };
    const value = (row: Row, signal: Signal): number | null => {
        if ((MOODS as readonly string[]).includes(signal)) return row.moods[signal as Mood];
        if (signal === "arousal") return row.arousal === null ? null : logit(row.arousal);
        if (signal === "instrumental") return row.instrumentalness === null ? null : logit(row.instrumentalness);
        if (signal === "acoustic") return row.acousticness === null ? null : logit(row.acousticness);
        return row.keyScale === "minor" ? 1 : row.keyScale === "major" ? 0 : null;
    };

    /** W5's rules written out in TypeScript: members, and songs too close to the line to call either way. */
    function expected(r: Recipe): { members: Set<string>; close: Set<string> } {
        const minor = meanSd(rows.map((row) => value(row, "minor")).filter((v): v is number => v !== null));
        const stats = (signal: Signal) => {
            if (signal === "minor") return minor;
            if ((MOODS as readonly string[]).includes(signal)) return state.moods[signal as Mood];
            return state.readings[READING_STATS[signal as keyof typeof READING_STATS]];
        };
        const { bpm, instrumentalMax, instrumentalMin, arousalPct, minor: minorOnly } = r.filters;
        const eligible = rows.filter(
            (row) =>
                r.components.every((c) => value(row, c.signal) !== null) &&
                (!bpm || (row.bpm !== null && row.bpmConfidence !== null)) &&
                ((instrumentalMax === undefined && instrumentalMin === undefined) || row.instrumentalness !== null) &&
                (!arousalPct || row.arousal !== null) &&
                (!minorOnly || row.keyScale !== null),
        );
        const total = r.components.reduce((s, c) => s + Math.abs(c.weight), 0);
        const scores = eligible.map(
            (row) =>
                r.components.reduce((s, c) => {
                    const { mean, sd } = stats(c.signal);
                    return s + (c.weight * (value(row, c.signal)! - mean)) / sd;
                }, 0) / total,
        );
        const spread = meanSd(scores);
        const arousals = eligible.map((row) => row.arousal);
        const best = new Map<string, { id: string; z: number }>();
        const close = new Set<string>();
        eligible.forEach((row, i) => {
            const z = (scores[i] - spread.mean) / spread.sd;
            if (Math.abs(z - 1) < 1e-6) close.add(row.id);
            if (z < 1) return;
            if (bpm) {
                const inBand = (b: number) => b >= bpm[0] && b <= bpm[1];
                if (row.bpmConfidence! < 2 || !(inBand(row.bpm!) || inBand(row.bpm! * 2) || inBand(row.bpm! / 2))) return;
            }
            if (instrumentalMax !== undefined && row.instrumentalness! > instrumentalMax) return;
            if (instrumentalMin !== undefined && row.instrumentalness! < instrumentalMin) return;
            if (arousalPct) {
                const pct = arousals.filter((a) => a! < row.arousal!).length / (eligible.length - 1);
                if (pct < arousalPct[0] || pct > arousalPct[1]) return;
            }
            if (minorOnly && row.keyScale !== "minor") return;
            const key = `${row.titleKey}\0${row.artistId}`;
            const kept = best.get(key);
            if (!kept || z > kept.z || (z === kept.z && row.id < kept.id)) best.set(key, { id: row.id, z });
        });
        return { members: new Set([...best.values()].map((b) => b.id)), close };
    }

    beforeAll(async () => {
        await cleanup();
        await seedSyntheticLibrary(S);
        await seedSyntheticMoods(S);
        // Copies: in each of 40 albums the second eligible track takes the first's title in upper case, and both
        // score high on the sleep recipe's moods.
        for (let album = 0; album < 40; album++) {
            const pair = await prisma.track.findMany({
                where: {
                    albumId: `${S}alb_${album}`, missingSince: null, corrupt: false, analysisStatus: "completed",
                    arousal: { not: null }, instrumentalness: { not: null }, acousticness: { not: null },
                },
                orderBy: { id: "asc" },
                take: 2,
            });
            if (pair.length < 2) continue;
            await prisma.track.update({ where: { id: pair[1].id }, data: { title: pair[0].title.toUpperCase() } });
            await prisma.trackMood.updateMany({
                where: { track_id: { in: pair.map((t) => t.id) } },
                data: { sleep: 4, calm: 3 },
            });
            copies.push([pair[0].id, pair[1].id]);
        }
        await prisma.$transaction((tx) => buildMoodState(tx));
        state = (await loadMoodState())!;
        const tracks = await prisma.track.findMany({
            where: {
                id: { startsWith: S }, missingSince: null, corrupt: false, analysisStatus: "completed",
                trackEmbedding: { trackMood: { weights: MOOD_HEADS.version } },
            },
            include: { album: { select: { artistId: true } }, trackEmbedding: { include: { trackMood: true } } },
        });
        rows = tracks.map((t) => ({
            id: t.id,
            titleKey: t.title.toLowerCase(),
            artistId: t.album.artistId,
            moods: Object.fromEntries(MOODS.map((m) => [m, t.trackEmbedding!.trackMood![m]])) as Record<Mood, number>,
            arousal: t.arousal,
            instrumentalness: t.instrumentalness,
            acousticness: t.acousticness,
            bpm: t.bpm,
            bpmConfidence: t.bpmConfidence,
            keyScale: t.keyScale,
        }));
    });

    afterAll(async () => {
        await removeSyntheticLibrary(S);
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    });

    it("covers the songs the statistics cover", () => {
        expect(state.trackCount).toBe(rows.length);
        expect(rows.length).toBeGreaterThan(TRACK_COUNT * 0.85);
        expect(rows.length).toBeLessThan(TRACK_COUNT * 0.95);
    });

    it.each([...RECIPES.keys()])("%s: the members W5's rules give, and a mix drawn from them", async (recipeId) => {
        const r = RECIPES.get(recipeId)!;
        const want = expected(r);
        const got = new Set(await pickRecipeStation(recipeId, { limit: 100_000 }));
        const drop = (s: Set<string>) => new Set([...s].filter((x) => !want.close.has(x)));
        expect(drop(got)).toEqual(drop(want.members));
        expect(want.members.size).toBeGreaterThan(0);

        const mix = await pickRecipeTracks(recipeId, { userId: USER, date: DAY });
        if (want.members.size < MIN_MIX_TRACKS) {
            expect(mix).toBeNull();
            return;
        }
        expect(mix!.members).toBe(got.size);
        expect(mix!.trackIds.every((t) => got.has(t))).toBe(true);
        const perArtist = new Map<string, number>();
        for (const t of [...got]) {
            const artist = rows.find((row) => row.id === t)!.artistId;
            perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
        }
        const cap = [2, 3, Infinity].find(
            (c) => [...perArtist.values()].reduce((s, n) => s + Math.min(n, c), 0) >= MIN_MIX_TRACKS,
        )!;
        const available = [...perArtist.values()].reduce((s, n) => s + Math.min(n, cap), 0);
        expect(mix!.trackIds).toHaveLength(Math.min(20, available));
        const drawnPerArtist = new Map<string, number>();
        for (const t of mix!.trackIds) {
            const artist = rows.find((row) => row.id === t)!.artistId;
            drawnPerArtist.set(artist, (drawnPerArtist.get(artist) ?? 0) + 1);
        }
        expect(Math.max(...drawnPerArtist.values())).toBeLessThanOrEqual(cap);
    });

    it("keeps one of each pair of copies", async () => {
        const got = new Set(await pickRecipeStation("sleep", { limit: 100_000 }));
        expect(copies.length).toBeGreaterThan(30);
        for (const pair of copies) expect(pair.filter((t) => got.has(t))).toHaveLength(1);
    });
});
