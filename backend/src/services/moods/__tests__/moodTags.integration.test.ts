/**
 * Mood tags on a real database. A track is tagged with every mood whose score sits at least 1.25 SD above the
 * library's mean for it, z = (score - mean) / SD >= 1.25, with the mean and population SD over the tracks the
 * statistics cover. The scores are written by hand here, so every expected tag is worked out in the comments.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { isWriteConflict } from "../../matching/state";
import { MOODS, MOOD_HEADS, type Mood } from "../heads";
import { getRecipe, recipeRankingSql } from "../../mixes/recipes";
import { buildMoods, loadMoodState } from "../state";
import { TAG_LINE_Z, writeMoodTags } from "../tags";
import { rerunEnrichment } from "../../enrichmentRestart";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

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
/** No sound vector yet, carrying the old analyzer's tags. */
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
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, $3, clock_timestamp())`,
        id, `[${Array.from({ length: MOOD_HEADS.dims }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`, MOOD_HEADS.model,
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

/**
 * Until a statement containing `fragment` waits on a lock. Watched from outside any transaction, which would see one
 * snapshot of the activity throughout; given up well inside a transaction's timeout, so a statement that never waits
 * fails the test.
 */
async function untilWaiting(fragment: string) {
    const giveUp = Date.now() + 20_000;
    for (;;) {
        if (Date.now() > giveUp) throw new Error(`No statement with ${fragment} waited on a lock`);
        const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND position($1 IN query) > 0`,
            fragment,
        );
        if (n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const holdTrack = (tx: Prisma.TransactionClient, id: string) =>
    tx.$executeRawUnsafe(`UPDATE "Track" SET title = title WHERE id = $1`, id);

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

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

    it("leave a track the statistics leave out untagged, the old analyzer's tags included", async () => {
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

    it("refill tags cleared while the statistics stayed the same", async () => {
        await prisma.$executeRawUnsafe(`UPDATE "Track" SET "moodTags" = '{}' WHERE id LIKE '${P}%'`);
        expect(await pass()).toEqual({ scored: 0, stateChanged: false, tagged: 3 });
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
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

describe("the focus tag", () => {
    const focusId = (n: number) => `${P}f${String(n).padStart(2, "0")}`;
    /**
     * Focus scores and CLAP instrumental readings. Focus: mean 0.16667, SD 1.00857 over all twelve. Instrumental, as
     * the clipped logit: mean -0.78252, SD 2.28963 over the eleven with a reading. The Focus Mix recipe score is
     * (z_focus + 1.25 z_instrumental) / 2.25 over the eleven it ranks (mean -0.07344, SD 0.67807), standardised again:
     *   f00 vocal, focus 2.0:            focus z 1.818 (over the line alone), recipe z 0.187: no focus tag
     *   f01 instrumental, focus 0.6:     focus z 0.430 (under the line alone), recipe z 2.063: focus tag
     *   f02 no instrumental, focus 2.0:  focus z 1.818, not ranked by the recipe: no focus tag
     *   f03 instrumental, focus 1.0:     focus z 0.826, recipe z 1.984: focus tag
     *   the rest:                        recipe z under 0
     * f00 is also at workout 3 and f04 at happy 3, z 3.317 each; every other score is 0.
     */
    const FOCUS = [2.0, 0.6, 2.0, 1.0, 0.0, -0.5, 0.2, -1.0, -0.8, 0.0, -0.5, -1.0];
    const INSTRUMENTAL = [0.02, 0.98, null, 0.95, 0.1, 0.3, 0.05, 0.2, 0.6, 0.15, 0.08, 0.4];
    const songs = FOCUS.map((_, n) => focusId(n));

    beforeAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings`);
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
        for (const [n, id] of songs.entries()) {
            await insertTrack(id, { instrumentalness: INSTRUMENTAL[n] });
            await insertScores(id, { focus: FOCUS[n], workout: n === 0 ? 3 : 0, happy: n === 4 ? 3 : 0 });
        }
        await pass();
    });

    it("leaves out a vocal song the focus score alone puts over the line, and keeps its other tags", async () => {
        expect(await tagsOf([focusId(0)])).toEqual([["workout"]]);
    });

    it("tags an instrumental song with a moderate focus score", async () => {
        expect(await tagsOf([focusId(1), focusId(3)])).toEqual([["focus"], ["focus"]]);
    });

    it("leaves out a song without the instrumental reading", async () => {
        expect(await tagsOf([focusId(2)])).toEqual([[]]);
    });

    it("tags every other mood from its own score", async () => {
        expect(await tagsOf(songs)).toEqual([
            ["workout"], ["focus"], [], ["focus"], ["happy"], [], [], [], [], [], [], [],
        ]);
    });

    it("tags the songs the Focus Mix recipe ranks at the line, by the engine's own score", async () => {
        const ranking = recipeRankingSql(getRecipe("focus"), (await loadMoodState())!);
        const ranked = await prisma.$queryRaw<Array<{ id: string; recipe_z: number }>>`
            WITH ${ranking} SELECT id, recipe_z FROM ranked ORDER BY id
        `;
        const z = new Map(ranked.map((r) => [r.id, r.recipe_z]));
        expect(z.has(focusId(2))).toBe(false);
        expect(z.get(focusId(0))).toBeCloseTo(0.187, 3);
        expect(z.get(focusId(1))).toBeCloseTo(2.063, 3);
        expect(z.get(focusId(3))).toBeCloseTo(1.984, 3);
        const tagged = (await prisma.track.findMany({
            where: { id: { in: songs }, moodTags: { has: "focus" } }, select: { id: true }, orderBy: { id: "asc" },
        })).map((t) => t.id);
        expect(tagged).toEqual(ranked.filter((r) => r.recipe_z >= TAG_LINE_Z).map((r) => r.id));
    });

    it("tags no song with focus when the library has no instrumental spread, and keeps the other tags", async () => {
        await prisma.track.updateMany({
            where: { id: { in: songs }, instrumentalness: { not: null } },
            data: { instrumentalness: 0.5 },
        });
        expect(await pass()).toMatchObject({ stateChanged: true, tagged: 2 });
        expect(await tagsOf(songs)).toEqual([["workout"], [], [], [], ["happy"], [], [], [], [], [], [], []]);
    });
});
