/**
 * Library reconcile (`delete` mode): retire tracks an earlier scan flagged missing and this
 * scan still cannot find. Every retirement is snapshotted to RemovalLog (with its cache
 * artifacts) before the delete, and a mass disappearance stands the sweep down.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

interface ReconcileResult {
    removed: number;
    /** Absolute transcode-cache paths to unlink after the transaction commits. */
    artifacts: string[];
}

/** Cache paths are stored relative (audioStreaming's convention); resolve once, here. */
export function transcodeArtifactPath(cachePath: string): string {
    return path.resolve(config.music.transcodeCachePath, cachePath);
}

/**
 * Above this fraction of the library absent at once, the sweep stands down — but only
 * past an absolute floor: in a ten-track library one deleted album is 10% of everything
 * and a perfectly ordinary Tuesday. Mass disappearance means both a big slice AND a
 * big count; a handful of confirmed-gone tracks retires even in a small library.
 */
const MASS_MISSING_ABORT = 0.10;
const MASS_MISSING_FLOOR = 10;

export async function reconcileDeletedTracks(
    tx: Prisma.TransactionClient,
    scanStartedAt: Date
): Promise<ReconcileResult> {
    const [totalTracks, missingEver] = await Promise.all([
        tx.track.count(),
        tx.track.count({ where: { missingSince: { not: null } } }),
    ]);
    if (totalTracks > 0 && missingEver >= MASS_MISSING_FLOOR && missingEver / totalTracks > MASS_MISSING_ABORT) {
        logger.warn(
            `[RECONCILE] ${missingEver}/${totalTracks} tracks missing at once — mass disappearance looks like a dropped mount, not a deletion; nothing retired`
        );
        return { removed: 0, artifacts: [] };
    }

    // Confirmed gone: flagged by an earlier scan, still absent this one. Files that
    // came back had their flag cleared earlier in this scan; files first missed by
    // this scan carry a stamp newer than scanStartedAt and wait for the next one.
    const missing = await tx.track.findMany({
        where: { missingSince: { not: null, lt: scanStartedAt } },
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
            reason: "file-missing-confirmed",
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

    logger.info(`[RECONCILE] retired ${ids.length} track(s) confirmed gone by consecutive scans`);
    return { removed: ids.length, artifacts };
}

/** Best-effort artifact unlinking after the transaction commits; failures never block a scan. */
async function unlinkArtifacts(artifacts: string[]): Promise<void> {
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
 * changes nothing — the stage is inert. In `delete` mode it retires tracks confirmed
 * gone by consecutive scans in one transaction and unlinks their transcode artifacts
 * after, subject to the mass-missing guard.
 */
export async function runReconcile(scanStartedAt: Date): Promise<ReconcileResult & { skipped: boolean }> {
    if (config.music.reconcileMode !== "delete") {
        return { removed: 0, artifacts: [], skipped: true };
    }
    const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt));
    await unlinkArtifacts(res.artifacts);
    return { ...res, skipped: false };
}
