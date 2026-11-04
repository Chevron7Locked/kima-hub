import * as fs from "fs/promises";
import * as path from "path";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";

/** A scan was asked for while one ran: the scan that ran started before the flag, so another follows it (workers/index.ts). */
export const SCAN_AGAIN_KEY = "scan:again-after-vanished-file";

/**
 * Close every open stage record of a flagged-missing track as FILE_MISSING, so
 * `pending` always means work the sweep can do and the hang watchdog does not
 * fire on files that are gone. Runs over every flagged track, not just new ones.
 * The Track status columns mirror the closed records.
 */
export async function closeStagesForMissingTracks(
    client: Pick<Prisma.TransactionClient, "$queryRaw">
): Promise<number> {
    const [row] = await client.$queryRaw<Array<{ closed: number }>>`
        WITH closed AS (
            UPDATE "TrackStage" ts
               SET status = 'failed',
                   retryable = false,
                   "nextRetryAt" = NULL,
                   "startedAt" = COALESCE(ts."startedAt", now()),
                   "finishedAt" = COALESCE(ts."finishedAt", now()),
                   "failureClass" = 'FILE_MISSING',
                   "lastErrorCode" = 'FILE_MISSING',
                   "lastErrorMessage" = 'file missing from the library; a scan that finds it again re-opens this record',
                   evidence = jsonb_build_object('reason', 'file missing', 'closure', 'file-missing')
              WHERE (ts.status = 'pending'
                     OR (ts.status = 'failed' AND ts.retryable
                         AND (ts."nextRetryAt" IS NULL
                              OR ts."nextRetryAt" <= now())))
                AND ts."trackId" IN (
                    SELECT id FROM "Track" WHERE "missingSince" IS NOT NULL
                )
            RETURNING ts."trackId", ts.stage
        ), per_track AS (
            SELECT "trackId",
                   bool_or(stage = 'analysis') AS analysis,
                   bool_or(stage = 'embedding') AS embedding
              FROM closed
             GROUP BY "trackId"
        ), mirrored AS (
            UPDATE "Track" t
               SET "analysisStatus" = CASE WHEN p.analysis THEN 'permanently_failed' ELSE t."analysisStatus" END,
                   "analysisError" = CASE WHEN p.analysis THEN 'file missing' ELSE t."analysisError" END,
                   "analysisStartedAt" = CASE WHEN p.analysis THEN NULL ELSE t."analysisStartedAt" END,
                   "vibeAnalysisStatus" = CASE WHEN p.embedding THEN 'permanently_failed' ELSE t."vibeAnalysisStatus" END,
                   "vibeAnalysisError" = CASE WHEN p.embedding THEN 'file missing' ELSE t."vibeAnalysisError" END,
                   "vibeAnalysisStatusUpdatedAt" = CASE WHEN p.embedding THEN now() ELSE t."vibeAnalysisStatusUpdatedAt" END
              FROM per_track p
             WHERE t.id = p."trackId" AND (p.analysis OR p.embedding)
            RETURNING t.id
        )
        SELECT (SELECT count(*) FROM closed)::int AS closed, (SELECT count(*) FROM mirrored)::int AS mirrored`;
    return row?.closed ?? 0;
}

/**
 * A record a bulk re-ask may reopen: not running now, not parked by a person,
 * and its file is present. `alias` names the TrackStage row in the caller's SQL.
 */
export function reopenable(alias: string): string {
    return `${alias}.status NOT IN ('working', 'blocked')
        AND ${alias}."failureClass" IS DISTINCT FROM 'FILE_MISSING'
        AND NOT EXISTS (SELECT 1 FROM "Track" gone
                         WHERE gone.id = ${alias}."trackId" AND gone."missingSince" IS NOT NULL)`;
}

/**
 * Whether a song's file is really gone, not just out of reach: "no such file", with no link on its way there whose
 * target is what went missing. A link still standing with nothing behind it is a drive not mounted or a share that
 * dropped, which says nothing about the song. Any other error reading it says nothing either.
 */
export async function fileIsGone(root: string, file: string): Promise<boolean> {
    const unavailable = await fs.access(file).then(
        () => false,
        (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    );
    if (!unavailable) return false;
    const top = path.resolve(root) + path.sep;
    for (let at = path.resolve(file); at.startsWith(top); at = path.dirname(at)) {
        // The deepest thing still there ends the walk: everything above it resolves.
        if (await fs.stat(at).then(() => true, () => false)) return true;
        const standing = await fs.lstat(at).then((s) => s.isSymbolicLink(), () => false);
        if (standing) return false;
    }
    return true;
}

/**
 * An analyzer found no file for this track. It is flagged missing now and its stage records close (the reporting one
 * too), so nothing waits on it, and a library scan is asked for: the scan removes the song (and an album or artist it
 * empties) when it confirms the file is gone, or clears the flag and re-opens its records when the file is there.
 * Scans resolve paths the way the song was added and stand down when much of the library vanishes at once.
 * Gone means what `fileIsGone` says, as the scanner counts it; anything else is another kind of failure, and so is an
 * empty or unreadable music folder (a drive that is not mounted). Returns whether it flagged the track.
 */
export async function flagVanishedTrack(trackId: string, stage: string): Promise<boolean> {
    const track = await prisma.track.findUnique({ where: { id: trackId }, select: { filePath: true } });
    if (!track?.filePath) return false;
    const root = config.music.musicPath;
    if ((await fs.readdir(root).catch(() => [])).length === 0) return false;
    const file = path.isAbsolute(track.filePath) ? track.filePath : path.join(root, track.filePath);
    if (!(await fileIsGone(root, file))) return false;

    await prisma.$transaction(async (tx) => {
        await tx.track.updateMany({ where: { id: trackId, missingSince: null }, data: { missingSince: new Date() } });
        // The reporting record is in flight; as pending it is closed with the rest, its Track column mirrored.
        await tx.trackStage.updateMany({ where: { trackId, stage }, data: { status: "pending", nextRetryAt: null } });
        await closeStagesForMissingTracks(tx);
    });
    logger.info(`[Enrichment] ${track.filePath}: no file found; flagged missing and a library scan asked for`);
    const { requestScan } = await import("../workers/scanRequest");
    try {
        // A scan already running started before this flag and cannot confirm it, so the next one is noted for after it.
        if (!(await requestScan({ source: "vanished-file" })).queued) await redisClient.set(SCAN_AGAIN_KEY, "1");
    } catch (err) {
        logger.warn(`[Enrichment] Could not ask for a library scan: ${(err as Error).message}`);
    }
    return true;
}
