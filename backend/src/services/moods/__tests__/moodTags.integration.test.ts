/**
 * Mood tags on a real database. A track is tagged with every mood whose score sits at least 1.0 SD above the
 * library's mean for it, z = (score - mean) / SD >= 1.0, with the mean and population SD over the tracks the
 * statistics cover. The scores are written by hand here, so every expected tag is worked out in the comments.
 */
import { prisma } from "../../../utils/db";
import { MOODS, MOOD_HEADS, type Mood } from "../heads";
import { buildMoods, loadMoodState, writeMoodTags } from "../state";
import { rerunEnrichment } from "../../enrichmentRestart";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.setTimeout(60_000);

const P = "ctag";
const trackId = (n: number) => `${P}t${String(n).padStart(2, "0")}`;
/**
 * happy: mean 0, population SD sqrt((4 + 6 * 1) / 10) = 1, so z is the score itself: t00 at 2 and t01, t02 at
 * exactly 1.0 are on or over the line. sad: t01 at 0.99 and t02 at 1 sit either side of it: mean -0.001,
 * SD 0.99900, z 0.992 and 1.002. Every other mood is 0 everywhere, an SD of 0, and tags no one.
 */
const HAPPY = [2, 1, 1, -1, -1, -1, -1, 0, 0, 0];
const SAD = [2, 0.99, 1, -1, -1, -1, -1, 0, 0, 0];
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

/** A sound vector of the heads' model, and scores for it as if the mood step had computed them. */
async function insertScores(id: string, scores: Partial<Record<Mood, number>>) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, $3, clock_timestamp())`,
        id, `[${Array.from({ length: MOOD_HEADS.dims }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`, MOOD_HEADS.model,
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
    it("tag every mood a track sits at least 1.0 SD above the library's mean in, on the line included", async () => {
        await pass();
        const state = await loadMoodState();
        expect(state?.trackCount).toBe(10);
        expect(state?.moods.happy).toEqual({ mean: 0, sd: 1 });
        expect(state?.moods.sad.mean).toBeCloseTo(-0.001, 6);
        expect(state?.moods.sad.sd).toBeCloseTo(0.999004, 6);
        expect(await tagsOf(library(10))).toEqual(TAGS_BEFORE);
    });

    it("leave a track the statistics leave out untagged, the old analyzer's tags included", async () => {
        expect(await tagsOf([GONE, UNSCORED])).toEqual([[], []]);
    });

    it("write nothing on a pass where no track's tags change", async () => {
        expect(await pass()).toEqual({ scored: 0, stateChanged: false, tagged: 0 });
    });

    it("move with the library's statistics", async () => {
        // Two more tracks at happy 3. happy: mean 6/12 = 0.5, SD sqrt(28/12 - 0.25) = 1.4434, so 2 stays over the
        // line (z 1.039), 1 falls under it (z 0.346), and 3 is over (z 1.732). sad: mean -0.00083, SD 0.91196, so
        // t01's 0.99 is now over the line (z 1.086).
        await seedLibrary(10, [3, 3], [0, 0]);
        const result = await pass();
        expect(result).toMatchObject({ scored: 0, stateChanged: true });
        expect(await tagsOf(library(12))).toEqual([
            ["happy", "sad"], ["sad"], ["sad"], [], [], [], [], [], [], [], ["happy"], ["happy"],
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
});

describe("an analysis re-run", () => {
    it("clears the tags, keeps them empty while the analysis is redone, and the mood step refills them", async () => {
        await rerunEnrichment("analysis");
        expect(await tagsOf(library(10))).toEqual(library(10).map(() => []));

        // The analysis is pending and the sound vectors are gone, so a pass finds nothing to tag.
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
