/**
 * Mood tags on a real database. A track is tagged with every mood whose score sits at least 1.25 SD above the
 * library's mean for it, z = (score - mean) / SD >= 1.25, with the mean and population SD over the tracks the
 * statistics cover. The scores are written by hand here, so every expected tag is worked out in the comments.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { isWriteConflict } from "../../matching/state";
import { MOODS, MOOD_HEADS, type Mood } from "../heads";
import { parseRecipes, recipeRankingSql } from "../../mixes/recipes";
import { buildMoods, loadMoodState } from "../state";
import { TAG_LINE_Z, writeMoodTags } from "../tags";
import { rerunEnrichment } from "../../enrichmentRestart";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { insertEmbeddings } from "../../../__tests__/helpers/embeddingFixtures";
import { removeMoodRows, untilWaiting } from "../../__tests__/helpers/moodRows";

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.setTimeout(60_000);

const P = "ctag";
const trackId = (n: number) => `${P}t${String(n).padStart(2, "0")}`;
/**
 * happy: mean 0, population SD sqrt((2.25 + 2 * 1.5625 + 2.25 + 1.5625 + 0.5625 + 0.25) / 10) = 1, so z is the score
 * itself: t00 at 1.5 and t01, t02 at exactly 1.25 are on or over the line. sad: t01 at 1.24 and t02 at 1.26 sit
 * either side of it: mean 0, SD 1.00001, z 1.24 and 1.26 (t00 1.49999). Every other mood is 0 everywhere, an SD of 0,
 * and tags no one.
 */
const HAPPY = [1.5, 1.25, 1.25, -1.5, -1.25, -0.75, -0.5, 0, 0, 0];
const SAD = [1.5, 1.24, 1.26, -1.5, -1.25, -0.75, -0.5, 0, 0, 0];
const TAGS_BEFORE: string[][] = [["happy", "sad"], ["happy"], ["happy", "sad"], [], [], [], [], [], [], []];
/** Scored, outside the statistics: a missing file. */
const GONE = `${P}gone`;
/** No sound vector yet, carrying tags of its own. */
const UNSCORED = `${P}unscored`;

async function insertTrack(id: string, extra: Record<string, unknown> = {}) {
    await prisma.track.create({
        data: {
            id, albumId: `${P}alb`, title: `Tag ${id}`, trackNo: 1, duration: 200,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "completed", arousal: 0.5, instrumentalness: 0.5, acousticness: 0.5,
            ...extra,
        },
    });
}

/**
 * Each vector this file writes lies on its own axis, past the first few that other suites search near. A deleted
 * vector stays in the nearest-neighbour index until a vacuum, and many identical ones form a cluster that a later
 * search in this database can start in and never leave, returning nothing.
 */
let nextAxis = 100;

/** A sound vector of the heads' model, and scores for it as if the mood step had computed them. */
async function insertScores(id: string, scores: Partial<Record<Mood, number>>) {
    const axis = nextAxis++;
    await insertEmbeddings(
        [{ trackId: id, vector: `[${Array.from({ length: MOOD_HEADS.dims }, (_, i) => (i === axis ? 1 : 0)).join(",")}]` }],
        { model: MOOD_HEADS.model, clock: "clock_timestamp" },
    );
    const values = MOODS.map((mood) => scores[mood] ?? 0);
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_moods (track_id, embedded_at, weights, ${MOODS.map((m) => `"${m}"`).join(", ")})
         SELECT track_id, analyzed_at, $2, ${values.map((_, i) => `$${i + 3}::real`).join(", ")}
         FROM track_embeddings WHERE track_id = $1`,
        id, MOOD_HEADS.version, ...values,
    );
}

async function seedLibrary(from: number, happy: number[], sad: number[]) {
    for (const [i, h] of happy.entries()) {
        await insertTrack(trackId(from + i));
        await insertScores(trackId(from + i), { happy: h, sad: sad[i] });
    }
}

/** One pass of the mood step, as the enrichment phase runs it. */
async function pass() {
    const built = await buildMoods();
    const tagged = await writeMoodTags();
    return { ...built, tagged };
}

async function tagsOf(ids: string[]): Promise<string[][]> {
    const rows = await prisma.track.findMany({ where: { id: { in: ids } }, select: { id: true, moodTags: true } });
    const byId = new Map(rows.map((r) => [r.id, r.moodTags]));
    return ids.map((id) => byId.get(id) ?? ["<no track>"]);
}

const library = (n: number) => Array.from({ length: n }, (_, i) => trackId(i));

const holdTrack = (tx: Prisma.TransactionClient, id: string) =>
    tx.$executeRawUnsafe(`UPDATE "Track" SET title = title WHERE id = $1`, id);

const cleanup = () => removeMoodRows(P);

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}art`, name: "Tag Artist", identityKey: `${P}-a` } });
    await prisma.album.create({
        data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Tag Album", primaryType: "Album" },
    });
    await seedLibrary(0, HAPPY, SAD);
    await insertTrack(GONE, { missingSince: new Date() });
    await insertScores(GONE, { happy: 5, sad: 5 });
    await insertTrack(UNSCORED, { moodTags: ["energetic", "upbeat", "workout"] });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await closeEngineConnections();
});

describe("mood tags", () => {
    it("tag every mood a track sits at least 1.25 SD above the library's mean in, on the line included", async () => {
        await pass();
        const state = await loadMoodState();
        expect(state?.trackCount).toBe(10);
        expect(state?.moods.happy).toEqual({ mean: 0, sd: 1 });
        expect(state?.moods.sad.mean).toBeCloseTo(0, 6);
        expect(state?.moods.sad.sd).toBeCloseTo(1.00001, 6);
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
    });

    it("leave a track the statistics leave out untagged, tags it already carries included", async () => {
        expect(await tagsOf([GONE, UNSCORED])).toEqual([[], []]);
    });

    it("write nothing on a pass where no track's tags change", async () => {
        expect(await pass()).toEqual({ scored: 0, stateChanged: false, tagged: 0 });
    });

    it("move with the library's statistics", async () => {
        // Two more tracks at happy 3. happy: mean 6/12 = 0.5, SD sqrt(28/12 - 0.25) = 1.4434, so 1.5 falls under the
        // line (z 0.693), so do the 1.25s (z 0.520), and 3 is over (z 1.732). sad: mean 0, SD 0.91288, so t01's 1.24
        // is now over the line (z 1.358), with t00 (1.643) and t02 (1.380).
        await seedLibrary(10, [3, 3], [0, 0]);
        const result = await pass();
        expect(result).toMatchObject({ scored: 0, stateChanged: true });
        expect(await tagsOf(library(12))).toEqual([
            ["sad"], ["sad"], ["sad"], [], [], [], [], [], [], [], ["happy"], ["happy"],
        ]);
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id IN ($1, $2)`, trackId(10), trackId(11));
        expect(await pass()).toMatchObject({ stateChanged: true });
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
    });

    it("skip a pass over the statistics the last pass wrote from, and run once they are rewritten", async () => {
        // Cleared by hand, which nothing in Kima does without changing what the statistics cover: the skipped pass
        // leaves it so, which shows it never read the tracks.
        await prisma.$executeRawUnsafe(`UPDATE "Track" SET "moodTags" = '{}' WHERE id = $1`, trackId(0));
        expect(await pass()).toEqual({ scored: 0, stateChanged: false, tagged: 0 });
        expect(await tagsOf([trackId(0)])).toEqual([[]]);
        await prisma.$executeRawUnsafe(`UPDATE mood_state SET computed_at = now()`);
        expect(await writeMoodTags()).toBe(1);
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
    });

    it("take a song's tags away while it is missing or corrupt, and give them back when it returns", async () => {
        // Without t00, happy: mean -0.167, SD 0.913, so the 1.25s are at z 1.552; sad: mean -0.167, SD 0.913, so t01's
        // 1.24 is at z 1.541 and t02's 1.26 at 1.563.
        const without = [[], ["happy", "sad"], ["happy", "sad"], [], [], [], [], [], [], []];
        for (const change of [{ missingSince: new Date() }, { corrupt: true }]) {
            await prisma.track.update({ where: { id: trackId(0) }, data: change });
            expect(await pass()).toMatchObject({ scored: 0, stateChanged: true });
            expect(await tagsOf(library(10))).toEqual(without);
            await prisma.track.update({ where: { id: trackId(0) }, data: { missingSince: null, corrupt: false } });
            expect(await pass()).toMatchObject({ scored: 0, stateChanged: true });
            expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
        }
    });

    it("stay while the statistics are of other weights or cleared, and move when statistics return", async () => {
        // Statistics a rewrite would tag no one by.
        await prisma.$executeRawUnsafe(`UPDATE mood_state SET version = 'other weights', happy_mean = 100, sad_mean = 100`);
        expect(await writeMoodTags()).toBe(0);
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);

        // Cleared, as a rescore clears them, while the library grows by the two tracks of the test above.
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await seedLibrary(10, [3, 3], [0, 0]);
        expect(await writeMoodTags()).toBe(0);
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);

        expect(await pass()).toMatchObject({ scored: 0, stateChanged: true });
        expect(await tagsOf(library(12))).toEqual([
            ["sad"], ["sad"], ["sad"], [], [], [], [], [], [], [], ["happy"], ["happy"],
        ]);
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id IN ($1, $2)`, trackId(10), trackId(11));
        expect(await pass()).toMatchObject({ stateChanged: true });
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
    });
});

describe("a deadlock while the tags are written", () => {
    it("writes nothing and returns 0, and the next pass writes the tags", async () => {
        await prisma.$executeRawUnsafe(`UPDATE "Track" SET "moodTags" = '{}' WHERE id = $1`, trackId(0));
        // A rewritten statistics row, so the pass runs instead of being skipped.
        await prisma.$executeRawUnsafe(`UPDATE mood_state SET computed_at = now()`);
        let writing: Promise<number> | undefined;
        // Holds a track the tags need, then takes the state row the tag writer holds: each waits on the other.
        await prisma.$transaction(
            async (tx) => {
                await holdTrack(tx, trackId(0));
                writing = writeMoodTags();
                await untilWaiting(`SET "moodTags" = n.tags`);
                await tx.$queryRawUnsafe(`SELECT id FROM mood_state WHERE id = 'default' FOR UPDATE`);
            },
            { timeout: 30_000, maxWait: 30_000 },
        );
        // The tag writer waited first, so Postgres's deadlock check ends its transaction rather than this one.
        expect(await writing).toBe(0);
        expect(await tagsOf([trackId(0)])).toEqual([[]]);

        expect(await writeMoodTags()).toBe(1);
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
    });

    it("is reported by Prisma for a raw statement in a shape isWriteConflict recognises", async () => {
        // Two transactions each hold one track and then ask for the other's.
        let refused: Promise<unknown> | undefined;
        await prisma.$transaction(
            async (tx) => {
                await holdTrack(tx, trackId(1));
                refused = prisma
                    .$transaction(
                        async (tx2) => {
                            await holdTrack(tx2, trackId(2));
                            await tx2.$executeRawUnsafe(`UPDATE "Track" SET title = title || '' WHERE id = $1`, trackId(1));
                        },
                        { timeout: 30_000, maxWait: 30_000 },
                    )
                    .then(() => null, (error: unknown) => error);
                await untilWaiting(`SET title = title || ''`);
                await holdTrack(tx, trackId(2));
            },
            { timeout: 30_000, maxWait: 30_000 },
        );
        // The second waited first, so the deadlock check ends it.
        const error = await refused;
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect(error).toMatchObject({ code: "P2010", meta: { code: "40P01" } });
        expect(isWriteConflict(error)).toBe(true);
    });
});

describe("an analysis re-run", () => {
    it("clears the tags, keeps them empty while the analysis is redone, and the mood step refills them", async () => {
        await rerunEnrichment("analysis");
        expect(await tagsOf(library(10))).toEqual(library(10).map(() => []));

        // The analysis is pending, the sound vectors and the statistics are gone, so a pass writes no tags.
        expect(await pass()).toEqual({ scored: 0, stateChanged: false, tagged: 0 });
        expect(await loadMoodState()).toBeNull();
        expect(await tagsOf(library(10))).toEqual(library(10).map(() => []));

        // Both analyzers answer again with the same readings and vectors.
        await prisma.track.updateMany({
            where: { id: { startsWith: `${P}t` } },
            data: { analysisStatus: "completed", arousal: 0.5, instrumentalness: 0.5, acousticness: 0.5 },
        });
        for (const [i, id] of library(10).entries()) await insertScores(id, { happy: HAPPY[i], sad: SAD[i] });

        expect(await pass()).toEqual({ scored: 0, stateChanged: true, tagged: 3 });
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
    });
});

describe("the tags of a defined mood", () => {
    const dId = (n: number) => `${P}d${String(n).padStart(2, "0")}`;

    interface Song {
        focus: number;
        calm: number;
        driving: number;
        night?: number;
        instrumentalness: number | null;
        arousal: number;
        bpm: number | null;
        bpmConfidence: number | null;
    }

    /** Fourteen songs from a fixed generator, so the spread is varied and the test repeats exactly. */
    function songs(): Song[] {
        let seed = 7;
        const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const list: Song[] = Array.from({ length: 14 }, () => ({
            focus: next() * 2 - 1,
            calm: next() * 2 - 1,
            driving: next() * 2 - 1,
            instrumentalness: 0.05 + next() * 0.9,
            arousal: 0.1 + next() * 0.8,
            bpm: 60 + next() * 120,
            bpmConfidence: 2 + next() * 2,
        }));
        // d00 stands out on every focus part and is a steady 100 BPM song that drives; d01 has the same focus parts but
        // no instrumental reading; d02 has no tempo; d03 an unsteady beat; d04 is 65 BPM, which counts as 130 (double).
        Object.assign(list[0], { focus: 2.5, calm: 2, instrumentalness: 0.97, arousal: 0.2 });
        Object.assign(list[1], { focus: 2.5, calm: 2, instrumentalness: null });
        Object.assign(list[2], { bpm: null, bpmConfidence: null, driving: 2.5 });
        Object.assign(list[3], { bpmConfidence: 1.2, bpm: 110, driving: 2.5 });
        Object.assign(list[4], { bpm: 65, bpmConfidence: 3, driving: 2.5, instrumentalness: 0.08, arousal: 0.85 });
        Object.assign(list[5], { night: 4 });
        return list;
    }

    // ---- the definitions, worked out again here from the weights in mixes/moodDefinitions.json ----------------------

    const logit = (p: number) => {
        const c = Math.min(0.99, Math.max(0.01, p));
        return Math.log(c / (1 - c));
    };
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
    /** z-scores of `values` against their own mean and SD over the entries that are not null; null stays null. */
    const zs = (values: Array<number | null>): Array<number | null> => {
        const present = values.filter((v): v is number => v !== null);
        return values.map((v) => (v === null ? null : (v - mean(present)) / sd(present)));
    };
    /** The pace value: 1 inside 94-130 BPM (double or half counts) on a steady beat (confidence 2 or more), 0 outside. */
    const pace = (s: Song) => {
        if (s.bpm === null || s.bpmConfidence === null || s.bpmConfidence < 2) return 0.5;
        const inBand = (x: number) => x >= 94 && x <= 130;
        return inBand(s.bpm) || inBand(s.bpm * 2) || inBand(s.bpm / 2) ? 1 : 0;
    };
    /** Song indexes at or over the tag line for a defined score; a null score is never tagged. */
    const tagged = (defined: Array<number | null>) => {
        const z = zs(defined);
        return z.flatMap((v, i) => (v !== null && v >= TAG_LINE_Z ? [i] : []));
    };

    function expectedFocus(list: Song[]): number[] {
        const instrumental = zs(list.map((s) => (s.instrumentalness === null ? null : logit(s.instrumentalness))));
        const calm = zs(list.map((s) => s.calm));
        const head = zs(list.map((s) => s.focus));
        return tagged(list.map((_, i) => (instrumental[i] === null ? null : 0.5 * instrumental[i]! + 0.3 * calm[i]! + 0.2 * head[i]!)));
    }

    function expectedDriving(list: Song[]): number[] {
        const arousal = zs(list.map((s) => logit(s.arousal)));
        const instrumental = zs(list.map((s) => (s.instrumentalness === null ? null : logit(s.instrumentalness))));
        const paces = zs(list.map(pace));
        const head = zs(list.map((s) => s.driving));
        return tagged(
            list.map((_, i) =>
                instrumental[i] === null ? null : 0.35 * arousal[i]! - 0.25 * instrumental[i]! + 0.25 * paces[i]! + 0.15 * head[i]!,
            ),
        );
    }

    let list: Song[] = [];
    const ids = () => list.map((_, i) => dId(i));
    const tagsWith = async (mood: string) =>
        (await tagsOf(ids())).flatMap((tags, i) => (tags.includes(mood) ? [i] : []));

    beforeAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings`);
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
        list = songs();
        for (const [i, s] of list.entries()) {
            await insertTrack(dId(i), {
                instrumentalness: s.instrumentalness, arousal: s.arousal, bpm: s.bpm, bpmConfidence: s.bpmConfidence,
            });
            await insertScores(dId(i), { focus: s.focus, calm: s.calm, driving: s.driving, night: s.night ?? 0 });
        }
        await pass();
    });

    it("tags focus where its definition (instrumental, calm, the focus head) puts a song at the line", async () => {
        const want = expectedFocus(list);
        expect(want.length).toBeGreaterThan(0);
        expect(want.length).toBeLessThan(list.length);
        expect(want).toContain(0);
        expect(await tagsWith("focus")).toEqual(want);
    });

    it("leaves a song without the instrumental reading untagged for focus, though its focus head is the highest", async () => {
        expect(list[1].focus).toBe(2.5);
        expect(await tagsWith("focus")).not.toContain(1);
    });

    it("tags driving by its definition, a song with no tempo or an unsteady beat judged at the neutral pace", async () => {
        const want = expectedDriving(list);
        expect(want.length).toBeGreaterThan(0);
        expect(want.length).toBeLessThan(list.length);
        expect(await tagsWith("driving")).toEqual(want);
        expect(pace(list[2])).toBe(0.5);
        expect(pace(list[3])).toBe(0.5);
        expect(pace(list[4])).toBe(1);
    });

    it("tags the same songs a recipe of just that mood ranks at the line: tags and recipes read one score", async () => {
        const state = (await loadMoodState())!;
        for (const mood of ["focus", "driving"] as const) {
            const recipe = parseRecipes({ only: { name: "Only", components: { [mood]: 1 } } }).get("only")!;
            const ranked = await prisma.$queryRaw<Array<{ id: string; recipe_z: number }>>`
                WITH ${recipeRankingSql(recipe, state)} SELECT id, recipe_z FROM ranked
                WHERE id LIKE ${`${P}d%`} ORDER BY id
            `;
            const atLine = ranked.filter((r) => r.recipe_z >= TAG_LINE_Z).map((r) => ids().indexOf(r.id));
            expect(atLine.length).toBeGreaterThan(0);
            expect(await tagsWith(mood)).toEqual(atLine);
        }
    });

    it("has no night tag, though a song scores 4 on it, and no song of this library carries it", async () => {
        expect(list[5].night).toBe(4);
        for (const tags of await tagsOf(ids())) expect(tags).not.toContain("night");
    });

    it("re-tags when only a tempo changes: the fingerprint covers it", async () => {
        const before = await tagsWith("driving");
        expect(before.length).toBeGreaterThan(0);
        // d02 becomes a steady 100 BPM song and d04 a steady 40 BPM one (80 doubled is out of the band, 20 halved too).
        await prisma.track.update({ where: { id: dId(4) }, data: { bpm: 40 } });
        await prisma.track.update({ where: { id: dId(2) }, data: { bpm: 100, bpmConfidence: 3 } });
        const result = await pass();
        expect(result.stateChanged).toBe(true);
        list[4].bpm = 40;
        Object.assign(list[2], { bpm: 100, bpmConfidence: 3 });
        expect(await tagsWith("driving")).toEqual(expectedDriving(list));
    });

    it("tags no song while the library holds fewer than 8 scored songs", async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings`);
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}d%'`);
        list = songs().slice(0, 6);
        for (const [i, s] of list.entries()) {
            await insertTrack(dId(i), { instrumentalness: s.instrumentalness, arousal: s.arousal, bpm: s.bpm, bpmConfidence: s.bpmConfidence });
            await insertScores(dId(i), { focus: s.focus, calm: s.calm, driving: s.driving, happy: i === 5 ? 3 : 0 });
        }
        await pass();
        expect(await tagsWith("focus")).toEqual([]);
        expect(await tagsWith("driving")).toEqual([]);
        expect(await tagsOf([dId(5)])).toEqual([["happy"]]);
    });
});
