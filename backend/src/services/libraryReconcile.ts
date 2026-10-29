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
import { announcePlaylistsChanged, playlistsHoldingTracks, type HeldPlaylist } from "./playlistEvents";

interface ReconcileResult {
    removed: number;
    /** Absolute transcode-cache paths to unlink after the transaction commits. */
    artifacts: string[];
    /** Playlists that held a retired song (their entries went with it): told after the transaction commits. */
    playlists: HeldPlaylist[];
}

/** Cache paths are stored relative (audioStreaming's convention); resolve once, here. */
export function transcodeArtifactPath(cachePath: string): string {
    return path.resolve(config.music.transcodeCachePath, cachePath);
}

/**
 * The sweep stands down when more than this fraction of the library AND at least the floor are gone at once (a
 * missing drive), so a few confirmed-gone tracks still retire in a small library.
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
        return { removed: 0, artifacts: [], playlists: [] };
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
    if (missing.length === 0) return { removed: 0, artifacts: [], playlists: [] };

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

    // Every playlist holding a retiring track changes, whether its place moves to another copy or goes.
    const playlists = await playlistsHoldingTracks(tx, { id: { in: ids } });

    // A file replaced by another copy of the same song (an album upgraded from mp3 to flac, say) hands its history
    // to the copy before it goes: plays, likes, playlist places, bookmarks and audit choices.
    const replacedBy = await carryHistoryToReplacements(tx, ids);

    await tx.removalLog.createMany({
        data: missing.map((t) => ({
            filePath: t.filePath,
            title: t.title,
            artistName: t.album.artist.name,
            albumTitle: t.album.title,
            reason: replacedBy.has(t.id) ? "replaced-by-another-file" : "file-missing-confirmed",
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

    // Then every genre left with no songs goes, library-wide (only when songs were retired).
    await tx.genre.deleteMany({ where: { trackGenres: { none: {} } } });

    logger.info(`[RECONCILE] retired ${ids.length} track(s) confirmed gone by consecutive scans`);
    return { removed: ids.length, artifacts, playlists };
}

/**
 * For each retiring track, the live track that is the same song on the same album (same disc and track number,
 * same title ignoring case), and the history moved onto it. A user's like, bookmark or audit choice already on the
 * copy, or a playlist already holding it, stays as it is; the retiring row's duplicate goes with it.
 */
async function carryHistoryToReplacements(tx: Prisma.TransactionClient, ids: string[]): Promise<Map<string, string>> {
    // Titles are compared here, not in SQL: the database lower-cases ASCII only.
    const sameSlot = await tx.$queryRaw<Array<{ gone: string; kept: string; goneTitle: string; keptTitle: string }>>`
        SELECT g.id AS gone, k.id AS kept, g.title AS "goneTitle", k.title AS "keptTitle"
          FROM "Track" g
          JOIN "Track" k
            ON k."albumId" = g."albumId"
           AND k."trackNo" = g."trackNo"
           AND k."discNumber" IS NOT DISTINCT FROM g."discNumber"
           AND k."missingSince" IS NULL
           AND k.id <> g.id
         WHERE g.id IN (${Prisma.join(ids)})
         ORDER BY g.id, k.id
    `;
    const pairs: Array<{ gone: string; kept: string }> = [];
    for (const row of sameSlot) {
        if (row.goneTitle.toLowerCase() !== row.keptTitle.toLowerCase()) continue;
        if (pairs.at(-1)?.gone !== row.gone) pairs.push({ gone: row.gone, kept: row.kept });
    }
    for (const { gone, kept } of pairs) {
        await tx.play.updateMany({ where: { trackId: gone }, data: { trackId: kept } });
        await tx.$executeRaw`
            UPDATE "LikedTrack" l SET "trackId" = ${kept}
             WHERE l."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM "LikedTrack" o WHERE o."userId" = l."userId" AND o."trackId" = ${kept})`;
        await tx.$executeRaw`
            UPDATE "PlaylistItem" i SET "trackId" = ${kept}
             WHERE i."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM "PlaylistItem" o WHERE o."playlistId" = i."playlistId" AND o."trackId" = ${kept})`;
        await tx.$executeRaw`
            UPDATE subsonic_bookmarks b SET "trackId" = ${kept}
             WHERE b."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM subsonic_bookmarks o WHERE o."userId" = b."userId" AND o."trackId" = ${kept})`;
        await tx.$executeRaw`
            UPDATE "PlayAuditIgnore" a SET "trackId" = ${kept}
             WHERE a."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM "PlayAuditIgnore" o WHERE o."userId" = a."userId" AND o."trackId" = ${kept})`;
    }
    if (pairs.length > 0) logger.info(`[RECONCILE] ${pairs.length} retiring track(s) handed their history to another copy of the same song`);
    return new Map(pairs.map((p) => [p.gone, p.kept]));
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
 * The scan's reconcile step. In `delete` mode (default) it retires tracks confirmed gone
 * by consecutive scans in one transaction and unlinks their transcode artifacts after,
 * subject to the mass-missing guard. In `flag` mode it issues no query at all and changes
 * nothing — the stage is inert.
 */
export async function runReconcile(scanStartedAt: Date): Promise<ReconcileResult & { skipped: boolean }> {
    if (config.music.reconcileMode !== "delete") {
        return { removed: 0, artifacts: [], playlists: [], skipped: true };
    }
    // Retiring hundreds of tracks cascades through plays, stages and embeddings: Prisma's 5 s default would roll
    // the sweep back and fail every scan after it. The enrichment re-run allows the same for its wipe.
    const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt), { timeout: 120_000 });
    await unlinkArtifacts(res.artifacts);
    announcePlaylistsChanged(res.playlists);
    return { ...res, skipped: false };
}
