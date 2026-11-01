/**
 * The two ways the mood step looks at the inputs of the library statistics: the full hash, which reads every eligible
 * track, and the change signal, a handful of single-table aggregates that move whenever the analysis or vector stages
 * write. state.ts hashes in full only when the signal moved (or its last full hash is old), because the full hash
 * runs inside the statistics row's lock transaction and a cycle that changed nothing should not pay for it.
 */
import { Prisma } from "@prisma/client";
import { SCORED_SONGS_RULE } from "./scoredSongs";

/** The count of eligible tracks and the hash of everything about them the statistics read. */
export async function hashInputs(tx: Prisma.TransactionClient): Promise<{ n: number; h: string }> {
    const [row] = await tx.$queryRaw<Array<{ n: number; h: string }>>`
        SELECT count(*)::int AS n,
               COALESCE(sum(hashtextextended(
                   m.track_id || ':' || extract(epoch FROM m.embedded_at)::text || ':' ||
                   COALESCE(t.arousal::text, '') || ':' || COALESCE(t.instrumentalness::text, '') || ':' ||
                   COALESCE(t.acousticness::text, '') || ':' || COALESCE(t.bpm::text, '') || ':' ||
                   COALESCE(t."bpmConfidence"::text, '') || ':' || COALESCE(t."keyScale", ''), 0)), 0)::text AS h
        FROM track_moods m
        JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
        JOIN "Track" t ON t.id = m.track_id
        WHERE ${SCORED_SONGS_RULE}
    `;
    return row;
}

/**
 * Moves when a track is added, removed, rewritten, marked corrupt or missing, or finishes analysis; when an album moves
 * between Discover and the library; or when a sound vector or its scores are written. Reads Track's `updatedAt`,
 * `analyzedAt`, `analysisStatus`, `missingSince`, `corrupt`; the vectors' `analyzed_at`; the scores' `embedded_at`; and a
 * count and `hashtext(id)` sum of LIBRARY albums (albums have no update time). Each part reads one table, none joins.
 */
export async function changeSignal(tx: Prisma.TransactionClient): Promise<string> {
    const [row] = await tx.$queryRaw<Array<{ s: string }>>`
        SELECT concat_ws('|',
            (SELECT concat_ws(',', count(*), count(*) FILTER (WHERE "missingSince" IS NULL AND corrupt = false AND "analysisStatus" = 'completed'),
                              max("updatedAt"), max("analyzedAt")) FROM "Track"),
            (SELECT concat_ws(',', count(*), max(analyzed_at)) FROM track_embeddings),
            (SELECT concat_ws(',', count(*), max(embedded_at)) FROM track_moods),
            (SELECT concat_ws(',', count(*) FILTER (WHERE location = 'LIBRARY'),
                              COALESCE(sum(hashtext(id)) FILTER (WHERE location = 'LIBRARY'), 0)) FROM "Album")
        ) AS s
    `;
    return row.s;
}
