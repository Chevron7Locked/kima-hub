/**
 * The similarity step and the ranking pass on a real database, checked against the
 * formula computed in TypeScript from what the database holds: the stored feel, the
 * library state, the vibe map's arithmetic, and every vibe feature's scores against
 * `pairScore`.
 */
import type { Prisma } from "@prisma/client";
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import feelProbe from "../feelProbe.json";
import {
    SELF_SCORE,
    blendSelfScore,
    buildGenreModel,
    capList,
    dot,
    feelVector,
    genreWeight,
    pairScore,
    unit,
    type MatchTrack,
} from "../formula";
import { updateMap } from "../map";
import { layoutLibrary } from "../mapCompute";
import { artistProfiles, matchingContext, scoreLibrary } from "../rank";
import { MATCHING_MODEL, buildMatching, loadMatchingState, matchingGenres, matchingProgress } from "../state";
import { findSimilarTracks } from "../../hybridSimilarity";
import { generateSongPath } from "../../songPath";
import { getVibeMap } from "../../vibeMap";
import { seededRandom } from "../mapLayout";
import { gaussian as sharedGaussian } from "../../../__tests__/fixtures/gaussian";
import { parseEmbedding } from "../../../utils/embedding";
import { insertEmbeddings, vectorLiteral } from "../../../__tests__/helpers/embeddingFixtures";

// The real worker, with a hook a test can run first: what happens while a layout is being computed.
const mockBeforeWorker: { run: null | (() => Promise<void>) } = { run: null };
jest.mock("../worker", () => {
    const actual = jest.requireActual("../worker");
    return {
        runInWorker: async (...args: unknown[]) => {
            if (mockBeforeWorker.run) await mockBeforeWorker.run();
            return actual.runInWorker(...args);
        },
    };
});
jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../../middleware/auth", () => {
    const passthrough = (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    };
    return new Proxy(
        { requireAuth: passthrough, requireAuthOrToken: passthrough },
        { get: (target: any, key: string) => (key in target ? target[key] : passthrough) },
    );
});

jest.mock("../../../utils/redis", () => ({
    __esModule: true,
    // A re-run that clears tracks' work empties the analysis queue first (the BullMQ queues use their own connection).
    redisClient: { ping: jest.fn(async () => "pong"), del: jest.fn(async () => 0) },
}));

jest.mock("../../featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({ musicCNN: true, vibeEmbeddings: true, audiobookshelfEnabled: false }),
    },
}));

import vibeRouter from "../../../routes/vibe";

jest.setTimeout(60_000);

const app = express();
app.use(express.json());
app.use("/api/vibe", vibeRouter);

const ARTISTS: Record<string, string[]> = {
    cartmatcha00000000000: ["Rock", "Synth-Pop", "darkwave"],
    cartmatchb00000000000: ["rock", "synthpop", "new wave"],
    cartmatchc00000000000: ["Hip-Hop", "hip hop", "trap"],
    cartmatchd00000000000: ["ambient", "techno"],
    cartmatche00000000000: [],
    cartmatchf00000000000: ["made-up tag"],
};
const ALBUMS_PER_ARTIST = 2;
const TRACKS_PER_ALBUM = 4;
const OTHER_MODEL = "cmatchothermodel00000";
const GONE = "cmatchgone00000000000";

const trackId = (a: number, b: number, t: number) => `cmatcht${a}${b}${t}${"0".repeat(14)}`;

const rand = seededRandom(20261007);
const gaussian = () => sharedGaussian(rand);

const vectors = new Map<string, number[]>();
const LIBRARY = Object.keys(ARTISTS).length * ALBUMS_PER_ARTIST * TRACKS_PER_ALBUM;

async function insertTrack(id: string, albumId: string, n: number, extra: Record<string, unknown> = {}) {
    await prisma.track.create({
        data: {
            id,
            albumId,
            title: `M ${id}`,
            trackNo: n,
            duration: 200,
            filePath: `/tmp/${id}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...extra,
        },
    });
}

async function insertVector(id: string, vector: number[], model = MATCHING_MODEL) {
    vectors.set(id, vector);
    await insertEmbeddings([{ trackId: id, vector: vectorLiteral(vector) }], { model, replace: true });
}

async function seed() {
    const artistIds = Object.keys(ARTISTS);
    for (const [a, artistId] of artistIds.entries()) {
        await prisma.artist.create({
            data: { id: artistId, name: `Match ${a}`, identityKey: `a_match_${a}`, genres: ARTISTS[artistId] },
        });
        const centre = Array.from({ length: 512 }, gaussian);
        for (let b = 0; b < ALBUMS_PER_ARTIST; b++) {
            const albumId = `calbmatch${a}${b}${"0".repeat(10)}`;
            await prisma.album.create({
                data: {
                    id: albumId,
                    rgMbid: `rg_match_${a}${b}`,
                    artistId,
                    title: `Match album ${a}${b}`,
                    identityKey: `i_match_${a}${b}`,
                    primaryType: "Album",
                },
            });
            for (let t = 0; t < TRACKS_PER_ALBUM; t++) {
                const id = trackId(a, b, t);
                await insertTrack(id, albumId, t + 1);
                const scale = 0.5 + rand() * 1.5;
                await insertVector(id, centre.map((c) => scale * (c + 0.9 * gaussian())));
            }
        }
    }
    await insertTrack(OTHER_MODEL, `calbmatch00${"0".repeat(10)}`, 90);
    await insertVector(OTHER_MODEL, Array.from({ length: 512 }, gaussian), "laion-clap-music");
    await insertTrack(GONE, `calbmatch10${"0".repeat(10)}`, 91, { missingSince: new Date() });
    await insertVector(GONE, Array.from({ length: 512 }, gaussian));
}

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE 'cmatch%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE 'calbmatch%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE 'cartmatch%'`);
}

/** The probe applied in float64 to a stored vector. */
function probe(vector: number[]): [number, number] {
    const u = unit(vector);
    const clip = (x: number) => Math.min(1, Math.max(0, x));
    return [
        clip(dot(u, feelProbe.valence.weights) + feelProbe.valence.bias),
        clip(dot(u, feelProbe.arousal.weights) + feelProbe.arousal.bias),
    ];
}

/** The formula's view of every eligible track, built in TypeScript from the stored single-precision values. */
async function reference() {
    const stored = await prisma.$queryRawUnsafe<
        Array<{ id: string; albumId: string; artistId: string; embedding: string; valence: number; arousal: number }>
    >(`
        SELECT te.track_id AS id, t."albumId", a."artistId", te.embedding::text AS embedding, f.valence, f.arousal
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        WHERE te.model_version = $1 AND t."missingSince" IS NULL
        ORDER BY te.track_id
    `, MATCHING_MODEL);
    const rows = stored.map((r) => ({ ...r, valence: Math.fround(r.valence), arousal: Math.fround(r.arousal) }));
    const n = rows.length;
    const mean: [number, number] = [0, 1].map((k) => rows.reduce((s, r) => s + [r.valence, r.arousal][k], 0) / n) as [number, number];
    const sd: [number, number] = [0, 1].map((k) =>
        Math.sqrt(rows.reduce((s, r) => s + ([r.valence, r.arousal][k] - mean[k]) ** 2, 0) / n),
    ) as [number, number];
    const tracks: MatchTrack[] = rows.map((r) => ({
        trackId: r.id,
        albumId: r.albumId,
        artistId: r.artistId,
        sound: unit(parseEmbedding(r.embedding)),
        feel: feelVector([r.valence, r.arousal], { mean, sd }),
    }));
    const meanSound = tracks[0].sound.map((_, d) => tracks.reduce((s, t) => s + t.sound[d], 0) / n);
    const soundSpread = 1 - dot(meanSound, meanSound);
    const counts = new Map<string, number>();
    for (const t of tracks) counts.set(t.artistId, (counts.get(t.artistId) ?? 0) + 1);
    const artists = await prisma.artist.findMany({ where: { id: { in: [...counts.keys()] } } });
    const { model, spread } = buildGenreModel(
        artists.map((a) => ({ artistId: a.id, tracks: counts.get(a.id)!, genres: matchingGenres(a) })),
    );
    const wgSq = genreWeight(soundSpread, spread) ** 2;
    const feelRaw = new Map(rows.map((r) => [r.id, [r.valence, r.arousal] as [number, number]]));
    return { tracks, byId: new Map(tracks.map((t) => [t.trackId, t])), feelRaw, mean, sd, soundSpread, model, spread, wgSq };
}

function rankedBy(tracks: MatchTrack[], score: (t: MatchTrack) => number, exclude: string[]) {
    return tracks
        .filter((t) => !exclude.includes(t.trackId))
        .map((t) => ({ id: t.trackId, albumId: t.albumId, artistId: t.artistId, score: score(t) }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

beforeAll(async () => {
    await cleanup();
    await seed();
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

/** Waits (up to a minute) until n sessions of this database are waiting on a row lock. */
async function waitingOnLocks(n: number): Promise<void> {
    for (let i = 0; i < 1200; i++) {
        const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
            SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (c >= n) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${n} sessions never waited on a lock`);
}

/** Runs `hold` in a transaction that stays open until `release()`, so other writers queue behind its locks. */
function holdLocks(hold: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const done = prisma.$transaction(
        async (tx) => {
            await hold(tx);
            await held;
        },
        { timeout: 120_000 },
    );
    return { release, done };
}

const lockStateRow = (tx: Prisma.TransactionClient) =>
    tx.$queryRaw`SELECT id FROM matching_state WHERE id = 'default' FOR UPDATE`;

describe("the similarity step", () => {
    it("computes feel for every sound vector of the probe's model and builds the state", async () => {
        const modelVectors = Object.keys(ARTISTS).length * ALBUMS_PER_ARTIST * TRACKS_PER_ALBUM + 1;
        expect(await buildMatching()).toEqual({ feelUpdated: modelVectors, rebuilt: true });

        const stored = await prisma.matchingFeel.findMany({ where: { track_id: { startsWith: "cmatch" } } });
        expect(stored).toHaveLength(modelVectors);
        for (const row of stored) {
            const [v, a] = probe(vectors.get(row.track_id)!);
            expect(Math.abs(row.valence - v)).toBeLessThan(1e-5);
            expect(Math.abs(row.arousal - a)).toBeLessThan(1e-5);
        }
        expect(await matchingProgress()).toEqual({ total: LIBRARY, completed: 0 });
    });

    it("stores the library statistics the formula defines", async () => {
        const ref = await reference();
        const state = (await loadMatchingState())!;
        expect(state.trackCount).toBe(ref.tracks.length);
        for (const k of [0, 1]) {
            expect(Math.abs(state.feel.mean[k] - ref.mean[k])).toBeLessThan(1e-7);
            expect(Math.abs(state.feel.sd[k] - ref.sd[k])).toBeLessThan(1e-7);
        }
        expect(Math.abs(state.soundSpread - ref.soundSpread)).toBeLessThan(1e-5);
        expect(state.genreSpread).toBeCloseTo(ref.spread, 12);
        expect(state.genres).toEqual(JSON.parse(JSON.stringify(ref.model)));
        expect(state.genreWeight).toBeCloseTo(genreWeight(state.soundSpread, state.genreSpread), 12);
        expect(state.genreWeight).toBeGreaterThan(0);
    });

    it("does nothing when nothing changed", async () => {
        expect(await buildMatching()).toEqual({ feelUpdated: 0, rebuilt: false });
    });
});

interface MapRow {
    track_id: string;
    embedded_at: Date;
    x: number;
    y: number;
    z: number;
    colour: number;
    laid_out: boolean;
}

async function mapRows(): Promise<Map<string, MapRow>> {
    const rows = await prisma.$queryRawUnsafe<MapRow[]>(`SELECT * FROM matching_map WHERE track_id LIKE 'cmatch%'`);
    return new Map(rows.map((r) => [r.track_id, r]));
}

async function mapMeta() {
    return prisma.matchingState.findUniqueOrThrow({
        where: { id: "default" },
        select: { mapVersion: true, mapFrame: true },
    });
}

/** Share of each track's 7 nearest by the formula that are also among its 7 nearest on the map. */
const MAP_RECALL_FLOOR = 0.9;

/** Each track's 7 nearest by map position, and by the formula. */
function nearest(ids: string[], distance: (a: string, b: string) => number): Map<string, string[]> {
    return new Map(ids.map((a) => [a, ids.filter((b) => b !== a).sort((b, c) => distance(a, b) - distance(a, c)).slice(0, 7)]));
}

describe("the vibe map", () => {
    it("reports the map as being computed until the similarity step lays it out", async () => {
        expect(await getVibeMap()).toEqual({ status: "computing" });
        const res = await request(app).get("/api/vibe/map");
        expect(res.status).toBe(202);
    });

    it("waits to lay a library out until its genres, analysis and sound vectors have settled", async () => {
        const reads = jest.spyOn(prisma, "$queryRaw");
        expect(await updateMap(false)).toEqual({ laidOut: 0, placed: 0 });
        // While it waits, no cycle loads the library's vectors.
        expect(reads.mock.calls.some((call) => String((call[0] as unknown as { strings?: string[] }).strings ?? call[0]).includes("embedding::text"))).toBe(false);
        reads.mockRestore();
        expect((await mapRows()).size).toBe(0);
        expect(await getVibeMap()).toEqual({ status: "computing" });
    });

    it("lays the library out from the formula's own scores, the same as running the arithmetic directly", async () => {
        expect(await updateMap(true)).toEqual({ laidOut: LIBRARY, placed: 0 });
        expect(await matchingProgress()).toEqual({ total: LIBRARY, completed: LIBRARY });
        const rows = await mapRows();
        expect(rows.size).toBe(LIBRARY);
        expect([...rows.values()].every((r) => r.laid_out)).toBe(true);
        const meta = await mapMeta();
        expect(meta.mapVersion).not.toBeNull();
        expect(meta.mapFrame).not.toBeNull();

        const state = (await loadMatchingState())!;
        const ref = await reference();
        const tracks = ref.tracks.map((t) => ({ ...t, feel: feelVector(ref.feelRaw.get(t.trackId)!, state.feel) }));
        const feelZ = Float64Array.from(
            ref.tracks.flatMap((t) => ref.feelRaw.get(t.trackId)!.map((x, k) => (x - state.feel.mean[k]) / state.feel.sd[k])),
        );
        // Stored float8 values come back through Prisma at 15 significant digits.
        const direct = layoutLibrary(tracks, feelZ, state.genres, state.genreWeight);
        const same = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-13 * Math.max(1, Math.abs(b)));
        ref.tracks.forEach((t, i) => {
            const row = rows.get(t.trackId)!;
            [row.x, row.y, row.z].forEach((v, d) => same(v, direct.positions[i * 3 + d]));
            same(row.colour, direct.colour[i]);
        });
        const colours = [...rows.values()].map((r) => r.colour);
        expect(Math.min(...colours)).toBe(0);
        expect(Math.max(...colours)).toBe(1);
    });

    it("puts the tracks the formula matches next to each other", async () => {
        const ref = await reference();
        const rows = await mapRows();
        const ids = ref.tracks.map((t) => t.trackId);
        const onMap = nearest(ids, (a, b) => {
            const p = rows.get(a)!;
            const q = rows.get(b)!;
            return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
        });
        const byFormula = nearest(ids, (a, b) => -pairScore(ref.byId.get(a)!, ref.byId.get(b)!, ref.model, ref.wgSq));
        const shared = ids.reduce((s, id) => s + onMap.get(id)!.filter((x) => byFormula.get(id)!.includes(x)).length, 0);
        expect(shared / (ids.length * 7)).toBeGreaterThanOrEqual(MAP_RECALL_FLOOR);
    });

    it("serves the stored map with each track's colour, without missing files or other models", async () => {
        const state = await getVibeMap();
        if (state.status !== "ready") throw new Error("the map is not laid out");
        const ours = state.data.tracks.filter((t) => t.id.startsWith("cmatch"));
        expect(ours).toHaveLength(LIBRARY);
        expect(ours.some((t) => t.id === GONE || t.id === OTHER_MODEL)).toBe(false);
        const rows = await mapRows();
        for (const t of ours) {
            expect(t.colour).toBe(rows.get(t.id)!.colour);
            for (const v of [t.x, t.y, t.z]) {
                expect(v).toBeGreaterThanOrEqual(-1e-12);
                expect(v).toBeLessThanOrEqual(1 + 1e-12);
            }
        }
        const res = await request(app).get("/api/vibe/map").set("Accept-Encoding", "identity");
        expect(res.status).toBe(200);
        expect(res.body.tracks.find((t: { id: string }) => t.id === ours[0].id).colour).toBe(ours[0].colour);
    });

    it("places a re-embedded track among the others without moving them", async () => {
        const before = await mapRows();
        const id = trackId(1, 1, 2);
        await insertVector(id, vectors.get(trackId(1, 1, 1))!.map((x) => x + 0.05 * gaussian()));
        await buildMatching();
        expect(await matchingProgress()).toEqual({ total: LIBRARY, completed: LIBRARY - 1 });
        expect(await updateMap(true)).toEqual({ laidOut: 0, placed: 1 });
        expect(await matchingProgress()).toEqual({ total: LIBRARY, completed: LIBRARY });
        const after = await mapRows();
        for (const [other, row] of before) if (other !== id) expect(after.get(other)).toEqual(row);
        const placed = after.get(id)!;
        expect(placed.laid_out).toBe(false);
        expect(placed.embedded_at.getTime()).not.toBe(before.get(id)!.embedded_at.getTime());
        expect(await updateMap(true)).toEqual({ laidOut: 0, placed: 0 });
    });

    it("keeps placing as the library grows, and never moves a track that has a place", async () => {
        const before = await mapRows();
        const ids = Array.from({ length: 20 }, (_, i) => trackId(2 + Math.floor(i / 8), Math.floor(i / 4) % 2, i % 4));
        for (const id of ids) await insertVector(id, vectors.get(id)!.map((x) => x + 0.01 * gaussian()));
        await buildMatching();
        expect(await updateMap(true)).toEqual({ laidOut: 0, placed: ids.length });
        const after = await mapRows();
        for (const [id, row] of before) if (!ids.includes(id)) expect(after.get(id)).toEqual(row);
        for (const id of ids) expect(after.get(id)!.laid_out).toBe(false);
    });
});

describe("the ranking pass", () => {
    const seedId = trackId(0, 0, 0);

    it("scores every eligible track as the formula does", async () => {
        const ref = await reference();
        const ctx = (await matchingContext([seedId]))!;
        const scored = await scoreLibrary(ctx, [[{ trackId: seedId, weight: 1 }]], [seedId]);
        expect(scored).toHaveLength(ref.tracks.length - 1);
        const seed = ref.byId.get(seedId)!;
        for (const row of scored) {
            expect(Math.abs(row.scores[0] - pairScore(seed, ref.byId.get(row.id)!, ref.model, ref.wgSq))).toBeLessThan(1e-5);
        }
        expect(scored.some((r) => r.id === GONE || r.id === OTHER_MODEL)).toBe(false);
    });

    it("returns the capped list a walk down the formula's ranking gives", async () => {
        const ref = await reference();
        const seed = ref.byId.get(seedId)!;
        const expected = capList(
            rankedBy(ref.tracks, (t) => pairScore(seed, t, ref.model, ref.wgSq), [seedId]),
            [seed],
            12,
        );
        const rows = await findSimilarTracks(seedId, 12);
        expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
        const clamp = (x: number) => Math.min(1, Math.max(0, x));
        rows.forEach((r, i) => expect(Math.abs(r.similarity - clamp(expected[i].score / SELF_SCORE))).toBeLessThan(1e-5));
    });

    it("blends with alchemy on the same formula, add tracks taking their places", async () => {
        const ref = await reference();
        const add = [trackId(0, 0, 1), trackId(2, 1, 0)];
        const subtract = [trackId(3, 0, 2)];
        const inputs = [
            ...add.map((id) => ({ track: ref.byId.get(id)!, weight: 1 / add.length })),
            ...subtract.map((id) => ({ track: ref.byId.get(id)!, weight: -1 })),
        ];
        const score = (t: MatchTrack) =>
            inputs.reduce((s, i) => s + i.weight * pairScore(t, i.track, ref.model, ref.wgSq), 0);
        const scale = Math.sqrt(blendSelfScore(inputs, ref.model, ref.wgSq) * SELF_SCORE);
        const expected = capList(
            rankedBy(ref.tracks, score, [...add, ...subtract]),
            add.map((id) => ref.byId.get(id)!),
            15,
        );

        const res = await request(app).post("/api/vibe/alchemy").send({ add, subtract, limit: 15 });
        expect(res.status).toBe(200);
        expect(res.body.tracks.map((t: { id: string }) => t.id)).toEqual(expected.map((r) => r.id));
        res.body.tracks.forEach((t: { distance: number }, i: number) =>
            expect(Math.abs(t.distance - (1 - expected[i].score / scale))).toBeLessThan(1e-5),
        );
    });

    it("refuses a blend that cancels out, and tracks without matching data", async () => {
        const same = trackId(1, 0, 0);
        const cancel = await request(app).post("/api/vibe/alchemy").send({ add: [same], subtract: [same] });
        expect(cancel.status).toBe(400);
        const missing = await request(app).post("/api/vibe/alchemy").send({ add: [OTHER_MODEL] });
        expect(missing.status).toBe(400);
        expect(missing.body.missingAdd).toEqual([OTHER_MODEL]);
    });

    it("walks a song path along the formula's arc between two tracks", async () => {
        const ref = await reference();
        const start = trackId(0, 0, 0);
        const end = trackId(3, 1, 3);
        const result = await generateSongPath(start, end, { length: 12 });
        const cos = pairScore(ref.byId.get(start)!, ref.byId.get(end)!, ref.model, ref.wgSq) / SELF_SCORE;
        expect(result.metadata.embeddingDistance).toBeCloseTo(1 - cos, 5);
        expect(result.startTrack.id).toBe(start);
        expect(result.endTrack.id).toBe(end);
        const ids = result.path.map((t) => t.id);
        expect(ids).toHaveLength(12);
        expect(new Set(ids).size).toBe(12);
        expect(ids.some((id) => [start, end, GONE, OTHER_MODEL].includes(id))).toBe(false);
        expect(result.path.every((t) => t.title && t.artistName && t.albumTitle)).toBe(true);
    });

    it("refuses a song path for a track without matching data", async () => {
        const res = await request(app).post("/api/vibe/path").send({ startTrackId: trackId(0, 0, 0), endTrackId: OTHER_MODEL });
        expect(res.status).toBe(400);
    });

    it("averages each artist's tracks for the artist re-rank", async () => {
        const ref = await reference();
        const state = (await loadMatchingState())!;
        const ids = Object.keys(ARTISTS);
        const profiles = await artistProfiles(state, ids);
        for (const id of ids) {
            const own = ref.tracks.filter((t) => t.artistId === id);
            const p = profiles.get(id)!;
            own[0].sound.forEach((_, d) =>
                expect(Math.abs(p.sound[d] - own.reduce((s, t) => s + t.sound[d], 0) / own.length)).toBeLessThan(1e-5),
            );
            for (const k of [0, 1]) {
                expect(Math.abs(p.feel[k] - own.reduce((s, t) => s + t.feel[k], 0) / own.length)).toBeLessThan(1e-5);
            }
        }
    });
});

describe("rebuilding when the inputs change", () => {
    it("rebuilds when an artist's genres change", async () => {
        const before = (await loadMatchingState())!;
        await prisma.artist.update({ where: { id: "cartmatche00000000000" }, data: { userGenres: ["trap"] } });
        expect(await buildMatching()).toEqual({ feelUpdated: 0, rebuilt: true });
        const after = (await loadMatchingState())!;
        expect(after.genres.artists["cartmatche00000000000"]).toBeDefined();
        expect(after.genreSpread).not.toBeCloseTo(before.genreSpread, 6);
    });

    it("rebuilds when a file goes missing, and drops the track from results at once", async () => {
        const gone = trackId(5, 1, 3);
        const before = (await loadMatchingState())!;
        await prisma.track.update({ where: { id: gone }, data: { missingSince: new Date() } });
        const similar = await findSimilarTracks(trackId(5, 1, 0), 30);
        expect(similar.some((t) => t.id === gone)).toBe(false);
        expect(await buildMatching()).toEqual({ feelUpdated: 0, rebuilt: true });
        expect((await loadMatchingState())!.trackCount).toBe(before.trackCount - 1);
    });

    it("recomputes feel for a track whose sound vector changed", async () => {
        const id = trackId(4, 0, 0);
        await insertVector(id, Array.from({ length: 512 }, gaussian));
        const ctx = await matchingContext([id]);
        expect(ctx!.tracks.has(id)).toBe(false);
        expect(await buildMatching()).toEqual({ feelUpdated: 1, rebuilt: true });
        const [v, a] = probe(vectors.get(id)!);
        const row = (await prisma.matchingFeel.findUnique({ where: { track_id: id } }))!;
        expect(Math.abs(row.valence - v)).toBeLessThan(1e-5);
        expect(Math.abs(row.arousal - a)).toBeLessThan(1e-5);
    });
});

// Last in the file: these re-runs clear the library's state (and its sound vectors) for every test after them.
describe("a re-run while the map is being laid out", () => {
    it("never lets the layout it overtook store the old map over the reset", async () => {
        // Every re-run lays a fresh map, so no layout computed before it may be left standing. A re-run
        // from similarity lands here while the worker computes; the layout then finds no state and writes nothing.
        await buildMatching();
        await prisma.$executeRaw`DELETE FROM matching_map`;
        const { rerunEnrichment } = await import("../../enrichmentRestart");
        let overtook = false;
        mockBeforeWorker.run = async () => {
            mockBeforeWorker.run = null;
            overtook = true;
            await rerunEnrichment("similarity");
        };
        const outcome = await updateMap(true).catch((e: Error) => e);
        const stored = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM matching_map`;
        expect({ stored: stored[0].n, overtook }).toEqual({ stored: 0, overtook: true });
        expect(outcome).toEqual({ laidOut: 0, placed: 0 });
        // The next similarity pass builds the state again and lays the library out afresh.
        await buildMatching();
        expect((await updateMap(true)).laidOut).toBeGreaterThan(0);
    });

    it("lets a layout that reached the database first finish, then the re-run clears it: no old map is left", async () => {
        await buildMatching();
        await prisma.$executeRaw`DELETE FROM matching_map`;
        const { rerunEnrichment } = await import("../../enrichmentRestart");
        // Hold the state row, as a map write already under way does, so the layout and the re-run both queue on it
        // and reach it in the order they were started: the layout first.
        const { release, done: blocker } = holdLocks(lockStateRow);
        const layout = updateMap(true);
        let rerun: Promise<unknown> = Promise.resolve();
        try {
            await waitingOnLocks(1);
            rerun = rerunEnrichment("similarity");
            await waitingOnLocks(2);
        } finally {
            release();
            await blocker;
        }
        await Promise.all([layout, rerun]);
        const stored = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM matching_map`;
        const state = await prisma.matchingState.findUnique({ where: { id: "default" } });
        expect({ stored: stored[0].n, state }).toEqual({ stored: 0, state: null });
        await buildMatching();
        expect((await updateMap(true)).laidOut).toBeGreaterThan(0);
    }, 120_000);

    it("never deadlocks with a re-run that clears sound vectors, whose deletes reach the stored map", async () => {
        // Deleting a sound vector deletes its map row, so this re-run touches the map before the state; it must still
        // take the state row first, as the layout does, or each waits on the other.
        await buildMatching();
        await prisma.$executeRaw`DELETE FROM matching_map`;
        await updateMap(true);
        const { rerunEnrichment } = await import("../../enrichmentRestart");
        const { release, done: blocker } = holdLocks(lockStateRow);
        // A placement write (the map is laid out; a new vector waits for a place) queues on the state row.
        await prisma.$executeRaw`DELETE FROM matching_map WHERE track_id = ${trackId(0, 0, 0)}`;
        const placement = updateMap(true);
        let rerun: Promise<unknown> = Promise.resolve();
        try {
            await waitingOnLocks(1);
            rerun = rerunEnrichment("vectors");
            await waitingOnLocks(2);
        } finally {
            release();
            await blocker;
        }
        const outcomes = await Promise.allSettled([placement, rerun]);
        expect(outcomes.map((o) => (o.status === "rejected" ? String(o.reason).slice(0, 120) : "ok"))).toEqual(["ok", "ok"]);
        const stored = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM matching_map`;
        expect(stored[0].n).toBe(0);
    }, 120_000);

    it("lets a build that waited behind a re-run write nothing, instead of a state from the data the re-run cleared", async () => {
        await cleanup();
        await seed();
        // A re-run in flight: it has taken the state row and deleted it, and has not committed yet.
        await buildMatching();
        const { release, done: rerun } = holdLocks((tx) => tx.$executeRaw`DELETE FROM matching_state`);
        await prisma.$executeRaw`UPDATE track_embeddings SET analyzed_at = analyzed_at + interval '1 second'`;
        const build = buildMatching();
        try {
            await waitingOnLocks(1);
        } finally {
            release();
            await rerun;
        }
        expect(await build).toEqual({ feelUpdated: 0, rebuilt: false });
        expect(await prisma.matchingState.findUnique({ where: { id: "default" } })).toBeNull();
    }, 120_000);

    it("never deadlocks with the sound-vector analyzer storing a vector while a re-run resets it", async () => {
        await cleanup();
        await seed();
        await buildMatching();
        const id = trackId(1, 0, 0);
        await prisma.$executeRaw`
            INSERT INTO "TrackStage" (id, "trackId", stage, status, attempt, redelivered)
            VALUES (${`stage-${id}`}, ${id}, 'embedding', 'working', 1, 0)
            ON CONFLICT ("trackId", stage) DO UPDATE SET status = 'working', attempt = 1, redelivered = 0, "decidedAt" = NULL`;
        const { rerunEnrichment } = await import("../../enrichmentRestart");
        let resume = () => {};
        const paused = new Promise<void>((resolve) => (resume = resolve));
        // The analyzer's own statements (services/audio-analyzer-clap/analyzer.py): its claim on the stage row, then
        // the vector and the track.
        const analyzer = prisma.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT 1 FROM "TrackStage" WHERE "trackId" = ${id} AND stage = 'embedding' AND status = 'working' AND attempt = 1 AND redelivered = 0 FOR SHARE`;
                await paused;
                await tx.$executeRaw`UPDATE track_embeddings SET analyzed_at = now() WHERE track_id = ${id}`;
                await tx.$executeRaw`UPDATE "Track" SET instrumentalness = 0.5 WHERE id = ${id}`;
            },
            { timeout: 120_000 },
        );
        const rerun = rerunEnrichment("vectors");
        try {
            await waitingOnLocks(1);
        } finally {
            resume();
        }
        const outcomes = await Promise.allSettled([analyzer, rerun]);
        expect(outcomes.map((o) => (o.status === "rejected" ? String(o.reason).slice(0, 120) : "ok"))).toEqual(["ok", "ok"]);
        expect(await prisma.trackStage.findUnique({ where: { trackId_stage: { trackId: id, stage: "embedding" } }, select: { status: true } })).toEqual({ status: "pending" });
    }, 120_000);
});
