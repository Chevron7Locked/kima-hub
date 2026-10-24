/**
 * Text search's exact second read, on a real database: when the vector index returns fewer rows than asked, the search
 * reads every searchable track's distance in the same transaction, so the answer is full and exact. Here the index is
 * made to stop early, as it does once it reaches its scan cap on a library far larger than this one (utils/knn.ts):
 * the wrapper below turns the keep-going scan off after the product's own settings, so only the first walk of
 * ef_search candidates runs. (On 2,000 vectors a low hnsw.max_scan_tuples did not stop it.)
 */
import type { Prisma } from "@prisma/client";

jest.mock("../../utils/knn", () => {
    const actual = jest.requireActual("../../utils/knn");
    return {
        ...actual,
        withEfSearch: <T>(ef: number, run: (tx: Prisma.TransactionClient) => Promise<T>) =>
            actual.withEfSearch(ef, async (tx: Prisma.TransactionClient) => {
                await tx.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'off', true)`;
                return run(tx);
            }),
    };
});

const mockDebug = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: (...a: unknown[]) => mockDebug(...a), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    __esModule: true,
    redisClient: { ping: jest.fn(async () => "pong") },
}));

import { prisma } from "../../utils/db";
import { searchTracksByEmbedding } from "../textEmbeddingBridge";

jest.setTimeout(120_000);

const COUNT = 2000;
const trackId = (i: number) => `cexact${String(i).padStart(5, "0")}`;
const ALL = Array.from({ length: COUNT }, (_, i) => trackId(i));

/** A seeded unit vector per number, as stored: single precision. */
function unitVector(seed: number): number[] {
    let s = (seed * 2654435761 + 1) >>> 0;
    const v = Array.from({ length: 512 }, () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296 - 0.5;
    });
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    return v.map((x) => Math.fround(x / norm));
}
const VECTORS = ALL.map((_, i) => unitVector(i + 1));
const QUERY = unitVector(424242);

/** The `limit` nearest of `ids` by cosine distance, then id: a brute-force answer to compare the search with. */
function bruteForce(ids: string[], limit: number): string[] {
    const qn = Math.sqrt(QUERY.reduce((sum, x) => sum + x * x, 0));
    return ids
        .map((id) => {
            const v = VECTORS[ALL.indexOf(id)];
            const dot = v.reduce((sum, x, k) => sum + x * QUERY[k], 0);
            return { id, distance: 1 - dot / (qn * Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))) };
        })
        .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((r) => r.id);
}

async function writeVectors(ids: string[]) {
    for (let start = 0; start < ids.length; start += 50) {
        const chunk = ids.slice(start, start + 50);
        const values = chunk.map((_, j) => `($${2 * j + 1}, $${2 * j + 2}::vector, 'laion-clap-music-onnx-v1', now())`);
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at) VALUES ${values.join(",")}`,
            ...chunk.flatMap((id) => [id, `[${VECTORS[ALL.indexOf(id)].join(",")}]`]),
        );
    }
}

const fellBack = () => mockDebug.mock.calls.some(([message]) => String(message).includes("reading every searchable"));
const bestFirst = (rows: Array<{ distance: number }>) =>
    rows.every((r, k) => k === 0 || rows[k - 1].distance <= r.distance);

beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track"`);
    await prisma.artist.create({ data: { id: "cart_exact", name: "Exact Artist", identityKey: "a_exact" } });
    await prisma.album.create({
        data: { id: "calb_exact", rgMbid: "rg_exact", artistId: "cart_exact", title: "Exact", primaryType: "Album" },
    });
    await prisma.track.createMany({
        data: ALL.map((id, i) => ({
            id, albumId: "calb_exact", title: `T ${i}`, trackNo: i + 1, duration: 200,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
        })),
    });
    // Deleted vectors stay in the index for the whole file, as on a server until autovacuum runs.
    await prisma.$executeRawUnsafe(`ALTER TABLE track_embeddings SET (autovacuum_enabled = false)`);
    await writeVectors(ALL);
    for (const table of ["track_embeddings", '"Track"', '"Album"', '"Artist"']) {
        await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
    }
});

afterAll(async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE track_embeddings RESET (autovacuum_enabled)`);
    await prisma.track.deleteMany({ where: { id: { startsWith: "cexact" } } });
    await prisma.album.deleteMany({ where: { id: "calb_exact" } });
    await prisma.artist.deleteMany({ where: { id: "cart_exact" } });
    await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) track_embeddings`);
    await prisma.$disconnect();
});

beforeEach(() => mockDebug.mockClear());

describe("text search's exact second read", () => {
    it("is not taken when the index fills the limit", async () => {
        const rows = await searchTracksByEmbedding(QUERY, 50);
        expect(rows).toHaveLength(50);
        expect(bestFirst(rows)).toBe(true);
        expect(fellBack()).toBe(false);
    });

    it("fills the limit with the exact nearest after a vectors re-run left the index full of deleted ones", async () => {
        const back = ALL.filter((_, i) => i % 20 === 0);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE 'cexact%'`);
        await writeVectors(back);
        const rows = await searchTracksByEmbedding(QUERY, 50);
        expect(fellBack()).toBe(true);
        expect(rows.map((r) => r.id)).toEqual(bruteForce(back, 50));
        expect(bestFirst(rows)).toBe(true);
    });

    it("returns every searchable track, exactly ordered, when there are fewer than the limit", async () => {
        const back = ALL.filter((_, i) => i % 100 === 1);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE 'cexact%'`);
        await writeVectors(back);
        const rows = await searchTracksByEmbedding(QUERY, 50);
        expect(fellBack()).toBe(true);
        expect(rows.map((r) => r.id)).toEqual(bruteForce(back, 50));
    });
});
