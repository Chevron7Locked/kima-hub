/**
 * HNSW answers from hnsw.ef_search candidates (default 40), so text search widens
 * it to the requested limit inside its transaction (utils/knn.ts). The EXPLAIN
 * guard runs first: on a small table Postgres seq-scans and the count check alone
 * would pass without the widening.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { MAX_SCAN_TUPLES, efFor, withEfSearch } from "../../utils/knn";
import { searchTracksByEmbedding } from "../textEmbeddingBridge";

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    __esModule: true,
    redisClient: { ping: jest.fn(async () => "pong") },
}));

const TRACK_COUNT = 4000;
const trackId = (i: number) => `cknn${String(i).padStart(18, "0")}`;
const ALL_IDS = Array.from({ length: TRACK_COUNT }, (_, i) => trackId(i));

// Random unit vectors from a seeded PRNG. Structured vectors tie, and ties make
// pgvector scan past ef_search, hiding the 40-row cap.
function lcg(seed: number): () => number {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

// Raw LCG streams from nearby seeds are scaled copies of one another
// (term_n = seed * 16807^n mod p), which makes their vectors nearly parallel;
// run each index through a splitmix-style mixer first so the streams are
// genuinely independent.
function seedFor(i: number): number {
    let h = (i + 1) | 0;
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return ((h >>> 0) % 2147483646) + 1;
}

function randomUnit(i: number): string {
    const rand = lcg(seedFor(i));
    const v = Array.from({ length: 512 }, () => rand() * 2 - 1);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    return `[${v.map((x) => x / norm).join(",")}]`;
}

beforeAll(async () => {
    // Leftover tracks (and their embeddings) from any other suite or an
    // interrupted run would land inside this suite's vector-search windows:
    // start from an empty library -- this file seeds everything it asserts
    // about. Deleting tracks cascades their embedding rows.
    await prisma.$executeRawUnsafe(`DELETE FROM "Track"`);
    await prisma.artist.create({
        data: { id: "cart_knn_1", name: "KNN Artist", identityKey: "a_knn_1" },
    });
    await prisma.album.create({
        data: {
            id: "calb_knn_1",
            rgMbid: "rg_knn_1",
            artistId: "cart_knn_1",
            title: "KNN Album",
            primaryType: "Album",
        },
    });
    await prisma.track.createMany({
        data: ALL_IDS.map((id, i) => ({
            id,
            albumId: "calb_knn_1",
            title: `T ${i}`,
            trackNo: i + 1,
            duration: 200,
            filePath: `/tmp/knn_${i}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        })),
    });
    for (let start = 0; start < TRACK_COUNT; start += 25) {
        const ids = ALL_IDS.slice(start, start + 25);
        const values = ids
            .map((_, j) => `($${2 * j + 1}, $${2 * j + 2}::vector, 'laion-clap-music-onnx-v1', now())`)
            .join(",");
        const params = ids.flatMap((id, j) => [id, randomUnit(start + j)]);
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ${values}`,
            ...params,
        );
    }
    // The planner decides index vs seq scan from pg_class statistics, which a
    // plain INSERT leaves stale (reltuples=0 => "empty table" => seq scan).
    // ANALYZE makes the EXPLAIN guard below a truthful planner decision.
    for (const table of ['"track_embeddings"', '"Track"', '"Album"', '"Artist"']) {
        await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
    }
}, 120000);

afterAll(async () => {
    // track_embeddings rows first, then the parents; the underscore is escaped
    // because LIKE treats a bare _ as a wildcard.
    await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE $1`, "cknn%");
    await prisma.track.deleteMany({ where: { id: { startsWith: "cknn" } } });
    await prisma.album.deleteMany({ where: { id: "calb_knn_1" } });
    await prisma.artist.deleteMany({ where: { id: "cart_knn_1" } });
    // VACUUM ANALYZE so later suites in this worker plan against their own row
    // counts, not this file's 4000-row peak.
    for (const table of ['"track_embeddings"', '"Track"', '"Album"', '"Artist"']) {
        await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) ${table}`);
    }
    await prisma.$disconnect();
});

describe("HNSW index-scan guard (the row count below is only meaningful through the index)", () => {
    it("answers the text-search shape with Index Scan using track_embeddings_embedding_idx", async () => {
        const vector = randomUnit(999999);
        const plan = await prisma.$queryRaw<Array<Record<string, string>>>`
            EXPLAIN (COSTS OFF)
            SELECT t.id
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE t."missingSince" IS NULL
            ORDER BY te.embedding <=> ${vector}::vector
            LIMIT 100
        `;
        const text = plan.map((row) => Object.values(row).join("\n")).join("\n");
        expect(text).toContain("Index Scan using track_embeddings_embedding_idx");
        expect(text).not.toContain("Seq Scan on track_embeddings");
    });
});

describe("text search returns the requested row count", () => {
    it("searchTracksByEmbedding(query, 100) returns 100 rows", async () => {
        const rows = await searchTracksByEmbedding(JSON.parse(randomUnit(999999)), 100);
        expect(rows).toHaveLength(100);
    });
});

describe("utils/knn helper contract", () => {
    type Settings = Array<{ ef: string; scan: string; tuples: string }>;
    const SETTINGS = Prisma.sql`
        SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS scan,
               current_setting('hnsw.max_scan_tuples') AS tuples
    `;

    it("raises ef_search to the requested width and scans on in relaxed order inside the transaction", async () => {
        const [inside] = await withEfSearch(123, (tx) => tx.$queryRaw<Settings>(SETTINGS));
        expect(inside).toEqual({ ef: "123", scan: "relaxed_order", tuples: String(MAX_SCAN_TUPLES) });
    });

    it("reverts to pgvector's defaults on the pool after the transaction", async () => {
        await withEfSearch(500, async () => undefined);
        const [after] = await prisma.$queryRaw<Settings>(SETTINGS);
        expect(after).toEqual({ ef: "40", scan: "off", tuples: "20000" });
    });

    it("sizes the width as min(1000, max(2*limit, 100))", () => {
        expect(efFor(100)).toBe(200);
        expect(efFor(30)).toBe(100);
        expect(efFor(600)).toBe(1000);
    });
});


describe("text search fills its limit past rows the index walk cannot return", () => {
    const QUERY = JSON.parse(randomUnit(424242)) as number[];
    /** The songs still searchable: one in four of the library while most are missing, one in twenty re-embedded. */
    const keptEvery = (n: number) => new Set(ALL_IDS.filter((_, i) => i % n === 0));
    const bestFirst = (rows: Array<{ distance: number }>) => rows.every((r, k) => k === 0 || rows[k - 1].distance <= r.distance);

    /** The text-search shape is answered through the vector index: the counts below mean something only then. */
    async function throughIndex(): Promise<boolean> {
        const plan = await prisma.$queryRaw<Array<Record<string, string>>>`
            EXPLAIN (COSTS OFF)
            SELECT t.id
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE t."missingSince" IS NULL
            ORDER BY te.embedding <=> ${randomUnit(424242)}::vector
            LIMIT 50
        `;
        return plan.map((row) => Object.values(row).join("\n")).join("\n").includes("track_embeddings_embedding_idx");
    }

    beforeAll(async () => {
        // A server keeps deleted vectors in the index until autovacuum runs, and so does this test for its whole
        // length; the songs' statistics also stay as the cases below leave them.
        for (const table of ["track_embeddings", '"Track"']) {
            await prisma.$executeRawUnsafe(`ALTER TABLE ${table} SET (autovacuum_enabled = false)`);
        }
    });

    afterAll(async () => {
        for (const table of ["track_embeddings", '"Track"']) {
            await prisma.$executeRawUnsafe(`ALTER TABLE ${table} RESET (autovacuum_enabled)`);
        }
    });

    it("with most songs missing, as when a share is unmounted: the nearest searchable songs, best first", async () => {
        const KEPT = keptEvery(4);
        // Not analysed afterwards: on this small a table the planner, told most songs are missing, reads the songs
        // first and never asks the index; a library of 50,000 half missing is still answered through it.
        await prisma.$executeRawUnsafe(
            `UPDATE "Track" SET "missingSince" = now() WHERE id LIKE 'cknn%' AND NOT (id = ANY($1))`, [...KEPT],
        );
        try {
            expect(await throughIndex()).toBe(true);
            const rows = await searchTracksByEmbedding(QUERY, 50);
            expect(rows).toHaveLength(50);
            expect(rows.every((r) => KEPT.has(r.id))).toBe(true);
            expect(bestFirst(rows)).toBe(true);
        } finally {
            await prisma.$executeRawUnsafe(`UPDATE "Track" SET "missingSince" = NULL WHERE id LIKE 'cknn%'`);
        }
    });

    it("after a vectors re-run deleted every vector and the analyzer wrote some back", async () => {
        const KEPT = keptEvery(20);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE 'cknn%'`);
        for (const [i, id] of ALL_IDS.entries()) {
            if (!KEPT.has(id)) continue;
            await prisma.$executeRawUnsafe(
                `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
                 VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())`,
                id, randomUnit(i),
            );
        }
        expect(await throughIndex()).toBe(true);
        const rows = await searchTracksByEmbedding(QUERY, 50);
        expect(rows).toHaveLength(50);
        expect(rows.every((r) => KEPT.has(r.id))).toBe(true);
        expect(bestFirst(rows)).toBe(true);
    });
});
