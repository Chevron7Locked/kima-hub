/**
 * Text search's exact second read, on a real database: when the vector index returns fewer rows than asked, the search
 * reads every searchable track's distance, after the index's transaction has ended, so the answer is full and exact.
 * The index is made to stop early, as it does at its scan cap on a far larger library (utils/knn.ts): the wrapper
 * below turns the keep-going scan off after the product's own settings, so only the first walk of ef_search
 * candidates runs.
 */
import type { Prisma } from "@prisma/client";

/** Whether the index's transaction had ended when the exact read began; null until an exact read runs. */
let mockExactAfterIndex: boolean | null = null;
let mockIndexOpen = false;
/** Set to make the exact read slow: a lock held for SLOW_MS blocks it, as a long read on a slow disk would. */
let mockSlow = false;
const SLOW_MS = 6000;
let mockLocker: Promise<unknown> | null = null;

/** Runs before an exact read on whichever client runs it: records when it ran, and slows it if asked. */
async function mockBeforeExact(query: unknown): Promise<void> {
    const sql = (query as { sql?: unknown } | undefined)?.sql;
    if (typeof sql !== "string" || !sql.includes(") + 0, t.id")) return;
    mockExactAfterIndex = !mockIndexOpen;
    if (!mockSlow) return;
    const { prisma } = jest.requireActual("../../utils/db");
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    mockLocker = prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe(`LOCK TABLE track_embeddings IN ACCESS EXCLUSIVE MODE`);
        locked();
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    }, { timeout: 4 * SLOW_MS, maxWait: 4 * SLOW_MS });
    await holding;
}

jest.mock("../../utils/knn", () => {
    const actual = jest.requireActual("../../utils/knn");
    return {
        ...actual,
        withEfSearch: async <T>(ef: number, run: (tx: Prisma.TransactionClient) => Promise<T>) => {
            mockIndexOpen = true;
            try {
                return await actual.withEfSearch(ef, async (tx: Prisma.TransactionClient) => {
                    await tx.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'off', true)`;
                    return run(tx);
                });
            } finally {
                mockIndexOpen = false;
            }
        },
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
import { insertEmbeddings, vectorLiteral } from "../../__tests__/helpers/embeddingFixtures";

// Every exact read passes through here, on the pool or on a transaction's client: the latter runs this same method
// with itself as `this`, which is passed on unchanged.
const queryRaw = prisma.$queryRaw;
jest.spyOn(prisma, "$queryRaw").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    await mockBeforeExact(args[0]);
    return (queryRaw as (...a: unknown[]) => Promise<unknown>).apply(this, args);
} as typeof prisma.$queryRaw);

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
    await insertEmbeddings(ids.map((trackId) => ({ trackId, vector: vectorLiteral(VECTORS[ALL.indexOf(trackId)]) })));
}

const fellBack = () => mockDebug.mock.calls.some(([message]) => String(message).includes("reading every searchable"));
const bestFirst = (rows: Array<{ distance: number }>) =>
    rows.every((r, k) => k === 0 || rows[k - 1].distance <= r.distance);

beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track"`);
    // Earlier files on this worker leave deleted vectors in the index, which can trap the one walk below; start from an
    // index of this file's vectors only, so the dead entries the tests rely on are their own.
    await prisma.$executeRawUnsafe(`VACUUM track_embeddings`);
    await prisma.$executeRawUnsafe(`REINDEX INDEX track_embeddings_embedding_idx`);
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

beforeEach(() => {
    mockDebug.mockClear();
    mockExactAfterIndex = null;
});

describe("text search's exact second read", () => {
    it("is not taken when the index fills the limit", async () => {
        const rows = await searchTracksByEmbedding(QUERY, 50);
        expect(rows).toHaveLength(50);
        expect(bestFirst(rows)).toBe(true);
        expect(fellBack()).toBe(false);
    });

    it("fills the limit with the exact nearest after a vectors re-run filled the index with deleted ones", async () => {
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

    it("reads after the index's transaction ends, so a read past Prisma's 5-second limit still answers", async () => {
        const back = ALL.filter((_, i) => i % 20 === 0);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE 'cexact%'`);
        await writeVectors(back);
        mockSlow = true;
        try {
            const started = Date.now();
            const rows = await searchTracksByEmbedding(QUERY, 50);
            expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW_MS);
            expect(mockExactAfterIndex).toBe(true);
            expect(rows.map((r) => r.id)).toEqual(bruteForce(back, 50));
        } finally {
            mockSlow = false;
            await mockLocker;
        }
    });
});
