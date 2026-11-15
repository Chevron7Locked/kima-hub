/**
 * Library reconcile (`delete` mode): retire tracks an earlier scan flagged missing and this
 * scan still cannot find. Every retirement is snapshotted to RemovalLog (with its cache
 * artifacts) before the delete, and a mass disappearance stands the sweep down. A song whose plays would move while a
 * listener's play history is being repaired is left for the next sweep, never waited for. A retired song also leaves
 * every saved queue.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { announcePlaylistsChanged, playlistsHoldingTracks, type HeldPlaylist } from "./playlistEvents";
import { songsWithBusyPlayHistory } from "./playRecording";

interface ReconcileResult {
    /**
     * How many songs were retired. They were flagged missing by an earlier scan, which is when a client stopped
     * listing them, so retiring them changes nothing a client lists and moves no library-changed marker.
     */
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

    // Hold every song's row first. A play reported for one of them waits on its row (the foreign key), so from here the
    // listeners and plays this sweep reads are the song's last: none lands between moving them and deleting the song.
    await tx.$queryRaw`SELECT id FROM "Track" WHERE id IN (${Prisma.join(missing.map((t) => t.id))}) ORDER BY id FOR UPDATE`;

    // A song whose plays move to another copy waits for no repair of its listeners' history (a scan never blocks behind
    // a per-user maintenance job): it stays exactly as it is for the next sweep, and the rest carry on.
    const pairsFound = await findReplacements(tx, missing.map((t) => t.id));
    const busy = await songsWithBusyPlayHistory(tx, pairsFound.map((p) => p.gone));
    const retiring = missing.filter((t) => !busy.has(t.id));
    const pairs = pairsFound.filter((p) => !busy.has(p.gone));
    if (busy.size > 0) {
        logger.info(`[RECONCILE] ${busy.size} track(s) left for the next sweep: a listener's play history is being repaired`);
    }
    if (retiring.length === 0) return { removed: 0, artifacts: [], playlists: [] };

    const ids = retiring.map((t) => t.id);

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
    const replacedBy = await carryHistoryToReplacements(tx, pairs);

    await tx.removalLog.createMany({
        data: retiring.map((t) => ({
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
    await dropFromSavedQueues(tx, ids);

    await tx.track.deleteMany({ where: { id: { in: ids } } });

    // Then every genre left with no songs goes, library-wide (only when songs were retired).
    await tx.genre.deleteMany({ where: { trackGenres: { none: {} } } });

    logger.info(`[RECONCILE] retired ${ids.length} track(s) confirmed gone by consecutive scans`);
    return { removed: ids.length, artifacts, playlists };
}

/**
 * Takes the retired songs out of every saved queue, so no queue holds an entry that fails at play time. The saved
 * index keeps pointing at the same song; when that song itself was dropped it points at the next one that remains
 * (the last, when none follows), from its start. A queue left with nothing is emptied with its source, and a queue
 * that held no retired song is not touched. The queue rows are locked while they are read, so a save by a client
 * cannot be overwritten with the older queue.
 */
async function dropFromSavedQueues(tx: Prisma.TransactionClient, retired: string[]): Promise<void> {
    const states = await tx.$queryRaw<Array<{ userId: string; queue: unknown; currentIndex: number }>>`
        SELECT "userId", queue, "currentIndex" FROM "PlaybackState"
         WHERE queue IS NOT NULL
           AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(queue) = 'array' THEN queue ELSE '[]'::jsonb END) AS entry
                  WHERE entry ->> 'id' IN (${Prisma.join(retired)}))
         ORDER BY "userId"
           FOR UPDATE`;
    const gone = new Set(retired);
    const retiredEntry = (entry: unknown) =>
        typeof entry === "object" && entry !== null && gone.has(String((entry as { id?: unknown }).id));
    for (const { userId, queue, currentIndex } of states) {
        const entries = queue as unknown[];
        const kept = entries.filter((entry) => !retiredEntry(entry));
        const saved = Math.min(Math.max(currentIndex, 0), entries.length - 1);
        const keptBefore = entries.slice(0, saved).filter((entry) => !retiredEntry(entry)).length;
        const currentDropped = retiredEntry(entries[saved]);
        await tx.playbackState.update({
            where: { userId },
            data:
                kept.length === 0
                    ? { queue: Prisma.DbNull, queueSource: null, currentIndex: 0, position: 0 }
                    : {
                          queue: kept as Prisma.InputJsonArray,
                          currentIndex: Math.min(keptBefore, kept.length - 1),
                          ...(currentDropped ? { position: 0 } : {}),
                      },
        });
    }
}

/**
 * For each retiring track, the live track that is the same song on the same album (same disc and track number,
 * same title ignoring case).
 */
async function findReplacements(tx: Prisma.TransactionClient, ids: string[]): Promise<Array<{ gone: string; kept: string }>> {
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
    return pairs;
}

/**
 * Moves the history of each replaced song onto its copy. A user's like, bookmark or audit choice already on the
 * copy stays as it is, and the retiring row's duplicate goes with it. Every playlist entry moves, a playlist holding
 * the copy as well now holding it twice. The caller holds the shared play-history lock of every listener whose plays
 * move, so a repair of that history (which reads, judges and deletes under the exclusive one) never sees it change in
 * the middle.
 */
async function carryHistoryToReplacements(tx: Prisma.TransactionClient, pairs: Array<{ gone: string; kept: string }>): Promise<Map<string, string>> {
    for (const { gone, kept } of pairs) {
        await tx.play.updateMany({ where: { trackId: gone }, data: { trackId: kept } });
        await tx.$executeRaw`
            UPDATE "LikedTrack" l SET "trackId" = ${kept}
             WHERE l."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM "LikedTrack" o WHERE o."userId" = l."userId" AND o."trackId" = ${kept})`;
        await tx.$executeRaw`
            UPDATE "PlaylistItem" SET "trackId" = ${kept} WHERE "trackId" = ${gone}`;
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
