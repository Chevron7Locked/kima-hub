/**
 * GET /library/radio, every branch, against a real Postgres holding the 3,000
 * track synthetic library (src/__tests__/fixtures/syntheticLibrary.ts; ids are
 * handed out in energy order, so a "first N rows" draw shows up as ids bunched
 * at the front). The library router is mounted on a real express app and
 * called over HTTP with supertest; the route does not read the signed-in user,
 * so no auth is mounted and nothing is mocked.
 *
 * For each branch, over 10 consecutive calls:
 *   1. size   - each call returns exactly `limit` tracks, no repeats;
 *   2. clause - every track satisfies the branch's clause (written out here
 *               against the stored row) and is playable (file present, not
 *               corrupt);
 *   3. spread - together the calls return more than 3x `limit` distinct
 *               tracks and reach the first and the last third of the ids that
 *               match (the branch has well over 10x `limit` matches).
 *
 * The mood and workout stations draw from their recipes (recipes.json): their
 * clause is membership of the recipe, as the recipe engine computes it on the
 * library's learned moods (recipes.integration.test.ts checks the engine). The
 * Wildcard station plays the scored songs no mood claims, worked out here from
 * the stored scores and statistics.
 *
 * The describe blocks at the end change the library (deleting plays, clearing
 * the mood statistics) to reach the fallback stages; they run last and the
 * library is deleted afterwards.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import {
    LibraryHandle,
    Row,
    loadRows,
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    seedSyntheticMoods,
    spanOf,
} from "../../../__tests__/fixtures/syntheticLibrary";
import { buildMoodState } from "../../../services/moods/state";
import { pickRecipeStation } from "../../../services/mixes/recipes";
import { MOODS, MOOD_HEADS, type Mood } from "../../../services/moods/heads";
import { loadMoodState } from "../../../services/moods/state";
import router from "../tracks";

jest.setTimeout(600_000);

const PREFIX = "rad_";
const LIMIT = 20;
const CALLS = 10;

let lib: LibraryHandle;
let rows: Row[];
let byId: Map<string, Row>;

const app = express();
app.use(express.json());
app.use("/", router);

/** The recipe behind each station value, as the product names them (Kevin 10-24); Wildcard has its own tests. */
const STATIONS: [query: Record<string, string>, recipe: string][] = [
    [{ type: "mood", value: "calm" }, "calm-station"],
    [{ type: "mood", value: "energy" }, "energy-station"],
    [{ type: "mood", value: "intense" }, "intense-station"],
    [{ type: "mood", value: "happy" }, "happy"],
    [{ type: "mood", value: "melancholy" }, "melancholy-station"],
    [{ type: "mood", value: "summer" }, "summer-station"],
    [{ type: "mood", value: "focus" }, "focus-station"],
    [{ type: "mood", value: "feel-good" }, "feel-good-station"],
    [{ type: "mood", value: "late-night" }, "late-night"],
    [{ type: "mood", value: "romantic" }, "romantic-station"],
    [{ type: "mood", value: "road-trip" }, "road-trip"],
    [{ type: "mood", value: "nostalgic" }, "nostalgic"],
    [{ type: "mood", value: "epic" }, "epic"],
    [{ type: "workout" }, "workout"],
];
/** Every member of each station's recipe. */
const members = new Map<string, Set<string>>();

beforeAll(async () => {
    lib = await seedSyntheticLibrary(PREFIX);
    await seedSyntheticMoods(PREFIX);
    await prisma.$transaction((tx) => buildMoodState(tx));
    rows = await loadRows(PREFIX, lib.user1);
    byId = new Map(rows.map((r) => [r.id, r]));
    for (const [, recipe] of STATIONS) members.set(recipe, new Set(await pickRecipeStation(recipe, { limit: 100_000 })));
});

afterAll(async () => {
    await removeSyntheticLibrary(PREFIX);
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$disconnect();
});

// ---- clause vocabulary -----------------------------------------------------

const playable = (r: Row) => r.missingSince === null && !r.corrupt;
const inRecipe = (recipe: string) => (r: Row) => members.get(recipe)!.has(r.id);
const year = (r: Row) => r.album.originalYear ?? r.album.year;
const artistGenres = (r: Row) =>
    [...((r.album.artist.genres as string[] | null) ?? []), ...((r.album.artist.userGenres as string[] | null) ?? [])];

interface RadioTrack {
    id: string;
    title: string;
    filePath: string;
    artist: { id: string; name: string };
    album: { id: string; title: string };
}

async function radio(query: Record<string, string | number>) {
    const res = await request(app).get("/radio").query(query);
    return res;
}

async function calls(query: Record<string, string | number>, n = CALLS): Promise<RadioTrack[][]> {
    const out: RadioTrack[][] = [];
    for (let k = 0; k < n; k++) {
        const res = await radio(query);
        expect(res.status).toBe(200);
        out.push(res.body.tracks);
    }
    return out;
}

interface Branch {
    name: string;
    query: Record<string, string | number>;
    /** The branch's clause, by hand (without the playable check, which every branch shares). */
    clause: (r: Row) => boolean;
    /** Fewest tracks the clause must match for the spread checks to mean something; LIMIT x 10 unless set. */
    minMatch?: number;
}

const branches: Branch[] = [
    { name: "discovery", query: { type: "discovery" }, clause: (r) => r.plays === 0 },
    { name: "favorites", query: { type: "favorites" }, clause: (r) => r.plays > 0 },
    { name: "decade 1990", query: { type: "decade", value: 1990 },
      clause: (r) => year(r) !== null && year(r)! >= 1990 && year(r)! < 2000 },
    { name: "decade 1970", query: { type: "decade", value: 1970 },
      clause: (r) => year(r) !== null && year(r)! >= 1970 && year(r)! < 1980 },
    { name: "genre rock", query: { type: "genre", value: "rock" },
      clause: (r) => artistGenres(r).some((g) => g.toLowerCase().includes("rock")) },
    { name: "genre Pop (value is lower-cased)", query: { type: "genre", value: "Pop" },
      clause: (r) => artistGenres(r).some((g) => g.toLowerCase().includes("pop")) },
    ...STATIONS.map(([query, recipe]) => ({
        name: `${Object.values(query).join(" ")} (recipe ${recipe})`,
        query,
        clause: inRecipe(recipe),
        // A recipe's members are about the top 7% of the library, fewer with its filters.
        minMatch: LIMIT * 4,
    })),
    { name: "all", query: { type: "all" }, clause: () => true },
];

describe.each(branches)("radio: $name", (b) => {
    let results: RadioTrack[][] = [];
    beforeAll(async () => {
        results = await calls({ ...b.query, limit: LIMIT });
    });
    const matching = () => rows.filter((r) => playable(r) && b.clause(r)).map((r) => r.id);

    it(`returns exactly ${LIMIT} distinct tracks on every call`, () => {
        expect(results).toHaveLength(CALLS);
        for (const tracks of results) {
            expect(tracks).toHaveLength(LIMIT);
            expect(new Set(tracks.map((t) => t.id)).size).toBe(LIMIT);
        }
    });

    it("returns only playable tracks that satisfy the clause", () => {
        expect(matching().length).toBeGreaterThanOrEqual(b.minMatch ?? LIMIT * 10);
        const ids = results.flat().map((t) => t.id);
        expect(ids.filter((id) => !byId.has(id))).toEqual([]);
        expect(ids.filter((id) => !playable(byId.get(id)!))).toEqual([]);
        expect(ids.filter((id) => !b.clause(byId.get(id)!))).toEqual([]);
    });

    it("returns each track with its artist, album and file", () => {
        for (const t of results[0]) {
            const r = byId.get(t.id)!;
            expect(t.artist.id).toBe(r.album.artist.id);
            expect(t.album.id).toBe(r.album.id);
            expect(typeof t.filePath).toBe("string");
        }
    });

    it("draws from the whole match: ten calls give well over one pool, across the id range", () => {
        const span = spanOf(results.flat().map((t) => t.id), matching());
        expect(span.distinct).toBeGreaterThan(LIMIT * 3);
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });
});

describe("radio: favorites weighting", () => {
    it("leans toward tracks played more, without being limited to the top few", async () => {
        const results = (await calls({ type: "favorites", limit: LIMIT }, 15)).flat();
        const played = rows.filter((r) => playable(r) && r.plays > 0);
        const meanAll = played.reduce((s, r) => s + r.plays, 0) / played.length;
        const meanReturned = results.reduce((s, t) => s + byId.get(t.id)!.plays, 0) / results.length;
        expect(meanReturned).toBeGreaterThan(meanAll);
        const topTen = new Set([...played].sort((a, b) => b.plays - a.plays).slice(0, 10).map((r) => r.id));
        const distinct = new Set(results.map((t) => t.id));
        expect([...distinct].filter((id) => !topTen.has(id)).length).toBeGreaterThan(100);
    });
});

describe("radio: all", () => {
    it("returns 50 by default and at most 100 for a larger limit", async () => {
        const dflt = await radio({ type: "all" });
        expect(dflt.body.tracks).toHaveLength(50);
        const big = await radio({ type: "all", limit: 500 });
        expect(big.body.tracks).toHaveLength(100);
    });

    it("treats a zero or negative limit as a page of at least 1, never as a draw from the end", async () => {
        expect((await radio({ type: "all", limit: 0 })).body.tracks).toHaveLength(50);
        expect((await radio({ type: "all", limit: -5 })).body.tracks).toHaveLength(1);
        expect((await radio({ type: "mood", value: "happy", limit: -5 })).body.tracks).toHaveLength(1);
        expect((await radio({ type: "artist", value: `${PREFIX}art_5`, limit: 1 })).body.tracks).toHaveLength(1);
    });
});

describe("radio: artist", () => {
    const ARTIST = `${PREFIX}art_5`;
    // The fixture makes artist 5 similar to artists 6..15 (SimilarArtist rows, all owned).
    const similarIds = new Set(Array.from({ length: 10 }, (_, i) => `${PREFIX}art_${6 + i}`));
    let results: RadioTrack[][] = [];
    beforeAll(async () => {
        results = await calls({ type: "artist", value: ARTIST, limit: LIMIT });
    });

    it("mixes the artist's own tracks (40%) with tracks of similar artists, all playable", () => {
        for (const tracks of results) {
            const own = tracks.filter((t) => t.artist.id === ARTIST);
            const similar = tracks.filter((t) => similarIds.has(t.artist.id));
            expect(own.length + similar.length).toBe(tracks.length);
            expect(own.length).toBeLessThanOrEqual(Math.ceil(LIMIT * 0.4));
            expect(similar.length).toBeLessThanOrEqual(LIMIT - Math.ceil(LIMIT * 0.4));
            expect(tracks.every((t) => playable(byId.get(t.id)!))).toBe(true);
        }
    });

    it("returns the full limit", () => {
        // The branch keeps only playable tracks (file present, not corrupt) before it splits the answer into the
        // artist's own 40% and similar artists' 60%, so unplayable tracks (6% of the fixture) never take a slot.
        expect(results.map((t) => t.length)).toEqual(Array(CALLS).fill(LIMIT));
    });

    it("varies from call to call", () => {
        const distinct = new Set(results.flat().map((t) => t.id));
        expect(distinct.size).toBeGreaterThan(LIMIT);
    });

    it("answers an artist with no tracks with an empty list", async () => {
        const res = await radio({ type: "artist", value: "no-such-artist" });
        expect(res.status).toBe(200);
        expect(res.body.tracks).toEqual([]);
    });
});

describe("radio: every mood value and the workout station draw from their recipe", () => {
    it.each(STATIONS)("%o draws from recipe %s, every member reachable", async (query, recipe) => {
        const want = members.get(recipe)!;
        const seen = new Set<string>();
        // Refills adding up to four times the members: each is missed with probability about e^-4 (2%).
        for (let k = 0; k < Math.max(5, Math.ceil((want.size * 4) / 100)); k++) {
            const res = await radio({ ...query, limit: 100 });
            expect(res.status).toBe(200);
            const ids = (res.body.tracks as RadioTrack[]).map((t) => t.id);
            expect(ids).toHaveLength(Math.min(100, want.size));
            expect(ids.filter((id) => !want.has(id))).toEqual([]);
            ids.forEach((id) => seen.add(id));
        }
        expect(seen.size).toBeGreaterThan(want.size * 0.9);
    });

    it("the mood value is read in any case", async () => {
        const res = await radio({ type: "mood", value: "Late-Night", limit: LIMIT });
        expect(res.status).toBe(200);
        expect((res.body.tracks as RadioTrack[]).every((t) => members.get("late-night")!.has(t.id))).toBe(true);
    });
});

describe("radio: Wildcard, the songs no mood claims", () => {
    const UNSCORED = Array.from({ length: 3 }, (_, i) => `${PREFIX}unscored_${i}`);
    /** The scored songs every mood sits under 1.25 SD above the library's mean for, by the stored statistics. */
    let unclaimed = new Set<string>();

    beforeAll(async () => {
        const state = (await loadMoodState())!;
        const scored = await prisma.$queryRawUnsafe<Array<{ id: string } & Record<Mood, number>>>(
            `SELECT m.track_id AS id, ${MOODS.map((m) => `m."${m}"::float8 AS "${m}"`).join(", ")}
             FROM track_moods m
             JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
             JOIN "Track" t ON t.id = m.track_id
             WHERE m.weights = $1 AND te.model_version = $2 AND t.id LIKE $3
               AND t."missingSince" IS NULL AND t.corrupt = false AND t."analysisStatus" = 'completed'`,
            MOOD_HEADS.version, MOOD_HEADS.model, `${PREFIX}%`,
        );
        unclaimed = new Set(
            scored
                .filter((row) => MOODS.every((m) => !(state.moods[m].sd > 0) || (row[m] - state.moods[m].mean) / state.moods[m].sd < 1.25))
                .map((row) => row.id),
        );
        // Songs with no scores at all: finished, playable, and never Wildcard.
        await prisma.track.createMany({
            data: UNSCORED.map((id, i) => ({
                id, albumId: `${PREFIX}alb_0`, title: `Unscored ${i}`, trackNo: 90 + i, duration: 200,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000, analysisStatus: "completed",
            })),
        });
    });

    afterAll(async () => {
        await prisma.track.deleteMany({ where: { id: { in: UNSCORED } } });
    });

    it("plays only scored songs no mood claims, every one of them reachable, never an unscored song", async () => {
        expect(unclaimed.size).toBeGreaterThan(LIMIT * 4);
        const seen = new Set<string>();
        for (let k = 0; k < Math.max(5, Math.ceil((unclaimed.size * 4) / 100)); k++) {
            const res = await radio({ type: "mood", value: "wildcard", limit: 100 });
            expect(res.status).toBe(200);
            const ids = (res.body.tracks as RadioTrack[]).map((t) => t.id);
            expect(ids).toHaveLength(Math.min(100, unclaimed.size));
            expect(ids.filter((id) => !unclaimed.has(id))).toEqual([]);
            ids.forEach((id) => seen.add(id));
        }
        expect(seen.size).toBeGreaterThan(unclaimed.size * 0.9);
        expect(UNSCORED.filter((id) => seen.has(id))).toEqual([]);
    });
});

describe("radio: artist weighting", () => {
    const ARTIST = `${PREFIX}art_5`;
    const similarIds = new Set(Array.from({ length: 10 }, (_, i) => `${PREFIX}art_${6 + i}`));

    // The closeness score the route ranks similar tracks by, from the artist's average sound.
    function closeness(t: Row, vibe: { bpm: number; energy: number; valence: number; danceability: number }) {
        if (!t.bpm && !t.energy && !t.valence) return 0.5;
        let score = 0;
        let factors = 0;
        if (t.bpm && vibe.bpm) { score += Math.max(0, 1 - Math.abs(t.bpm - vibe.bpm) / 40); factors++; }
        if (t.energy !== null && vibe.energy) { score += 1 - Math.abs((t.energy || 0) - vibe.energy); factors++; }
        if (t.valence !== null && vibe.valence) { score += 1 - Math.abs((t.valence || 0) - vibe.valence); factors++; }
        if (t.danceability !== null && vibe.danceability) { score += 1 - Math.abs((t.danceability || 0) - vibe.danceability); factors++; }
        return factors > 0 ? score / factors : 0.5;
    }

    it("leans toward similar tracks closer to the artist's sound, yet reaches past the top slice", async () => {
        const own = rows.filter((r) => r.album.artistId === ARTIST);
        const analysed = own.filter((r) => r.bpm || r.energy || r.valence);
        const mean = (f: (r: Row) => number) => analysed.reduce((sum, r) => sum + f(r), 0) / analysed.length;
        const vibe = {
            bpm: mean((r) => r.bpm || 0),
            energy: mean((r) => r.energy || 0),
            valence: mean((r) => r.valence || 0),
            danceability: mean((r) => r.danceability || 0),
        };
        const candidates = rows.filter((r) => playable(r) && similarIds.has(r.album.artistId));
        const scoreOf = new Map(candidates.map((r) => [r.id, closeness(r, vibe)]));
        const meanCandidates = [...scoreOf.values()].reduce((a, b) => a + b, 0) / scoreOf.size;

        const results = await calls({ type: "artist", value: ARTIST, limit: LIMIT }, 40);
        const returned = results.flat().filter((t) => scoreOf.has(t.id)).map((t) => t.id);
        expect(returned.length).toBeGreaterThan(0);
        const meanReturned = returned.reduce((sum, id) => sum + scoreOf.get(id)!, 0) / returned.length;
        expect(meanReturned).toBeGreaterThan(meanCandidates);

        // The old draw used only the 24 closest tracks; the weighted draw goes well past them.
        const closest = new Set(
            [...scoreOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([id]) => id),
        );
        expect(new Set(returned.filter((id) => !closest.has(id))).size).toBeGreaterThan(24);
        for (const tracks of results) expect(tracks).toHaveLength(LIMIT);
    });
});

describe("radio: bad requests", () => {
    it("400 without a type", async () => {
        expect((await radio({})).status).toBe(400);
    });
    it("400 for an unknown mood, including a name every object carries", async () => {
        expect((await radio({ type: "mood", value: "no-such-mood" })).status).toBe(400);
        expect((await radio({ type: "mood", value: "constructor" })).status).toBe(400);
        expect((await radio({ type: "mood" })).status).toBe(400);
    });
    it("400 for the mood values the 10-24 stations replaced", async () => {
        for (const value of ["chill", "dance", "high-energy", "acoustic", "instrumental"]) {
            expect((await radio({ type: "mood", value })).status).toBe(400);
        }
    });
    it("400 for artist radio without an artist", async () => {
        expect((await radio({ type: "artist" })).status).toBe(400);
    });
});

// ---- fallback stages: these change the library, so they run last -------------

describe("radio: discovery falls back to the least-played tracks when fewer than `limit` are unplayed", () => {
    const BIG = 50;
    beforeAll(async () => {
        const unplayed = rows.filter((r) => r.plays === 0).map((r) => r.id);
        // Leave 30 tracks unplayed (fewer than the 50 asked for); everything else unplayed gets one play.
        const giveOne = unplayed.slice(30);
        await prisma.play.createMany({ data: giveOne.map((trackId) => ({ userId: lib.user2, trackId })) });
        for (const id of giveOne) byId.get(id)!.plays = 1;
        rows = [...byId.values()];
    });

    it("returns the limit, only from the tracks with the fewest plays, from across the library", async () => {
        const results = await calls({ type: "discovery", limit: BIG });
        const fewest = rows.filter((r) => playable(r) && r.plays <= 1);
        expect(fewest.length).toBeGreaterThan(BIG * 10);
        for (const tracks of results) {
            expect(tracks).toHaveLength(BIG);
            expect(new Set(tracks.map((t) => t.id)).size).toBe(BIG);
        }
        const ids = results.flat().map((t) => t.id);
        expect(ids.filter((id) => byId.get(id)!.plays > 1)).toEqual([]);
        const span = spanOf(ids, fewest.map((r) => r.id));
        expect(span.distinct).toBeGreaterThan(BIG * 3);
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });
});

describe("radio: favorites with no plays at all returns random tracks", () => {
    beforeAll(async () => {
        await prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });
        for (const r of rows) r.plays = 0;
    });

    it("returns the limit of playable tracks drawn from the whole library", async () => {
        const results = await calls({ type: "favorites", limit: LIMIT });
        for (const tracks of results) {
            expect(tracks).toHaveLength(LIMIT);
            expect(new Set(tracks.map((t) => t.id)).size).toBe(LIMIT);
        }
        const ids = results.flat().map((t) => t.id);
        expect(ids.filter((id) => !playable(byId.get(id)!))).toEqual([]);
        const span = spanOf(ids, rows.filter(playable).map((r) => r.id));
        expect(span.distinct).toBeGreaterThan(LIMIT * 3);
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });
});

describe("radio: genre with an artist whose genres are not a JSON array", () => {
    let odd: string;
    beforeAll(async () => {
        odd = rows.find((r) => artistGenres(r).some((g) => g.toLowerCase().includes("rock")))!.album.artist.id;
        await prisma.artist.update({ where: { id: odd }, data: { genres: "rock", userGenres: { rock: true } } });
    });

    it("leaves that artist out instead of failing the request", async () => {
        const res = await radio({ type: "genre", value: "rock", limit: LIMIT });
        expect(res.status).toBe(200);
        expect(res.body.tracks).toHaveLength(LIMIT);
        expect((res.body.tracks as RadioTrack[]).filter((t) => t.artist.id === odd)).toEqual([]);
    });
});

describe("radio: artist whose genre match meets artists with non-array genres", () => {
    it("falls back to genre matching without failing the request", async () => {
        const target = `${PREFIX}art_40`;
        const other = `${PREFIX}art_41`;
        await prisma.similarArtist.deleteMany({ where: { fromArtistId: target } });
        await prisma.artist.update({ where: { id: target }, data: { genres: ["rock"] } });
        await prisma.artist.update({ where: { id: other }, data: { genres: "rock", userGenres: "not json" } });
        const res = await radio({ type: "artist", value: target, limit: LIMIT });
        expect(res.status).toBe(200);
        expect(res.body.tracks.length).toBeGreaterThan(0);
    });
});

describe("radio: a station whose recipe the library cannot rank", () => {
    afterAll(async () => {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`DELETE FROM mood_state`);
            await buildMoodState(tx);
        });
    });

    it("answers an empty list, not an error", async () => {
        // No spread in the happy scores: the Happy station's recipe cannot rank anyone.
        await prisma.moodState.update({ where: { id: "default" }, data: { happy_sd: 0 } });
        const res = await radio({ type: "mood", value: "happy", limit: LIMIT });
        expect(res.status).toBe(200);
        expect(res.body.tracks).toEqual([]);
        // A station whose recipe does not use happy still plays.
        expect((await radio({ type: "mood", value: "late-night", limit: LIMIT })).body.tracks).toHaveLength(LIMIT);
    });

    it("still fails loudly on any other error", async () => {
        const spy = jest.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connection lost"));
        try {
            expect((await radio({ type: "mood", value: "late-night", limit: LIMIT })).status).toBe(500);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("radio: the mood and workout stations before the mood step has built the library's statistics", () => {
    beforeAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    });

    it.each([...STATIONS.map(([query]) => query), { type: "mood", value: "wildcard" }])("%o answers an empty list", async (query) => {
        const res = await radio({ ...query, limit: LIMIT });
        expect(res.status).toBe(200);
        expect(res.body.tracks).toEqual([]);
    });
});
