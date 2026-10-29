/**
 * The server's state in one read-only call, for admins: database, queues,
 * corrupt files and so on. The actions it offers go to the endpoints that own them.
 */

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { enrichmentFailureService } from "../enrichmentFailureService";

export interface SystemStats {
    version: string;
    uptimeSeconds: number;
    /** Round-trip in milliseconds, or null when the check failed outright. */
    db: number | null;
    redis: number | null;
    jobs: Array<{ status: string; count: number }>;
    corruptTracks: number;
    /** Tracks the scan found without a file on disk; the flag carries the time. */
    missingTracks: number;
    enrichmentFailures: number;
    library: { tracks: number; albums: number; artists: number; bytes: number };
    cache: { transcodedMb: number };
}

/** Time a probe, and report a failure as null rather than throwing the page away. */
async function timed(probe: () => Promise<unknown>): Promise<number | null> {
    const started = process.hrtime.bigint();
    try {
        await probe();
        return Number(process.hrtime.bigint() - started) / 1_000_000;
    } catch {
        return null;
    }
}

export async function systemStats(version: string): Promise<SystemStats> {
    const [db, redis, jobs, corrupt, missing, failures, library, transcoded] = await Promise.all([
        timed(() => prisma.$queryRaw`SELECT 1`),
        timed(() => redisClient.ping()),

        prisma.$queryRaw<Array<{ status: string; n: number }>>`
        SELECT status, count(*)::int AS n FROM "DownloadJob"
        WHERE cleared = false GROUP BY 1 ORDER BY n DESC`,

        prisma.track.count({ where: { corrupt: true } }),
        prisma.track.count({ where: { missingSince: { not: null } } }),
        // Track-stage failures live in TrackStage (the record the engine
        // decides from); the service adds the artist/podcast ledger rows.
        enrichmentFailureService.getFailureCounts().then((c) => c.total),

        prisma.$queryRaw<Array<{ tracks: number; albums: number; artists: number; bytes: number }>>`
        SELECT count(t.id)::int                          AS tracks,
               count(DISTINCT al.id)::int                 AS albums,
               count(DISTINCT al."artistId")::int         AS artists,
               coalesce(sum(t."fileSize"), 0)::bigint     AS bytes
        FROM "Album" al
        JOIN "Track" t ON t."albumId" = al.id
        WHERE al.location = 'LIBRARY'`,

        prisma.$queryRaw<Array<{ mb: number }>>`
        SELECT (coalesce(sum("cacheSize"), 0) / 1048576.0)::float8 AS mb FROM "TranscodedFile"`,
    ]);

    return {
        version,
        uptimeSeconds: Math.floor(process.uptime()),
        db,
        redis,
        jobs: jobs.map((j) => ({ status: j.status, count: j.n })),
          corruptTracks: corrupt,
          missingTracks: missing,
          enrichmentFailures: failures,
        library: {
            tracks: library[0]?.tracks ?? 0,
            albums: library[0]?.albums ?? 0,
            artists: library[0]?.artists ?? 0,
            // A bigint sum arrives as a BigInt; the wire wants a number.
            bytes: Number(library[0]?.bytes ?? 0),
        },
        cache: {
            transcodedMb: transcoded[0]?.mb ?? 0,
        },
    };
}
