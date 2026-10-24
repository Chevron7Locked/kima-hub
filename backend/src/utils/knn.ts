import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * hnsw.ef_search for a KNN query. The HNSW walk returns at most ef_search
 * candidates (default 40) and WHERE filters apply after it, so use twice the
 * limit, at least 100 and at most pgvector's 1000.
 */
export function efFor(limit: number): number {
    return Math.min(1000, Math.max(2 * limit, 100));
}

/**
 * The most index entries an iterative scan visits before it stops (pgvector's
 * default is 20,000). Measured on 50,000 real music-CLAP vectors right after a
 * vectors re-run, with 100 written back: 20,000 filled 40 of 50 results and
 * 40,000 filled 49.5, the most any higher value reached
 * (kima-eval-data/moods/knn_scan_2026-10-24/run.txt).
 */
export const MAX_SCAN_TUPLES = 40000;

/**
 * Run `run` in a transaction with hnsw.ef_search set to `ef` and pgvector's
 * iterative index scan on, for that transaction only. The walk alone returns
 * at most ef_search candidates and WHERE filters apply after it, so deleted
 * vectors (in the index until a vacuum) and filtered-out rows (missing songs,
 * vectors of another model) would leave a query short or empty; the iterative
 * scan keeps walking until the limit is met or MAX_SCAN_TUPLES entries are
 * visited. It uses relaxed order, which recalls better than strict order: the
 * rows can come slightly out of distance order, so the query must re-sort them
 * (pgvector 0.8 README, "Iterative Index Scans"). The query must use the `tx`
 * client: the settings do not exist on other pooled connections.
 */
export async function withEfSearch<T>(
    ef: number,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
            SELECT set_config('hnsw.ef_search', ${String(ef)}, true),
                   set_config('hnsw.iterative_scan', 'relaxed_order', true),
                   set_config('hnsw.max_scan_tuples', ${String(MAX_SCAN_TUPLES)}, true)
        `;
        return run(tx);
    });
}
