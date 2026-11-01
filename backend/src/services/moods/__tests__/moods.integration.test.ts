/**
 * The mood step on a real database, checked against the arithmetic done in TypeScript from what the database holds:
 * each stored score against the folded dot product in float64 and against the shipped models before folding, which
 * rows are recomputed and which are left alone, the cascade from the sound vector, the library statistics, and the
 * progress count.
 */
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import { parseEmbedding } from "../../../utils/embedding";
import { RECIPES, UnrankableLibraryError, getRecipe } from "../../mixes/recipes";
import { pickStationTracks } from "../../../__tests__/helpers/stationPicks";
import { seededRandom } from "../../matching/mapLayout";
import { gaussian as sharedGaussian } from "../../../__tests__/fixtures/gaussian";
import { refreshMoodSnapshot } from "../../moodBucketService";
import { MOODS, MOOD_HEADS, type Mood } from "../heads";
import { READINGS, buildMoodState, buildMoods, loadMoodState, moodProgress, updateMoods, type Reading } from "../state";
import { writeMoodTags } from "../tags";
import * as inputsHash from "../inputsHash";
import { insertEmbeddings, vectorLiteral } from "../../../__tests__/helpers/embeddingFixtures";
import { removeMoodRows, untilWaiting } from "../../__tests__/helpers/moodRows";
import reference from "./fixtures/shipped-reference.json";

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.setTimeout(60_000);

const P = "cmood";
const ARTIST = `${P}art`;
const ALBUM = `${P}alb`;
const LIBRARY = 12;
const trackId = (n: number) => `${P}t${String(n).padStart(2, "0")}`;
/** A vector of another sound model: never scored. */
const OTHER_MODEL = `${P}other`;
/** Scored, but outside the statistics: a missing file, a corrupt file, unfinished analysis. */
const GONE = `${P}gone`;
const CORRUPT = `${P}corrupt`;
const UNANALYSED = `${P}unanalysed`;
/** In the statistics, but without CLAP's instrumental reading. */
const NO_INSTRUMENTAL = `${P}noinstr`;
const fixtureId = (n: number) => `${P}fix${n}`;

const rand = seededRandom(20261023);
const gaussian = () => sharedGaussian(rand);
/** A unit vector scaled a little off unit length, as the writer allows, or far off to show the scaling. */
const vector = (scale = 1) => {
    const v = Array.from({ length: 512 }, gaussian);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => (scale * x) / norm);
};

async function insertTrack(id: string, extra: Record<string, unknown> = {}) {
    await prisma.track.create({
        data: {
            id, albumId: ALBUM, title: `Mood ${id}`, trackNo: 1, duration: 200,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "completed", arousal: rand(), instrumentalness: rand(), acousticness: rand(),
            ...extra,
        },
    });
}

async function insertVector(id: string, values: number[], model = MOOD_HEADS.model) {
    await insertEmbeddings([{ trackId: id, vector: vectorLiteral(values) }], { model, clock: "clock_timestamp", replace: true });
}

/** The counts below are exact, so no sound vector from another file may be left in this worker's database. */
const cleanup = () => removeMoodRows(P);

async function seed() {
    await prisma.artist.create({ data: { id: ARTIST, name: "Mood Artist", identityKey: `${P}-a` } });
    await prisma.album.create({
        data: { id: ALBUM, artistId: ARTIST, rgMbid: `${P}-rg`, title: "Mood Album", primaryType: "Album" },
    });
    for (let n = 0; n < LIBRARY; n++) {
        await insertTrack(trackId(n));
        // Most within the writer's tolerance of unit length, two far off it.
        await insertVector(trackId(n), vector(n < 2 ? 3 + n : 1 + (rand() - 0.5) * 2e-3));
    }
    // Readings at and past the clip, so the logits' clipping is exercised.
    await prisma.track.update({ where: { id: trackId(0) }, data: { instrumentalness: 0, acousticness: 1, arousal: 1 } });
    await prisma.track.update({
        where: { id: trackId(1) },
        data: { instrumentalness: 0.995, acousticness: 0.005, arousal: 0.004 },
    });
    await insertTrack(OTHER_MODEL);
    await insertVector(OTHER_MODEL, vector(), "laion-clap-music");
    await insertTrack(GONE, { missingSince: new Date() });
    await insertVector(GONE, vector());
    await insertTrack(CORRUPT, { corrupt: true });
    await insertVector(CORRUPT, vector());
    await insertTrack(UNANALYSED, { analysisStatus: "pending" });
    await insertVector(UNANALYSED, vector());
    await insertTrack(NO_INSTRUMENTAL, { instrumentalness: null });
    await insertVector(NO_INSTRUMENTAL, vector());
    for (const [n, values] of reference.vectors.entries()) {
        await insertTrack(fixtureId(n));
        await insertVector(fixtureId(n), values);
    }
}

const SCORED = LIBRARY + 4 + reference.vectors.length;
const ELIGIBLE = LIBRARY + 1 + reference.vectors.length;

type StoredRow = { id: string; embedding: string; weights: string } & Record<Mood, number>;

async function stored(): Promise<Map<string, StoredRow>> {
    const rows = await prisma.$queryRawUnsafe<StoredRow[]>(`
        SELECT m.track_id AS id, te.embedding::text AS embedding, m.weights, ${MOODS.map((mood) => `m."${mood}"`).join(", ")}
        FROM track_moods m JOIN track_embeddings te ON te.track_id = m.track_id
        ORDER BY m.track_id
    `);
    return new Map(rows.map((r) => [r.id, r]));
}

/** Each row's transaction id: a row rewritten by an update gets a new one. */
async function versions(): Promise<Map<string, string>> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; xmin: string }>>(
        `SELECT track_id AS id, xmin::text AS xmin FROM track_moods`,
    );
    return new Map(rows.map((r) => [r.id, r.xmin]));
}

/** The folded weights applied in float64 to the stored single-precision vector, scaled to unit length. */
function score(embedding: string, mood: Mood): number {
    const x = parseEmbedding(embedding);
    const norm = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
    const { weights, bias } = MOOD_HEADS.heads[mood];
    return x.reduce((s, v, i) => s + v * weights[i], 0) / norm + bias;
}

function maxScoreError(rows: Iterable<StoredRow>): number {
    let worst = 0;
    for (const row of rows) for (const mood of MOODS) worst = Math.max(worst, Math.abs(row[mood] - score(row.embedding, mood)));
    return worst;
}

beforeAll(async () => {
    await cleanup();
    await seed();
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("the mood step", () => {
    it("scores every sound vector of the heads' model, each to 1e-4 of the folded dot product in float64", async () => {
        expect(await buildMoods()).toEqual({ scored: SCORED, stateChanged: true });
        const rows = await stored();
        expect(rows.size).toBe(SCORED);
        expect(rows.has(OTHER_MODEL)).toBe(false);
        for (const row of rows.values()) expect(row.weights).toBe(MOOD_HEADS.version);
        expect(maxScoreError(rows.values())).toBeLessThan(1e-4);
    });

    it("matches the shipped models before folding, computed in NumPy, to 1e-4", async () => {
        expect(reference.version).toBe(MOOD_HEADS.version);
        const rows = await stored();
        let worst = 0;
        for (const n of reference.vectors.keys()) {
            const row = rows.get(fixtureId(n))!;
            for (const mood of MOODS) {
                worst = Math.max(worst, Math.abs(row[mood] - (reference.scores as Record<Mood, number[]>)[mood][n]));
            }
        }
        expect(worst).toBeLessThan(1e-4);
    });

    it("leaves current rows alone on the next pass", async () => {
        const before = await versions();
        expect(await buildMoods()).toEqual({ scored: 0, stateChanged: false });
        expect(await versions()).toEqual(before);
    });

    it("rescores only a vector analysed again", async () => {
        const before = await versions();
        await insertVector(trackId(3), vector());
        expect(await buildMoods()).toEqual({ scored: 1, stateChanged: true });
        const after = await versions();
        for (const [id, xmin] of before) {
            if (id === trackId(3)) expect(after.get(id)).not.toBe(xmin);
            else expect(after.get(id)).toBe(xmin);
        }
        expect(maxScoreError([(await stored()).get(trackId(3))!])).toBeLessThan(1e-4);
    });

    it("rescores rows from other weights, and only those", async () => {
        await prisma.$executeRawUnsafe(
            `UPDATE track_moods SET weights = 'older', happy = 99 WHERE track_id IN ($1, $2)`, trackId(4), trackId(5),
        );
        const before = await versions();
        expect(await prisma.$transaction((tx) => updateMoods(tx))).toBe(2);
        const after = await versions();
        for (const [id, xmin] of before) {
            if (id === trackId(4) || id === trackId(5)) expect(after.get(id)).not.toBe(xmin);
            else expect(after.get(id)).toBe(xmin);
        }
        const rows = await stored();
        expect(rows.get(trackId(4))!.weights).toBe(MOOD_HEADS.version);
        expect(maxScoreError([rows.get(trackId(4))!, rows.get(trackId(5))!])).toBeLessThan(1e-4);
    });

    it("rescores every row when the weights change", async () => {
        await prisma.$executeRawUnsafe(`UPDATE track_moods SET weights = 'older'`);
        const { scored } = await buildMoods();
        expect(scored).toBe(SCORED);
    });

    it("loses a track's scores with its sound vector", async () => {
        const doomed = `${P}doomed`;
        await insertTrack(doomed, { missingSince: new Date() });
        await insertVector(doomed, vector());
        await buildMoods();
        expect((await stored()).has(doomed)).toBe(true);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id = $1`, doomed);
        expect((await stored()).has(doomed)).toBe(false);
        await prisma.track.delete({ where: { id: doomed } });
    });
});

describe("the library statistics", () => {
    /** Every statistic computed in TypeScript from the stored values, over the tracks the step says are eligible. */
    async function direct() {
        const rows = await prisma.$queryRawUnsafe<
            Array<Record<Mood, number> & { arousal: number | null; instrumentalness: number | null; acousticness: number | null }>
        >(`
            SELECT ${MOODS.map((mood) => `m."${mood}"`).join(", ")}, t.arousal, t.instrumentalness, t.acousticness
            FROM track_moods m JOIN "Track" t ON t.id = m.track_id
            WHERE t."missingSince" IS NULL AND t.corrupt = false AND t."analysisStatus" = 'completed'
        `);
        const logit = (p: number) => {
            const c = Math.min(0.99, Math.max(0.01, p));
            return Math.log(c / (1 - c));
        };
        const stats = (values: number[]) => {
            const mean = values.reduce((s, v) => s + v, 0) / values.length;
            return { mean, sd: Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length), n: values.length };
        };
        const present = (values: Array<number | null>) => values.filter((v): v is number => v !== null);
        return {
            n: rows.length,
            moods: Object.fromEntries(MOODS.map((mood) => [mood, stats(rows.map((r) => Math.fround(r[mood])))])),
            readings: {
                arousal: stats(present(rows.map((r) => r.arousal)).map(logit)),
                instrumental_logit: stats(present(rows.map((r) => r.instrumentalness)).map(logit)),
                acoustic_logit: stats(present(rows.map((r) => r.acousticness)).map(logit)),
            } as Record<Reading, { mean: number; sd: number; n: number }>,
        };
    }

    it("hold each mood's and reading's mean and population SD over the eligible tracks", async () => {
        await prisma.$transaction((tx) => buildMoodState(tx));
        const state = (await loadMoodState())!;
        const expected = await direct();
        expect(expected.n).toBe(ELIGIBLE);
        expect(state.trackCount).toBe(ELIGIBLE);
        for (const mood of MOODS) {
            expect(state.moods[mood].mean).toBeCloseTo(expected.moods[mood].mean, 9);
            expect(state.moods[mood].sd).toBeCloseTo(expected.moods[mood].sd, 9);
            expect(state.moods[mood].sd).toBeGreaterThan(0);
        }
        for (const reading of READINGS) {
            expect(state.readings[reading]!.mean).toBeCloseTo(expected.readings[reading].mean, 9);
            expect(state.readings[reading]!.sd).toBeCloseTo(expected.readings[reading].sd, 9);
        }
        // The track without an instrumental reading counts for every other statistic.
        expect(expected.readings.instrumental_logit.n).toBe(ELIGIBLE - 1);
        expect(expected.readings.acoustic_logit.n).toBe(ELIGIBLE);
    });

    it("rebuild when an eligible track's reading changes, without rescoring", async () => {
        await prisma.track.update({ where: { id: trackId(6) }, data: { arousal: 0.987 } });
        expect(await buildMoods()).toEqual({ scored: 0, stateChanged: true });
        expect((await loadMoodState())!.readings.arousal!.mean).toBeCloseTo((await direct()).readings.arousal.mean, 9);
    });

    it("stay when only a track outside them changes", async () => {
        await prisma.track.update({ where: { id: GONE }, data: { arousal: 0.123 } });
        expect(await buildMoods()).toEqual({ scored: 0, stateChanged: false });
    });

    it("rebuild when a track leaves them", async () => {
        await prisma.track.update({ where: { id: trackId(7) }, data: { corrupt: true } });
        expect(await buildMoods()).toEqual({ scored: 0, stateChanged: true });
        expect((await loadMoodState())!.trackCount).toBe(ELIGIBLE - 1);
        await prisma.track.update({ where: { id: trackId(7) }, data: { corrupt: false } });
        expect(await buildMoods()).toEqual({ scored: 0, stateChanged: true });
    });

    it("an unchanged library does not run the full hash, and a changed one still does", async () => {
        await buildMoods();
        const hash = jest.spyOn(inputsHash, "hashInputs");
        try {
            expect(await buildMoods()).toEqual({ scored: 0, stateChanged: false });
            expect(await buildMoods()).toEqual({ scored: 0, stateChanged: false });
            expect(hash).not.toHaveBeenCalled();

            // An analysis write moves the signal: the hash runs and the new reading reaches the statistics.
            await prisma.track.update({ where: { id: trackId(5) }, data: { arousal: 0.321, analyzedAt: new Date() } });
            expect(await buildMoods()).toEqual({ scored: 0, stateChanged: true });
            expect(hash).toHaveBeenCalledTimes(1);

            // And once hashed, the next unchanged pass skips it again.
            expect(await buildMoods()).toEqual({ scored: 0, stateChanged: false });
            expect(hash).toHaveBeenCalledTimes(1);
        } finally {
            hash.mockRestore();
        }
    });

    it("two albums swapping places between Discover and the library moves the signal", async () => {
        const [inLib, inDiscover] = [`${P}-swap-a`, `${P}-swap-b`];
        await prisma.album.create({ data: { id: inLib, artistId: ARTIST, rgMbid: `${P}-rg-a`, identityKey: `${P}-ik-a`, title: "Swap A", primaryType: "Album", location: "LIBRARY" } });
        await prisma.album.create({ data: { id: inDiscover, artistId: ARTIST, rgMbid: `${P}-rg-b`, identityKey: `${P}-ik-b`, title: "Swap B", primaryType: "Album", location: "DISCOVER" } });
        const hash = jest.spyOn(inputsHash, "hashInputs");
        try {
            await buildMoods();
            hash.mockClear();
            expect(await buildMoods()).toEqual({ scored: 0, stateChanged: false });
            expect(hash).not.toHaveBeenCalled();
            // Both at once: the number of library albums stays the same.
            await prisma.album.update({ where: { id: inLib }, data: { location: "DISCOVER" } });
            await prisma.album.update({ where: { id: inDiscover }, data: { location: "LIBRARY" } });
            await buildMoods();
            expect(hash).toHaveBeenCalledTimes(1);
        } finally {
            hash.mockRestore();
            await prisma.album.deleteMany({ where: { id: { in: [inLib, inDiscover] } } });
        }
    });

    it("are not read back from other weights", async () => {
        await prisma.$executeRawUnsafe(`UPDATE mood_state SET version = 'older'`);
        expect(await loadMoodState()).toBeNull();
        expect(await buildMoods()).toEqual({ scored: 0, stateChanged: true });
        expect(await loadMoodState()).not.toBeNull();
    });
});

describe("the mood step's progress", () => {
    it("counts present tracks with a sound vector of the heads' model, and those with current scores", async () => {
        const present = SCORED - 1;
        expect(await moodProgress()).toEqual({ total: present, completed: present });
        await insertVector(trackId(8), vector());
        expect(await moodProgress()).toEqual({ total: present, completed: present - 1 });
        await buildMoods();
        expect(await moodProgress()).toEqual({ total: present, completed: present });
    });
});

describe("a re-run that deletes a sound vector while the step scores it", () => {
    it("with no statistics row to lock, leaves the step writing nothing, and the next pass builds", async () => {
        const [gone, waiting] = [trackId(3), trackId(4)];
        await buildMoods();
        // As after a rescore: no statistics row, and both tracks owed scores.
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await prisma.$executeRawUnsafe(`DELETE FROM track_moods WHERE track_id IN ($1, $2)`, gone, waiting);
        let building: Promise<{ scored: number; stateChanged: boolean }> | undefined;
        await prisma.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id = $1`, gone);
                building = buildMoods();
                await untilWaiting("INSERT INTO track_moods");
            },
            { timeout: 30_000, maxWait: 30_000 },
        );
        // Postgres refuses the insert as a serialization failure (40001), not a missing reference, and the build
        // treats it as inputs that changed under it.
        expect(await building).toEqual({ scored: 0, stateChanged: false });
        expect(logger.info).toHaveBeenCalledWith(
            "[Moods] Scores changed while the build waited; the next pass rebuilds them",
        );
        const [{ rows, states }] = await prisma.$queryRawUnsafe<Array<{ rows: number; states: number }>>(
            `SELECT (SELECT count(*)::int FROM track_moods WHERE track_id = $1) AS rows,
                    (SELECT count(*)::int FROM mood_state) AS states`,
            waiting,
        );
        expect({ rows, states }).toEqual({ rows: 0, states: 0 });

        expect(await buildMoods()).toEqual({ scored: 1, stateChanged: true });
        await insertVector(gone, vector());
        expect(await buildMoods()).toEqual({ scored: 1, stateChanged: true });
    });
});

describe("a reading no eligible track has", () => {
    it("is stored as absent while the moods' statistics build; only the recipes that blend it refuse", async () => {
        await prisma.$executeRawUnsafe(`UPDATE "Track" SET instrumentalness = NULL, "updatedAt" = now() WHERE id LIKE '${P}%'`);
        expect(await buildMoods()).toEqual({ scored: 0, stateChanged: true });
        expect(logger.warn).toHaveBeenCalledWith(
            "[Moods] No eligible track has the instrumental_logit reading; recipes that blend it rank no songs",
        );
        const state = (await loadMoodState())!;
        expect(state.readings.instrumental_logit).toBeNull();
        expect(state.readings.arousal?.sd).toBeGreaterThan(0);
        expect(state.readings.acoustic_logit?.sd).toBeGreaterThan(0);
        for (const mood of MOODS) expect(state.moods[mood].sd).toBeGreaterThan(0);

        await expect(pickStationTracks(getRecipe("focus"), { limit: 10 })).rejects.toThrow(UnrankableLibraryError);
        await expect(pickStationTracks(getRecipe("focus"), { limit: 10 })).rejects.toThrow("instrumental reading");
        const moodsOnly = [...RECIPES.values()].find((r) =>
            r.components.every((c) => (MOODS as readonly string[]).includes(c.signal)) &&
            r.filters.instrumentalMin === undefined && r.filters.instrumentalMax === undefined);
        expect(moodsOnly).toBeDefined();
        await expect(pickStationTracks(moodsOnly!, { limit: 10 })).resolves.toEqual(expect.any(Array));
    });

    it("leaves the song tags and the mood snapshot, which read moods only, working", async () => {
        await writeMoodTags();
        const tags = (await prisma.track.findMany({ where: { id: { startsWith: P } }, select: { moodTags: true } }))
            .map((t) => t.moodTags);
        expect(tags.some((t) => t.length > 0)).toBe(true);
        expect(tags.some((t) => t.includes("focus"))).toBe(false);
        const { snapshot } = await refreshMoodSnapshot();
        expect(snapshot.views.size).toBe((await loadMoodState())!.trackCount);
    });
});

describe("the planner's row count for the scores", () => {
    const counted = async () =>
        (await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT reltuples::float8 AS n FROM pg_class WHERE oid = 'track_moods'::regclass`,
        ))[0].n;
    const rows = async () =>
        (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM track_moods`))[0].n;
    /** The scores of `n` tracks removed, and the planner told the table is that much smaller. */
    async function forget(n: number) {
        await prisma.$executeRawUnsafe(
            `DELETE FROM track_moods WHERE track_id IN (SELECT track_id FROM track_moods ORDER BY track_id LIMIT ${n})`,
        );
        await prisma.$executeRawUnsafe(`ANALYZE track_moods`);
    }

    it("is refreshed after a batch large against it, and left alone after a small one", async () => {
        await buildMoods();
        const all = await rows();
        const half = Math.floor(all / 2);
        await forget(half);
        expect(await counted()).toBe(all - half);
        // Half the table again is far more than a tenth of what the planner counts.
        expect((await buildMoods()).scored).toBe(half);
        expect(await counted()).toBe(all);

        await forget(1);
        // One track is under a tenth of the rest, and under a thousand.
        expect((await buildMoods()).scored).toBe(1);
        expect(await counted()).toBe(all - 1);
        expect(await rows()).toBe(all);
    });
});
