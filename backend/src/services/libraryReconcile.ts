/**
 * Library reconcile: retire tracks whose files have been gone past the grace period.
 * The scanner's missing-file flagging stays the only detector; this is the decision
 * that acts on it, in `delete-after-grace` mode. It runs inside the caller's
 * transaction, before the orphaned-album/artist steps, so empty parents cascade free.
 * Every removal is snapshotted into RemovalLog before the delete — the memory of the
 * track survives the row, and the artifact manifest lets a crash gap be re-cleaned.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

export interface ReconcileResult {
    removed: number;
    /** Absolute transcode-cache paths to unlink after the transaction commits. */
    artifacts: string[];
}

/** Cache paths are stored relative (audioStreaming's convention); resolve once, here. */
export function transcodeArtifactPath(cachePath: string): string {
    return path.resolve(config.music.transcodeCachePath, cachePath);
}

export async function reconcileDeletedTracks(
    tx: Prisma.TransactionClient,
    graceCutoff: Date
): Promise<ReconcileResult> {
    const missing = await tx.track.findMany({
        where: { missingSince: { not: null, lt: graceCutoff } },
        select: {
            id: true,
            filePath: true,
            title: true,
            album: { select: { title: true, artist: { select: { name: true } } } },
        },
    });
    if (missing.length === 0) return { removed: 0, artifacts: [] };

    const ids = missing.map((t) => t.id);

    const caches = await tx.transcodedFile.findMany({
        where: { trackId: { in: ids } },
        select: { trackId: true, cachePath: true },
    });
    const artifactsByTrack = new Map<string, string[]>();
    for (const c of caches) {
        const abs = transcodeArtifactPath(c.cachePath);
        artifactsByTrack.set(c.trackId, [...(artifactsByTrack.get(c.trackId) ?? []), abs]);
    }
    const artifacts = [...artifactsByTrack.values()].flat();

    await tx.removalLog.createMany({
        data: missing.map((t) => ({
            filePath: t.filePath,
            title: t.title,
            artistName: t.album.artist.name,
            albumTitle: t.album.title,
            reason: "file-missing-grace",
            artifacts: (artifactsByTrack.get(t.id) ?? []).map((p) => ({
                table: "TranscodedFile",
                path: p,
            })),
        })),
    });

    // Soft references first: NULL, never delete — discovery rows keep their user-keep
    // history this way, and playback state keeps its queue.
    await tx.discoveryTrack.updateMany({
        where: { trackId: { in: ids } },
        data: { trackId: null },
    });
    await tx.playbackState.updateMany({
        where: { trackId: { in: ids } },
        data: { trackId: null },
    });

    await tx.track.deleteMany({ where: { id: { in: ids } } });

    // Empty-genre cleanup is library-wide, not sweep-scoped: any Genre row with no tracks
    // after the cascade is removed (a pre-existing empty genre goes too). Rows are
    // enrichment-derived and invisible to readers while empty; runs only when tracks were swept.
    await tx.genre.deleteMany({ where: { trackGenres: { none: {} } } });

    logger.info(`[RECONCILE] retired ${ids.length} track(s) past the missing-file grace period`);
    return { removed: ids.length, artifacts };
}

/** Best-effort artifact unlinking after the transaction commits; failures never block a scan. */
export async function unlinkArtifacts(artifacts: string[]): Promise<void> {
    for (const p of artifacts) {
        try {
            await fs.rm(p, { force: true });
        } catch (err: any) {
            logger.warn(`[RECONCILE] could not unlink cache artifact ${p}: ${err.message}`);
        }
    }
}

/**
 * The scan's reconcile step. In `flag` mode (default) it issues no query at all and
 * changes nothing — the stage is inert. In `delete-after-grace` mode it retires
 * grace-crossed tracks in one transaction and unlinks their transcode artifacts after.
 */
export async function runReconcile(): Promise<ReconcileResult & { skipped: boolean }> {
    if (config.music.reconcileMode !== "delete-after-grace") {
        return { removed: 0, artifacts: [], skipped: true };
    }
    const cutoff = new Date(Date.now() - config.music.reconcileGraceDays * 86_400_000);
    const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, cutoff));
    await unlinkArtifacts(res.artifacts);
    return { ...res, skipped: false };
}
