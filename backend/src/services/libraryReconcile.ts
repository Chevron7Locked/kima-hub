/**
 * Library reconcile (`delete` mode): retire tracks an earlier scan flagged missing and this
 * scan still cannot find. Every retirement is snapshotted to RemovalLog (with its cache
 * artifacts) before the delete, and a mass disappearance stands the sweep down. A song whose plays would move while a
 * listener's play history is being repaired is left for the next sweep, never waited for; so is a song whose stage
 * records or row another job holds at that moment. A retired song hands its history (plays, likes, playlist places,
 * bookmarks) to the best copy of the same song on a library album, a corrupt one included and a Discover one never; it
 * leaves every saved queue, or is replaced there by the best copy a person can play (a queue is never pointed at a file
 * that cannot play).
 *
 * Every list of ids goes to the database as one array parameter (`= ANY(${ids}::text[])`): a statement takes at most
 * 32767 bind parameters, and a library that lost a drive can retire more songs than that in one sweep.
 *
 * Locks, in the order every other writer of a song's rows takes them (its stage records, then its row): the sweep takes
 * each with SKIP LOCKED, so it never waits for a job that holds one half of a song and wants the other, and holds them
 * only from just before it moves plays until the commit.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { retryOnDeadlock } from "../utils/dbConflict";
import { nodeClock } from "../utils/nodeClock";
import { announcePlaylistsChanged, playlistsHoldingTrackIds, type HeldPlaylist } from "./playlistEvents";
import { songsWithBusyPlayHistory } from "./playRecording";
import { entriesOf, hydrateQueue, type QueueEntry } from "./savedQueue";

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

/**
 * A missing song and the copies of the same song that take over from it: `history` is the best copy on a library album
 * (a corrupt one counts: its history waits there for a fixed file), `queue` the best of those a person can play, or
 * null when none can be played. They are the same copy whenever a playable one exists.
 */
interface Replacement {
    gone: string;
    history: string;
    queue: string | null;
}

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
    const flagged = await tx.track.findMany({
        where: { missingSince: { not: null, lt: scanStartedAt } },
        select: {
            id: true,
            filePath: true,
            title: true,
            album: { select: { title: true, artist: { select: { name: true } } } },
        },
    });
    if (flagged.length === 0) return { removed: 0, artifacts: [], playlists: [] };
    const flaggedIds = flagged.map((t) => t.id);

    // What needs no lock is read before any is taken, so they are held for as short a time as they can be.
    const replacements = await findReplacements(tx, flaggedIds);
    const caches = await tx.$queryRaw<Array<{ trackId: string; cachePath: string }>>`
        SELECT "trackId", "cachePath" FROM "TranscodedFile" WHERE "trackId" = ANY(${flaggedIds}::text[])`;

    const missing = await holdSongs(tx, flagged, scanStartedAt);
    if (missing.length === 0) return { removed: 0, artifacts: [], playlists: [] };

    // A song whose plays move to another copy waits for no repair of its listeners' history (a scan never blocks behind
    // a per-user maintenance job): it stays exactly as it is for the next sweep, and the rest carry on.
    const heldIds = new Set(missing.map((t) => t.id));
    const busy = await songsWithBusyPlayHistory(tx, replacements.filter((p) => heldIds.has(p.gone)).map((p) => p.gone));
    const retiring = missing.filter((t) => !busy.has(t.id));
    const retiringIds = new Set(retiring.map((t) => t.id));
    // The copies that take over are held from here until the commit: a copy deleted between choosing and moving would
    // fail the move on its foreign key, so a copy that has gone since it was chosen is no copy.
    const pairs = await holdCopies(tx, replacements.filter((p) => retiringIds.has(p.gone)));
    if (busy.size > 0) {
        logger.info(`[RECONCILE] ${busy.size} track(s) left for the next sweep: a listener's play history is being repaired`);
    }
    if (retiring.length === 0) return { removed: 0, artifacts: [], playlists: [] };

    const ids = retiring.map((t) => t.id);

    const artifactsByTrack = new Map<string, string[]>();
    for (const c of caches) {
        if (!retiringIds.has(c.trackId)) continue;
        const abs = transcodeArtifactPath(c.cachePath);
        artifactsByTrack.set(c.trackId, [...(artifactsByTrack.get(c.trackId) ?? []), abs]);
    }
    const artifacts = [...artifactsByTrack.values()].flat();

    // Every playlist holding a retiring track changes, whether its place moves to another copy or goes.
    const playlists = await playlistsHoldingTrackIds(tx, ids);

    // A file replaced by another copy of the same song (an album upgraded from mp3 to flac, say) hands its history
    // to the copy before it goes: plays, likes, playlist places, bookmarks and audit choices.
    const replacedBy = await carryHistoryToReplacements(tx, pairs);
    const queueCopy = new Map(pairs.flatMap((p) => (p.queue ? [[p.gone, p.queue] as const] : [])));

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
    await tx.$executeRaw`UPDATE "DiscoveryTrack" SET "trackId" = NULL WHERE "trackId" = ANY(${ids}::text[])`;
    await updatePlaybackStates(tx, ids, queueCopy);

    await tx.$executeRaw`DELETE FROM "Track" WHERE id = ANY(${ids}::text[])`;

    // Then every genre left with no songs goes, library-wide (only when songs were retired).
    await tx.genre.deleteMany({ where: { trackGenres: { none: {} } } });

    logger.info(`[RECONCILE] retired ${ids.length} track(s) confirmed gone by consecutive scans`);
    return { removed: ids.length, artifacts, playlists };
}

/**
 * Holds the rows of the songs this sweep is about to move plays of and delete, and answers which of them it holds. A
 * play reported for a held song waits on its row (the foreign key), so from here the listeners and plays the sweep reads
 * are the song's last: none lands between moving them and deleting the song.
 *
 * The song's stage records first, then its row: the order the stage-record module takes them in, so a job answering a
 * stage for a missing song and the sweep can never each hold what the other wants. Both are taken with SKIP LOCKED: a
 * song whose records or row another job holds is not waited for, it is left for the next sweep. The condition is asked
 * again under the lock: a scan that found a file again while the sweep waited has cleared its flag, and that song stays.
 */
async function holdSongs<T extends { id: string }>(tx: Prisma.TransactionClient, flagged: T[], scanStartedAt: Date): Promise<T[]> {
    const ids = flagged.map((t) => t.id);
    // Two plain statements, not one with the lock in a subquery: the planner may stop reading a lazily consumed subquery
    // early, and a row it never reached would go unlocked. A song is unavailable when it has more stage records than
    // this transaction managed to lock.
    const lockedStages = await tx.$queryRaw<Array<{ trackId: string }>>`
        SELECT "trackId" FROM "TrackStage" WHERE "trackId" = ANY(${ids}::text[]) ORDER BY "trackId", stage FOR UPDATE SKIP LOCKED`;
    const allStages = await tx.$queryRaw<Array<{ trackId: string; n: number }>>`
        SELECT "trackId", count(*)::int AS n FROM "TrackStage" WHERE "trackId" = ANY(${ids}::text[]) GROUP BY "trackId"`;
    const lockedCount = new Map<string, number>();
    for (const r of lockedStages) lockedCount.set(r.trackId, (lockedCount.get(r.trackId) ?? 0) + 1);
    const unavailable = new Set(allStages.filter((r) => r.n > (lockedCount.get(r.trackId) ?? 0)).map((r) => r.trackId));
    const wanted = ids.filter((id) => !unavailable.has(id));

    const held = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Track"
         WHERE id = ANY(${wanted}::text[]) AND "missingSince" IS NOT NULL AND "missingSince" < ${scanStartedAt}
         ORDER BY id FOR UPDATE SKIP LOCKED`;
    const heldIds = new Set(held.map((r) => r.id));
    if (unavailable.size > 0) {
        logger.info(`[RECONCILE] ${unavailable.size} track(s) left for the next sweep: another job holds their stage records`);
    }
    return flagged.filter((t) => heldIds.has(t.id));
}

/**
 * Playback states that name a retiring song. A saved queue loses the song (or takes its playable copy, `movedTo`), and
 * the track a state names follows; a state naming the song with no queue to follow names its playable copy, or nothing. Another device sees these
 * as changes by the server: `changedBy` is left empty, which every reader shows as "Kima".
 */
async function updatePlaybackStates(tx: Prisma.TransactionClient, retired: string[], movedTo: Map<string, string>): Promise<void> {
    await updateSavedQueues(tx, retired, movedTo);
    const at = new Date();
    const gone = [...movedTo.keys()];
    const kept = gone.map((id) => movedTo.get(id)!);
    if (gone.length > 0) {
        await tx.$executeRaw`
            UPDATE "PlaybackState" s SET "trackId" = m.kept, "changedBy" = NULL, "updatedAt" = ${nodeClock(at)}
              FROM unnest(${gone}::text[], ${kept}::text[]) AS m(gone, kept)
             WHERE s."trackId" = m.gone`;
    }
    await tx.$executeRaw`
        UPDATE "PlaybackState" SET "trackId" = NULL, "changedBy" = NULL, "updatedAt" = ${nodeClock(at)}
         WHERE "trackId" = ANY(${retired}::text[])`;
}

/**
 * Brings every saved queue up to date with the retiring songs, so no queue holds an entry that fails at play time. A
 * song another copy takes over is replaced in its place by that copy, described as the copy; a song with no copy is
 * taken out. The saved index keeps pointing at the same song; when that song itself was taken out it points at the next
 * one that remains (the last, when none follows), from its start, and the track the state names follows it (empty when
 * the queue is). A queue left with nothing is emptied with its source, and a queue that held no retired song is not
 * touched. The queue rows are locked while they are read, so a save by a client cannot be overwritten with the older
 * queue.
 */
async function updateSavedQueues(tx: Prisma.TransactionClient, retired: string[], movedTo: Map<string, string>): Promise<void> {
    const states = await tx.$queryRaw<Array<{ userId: string; queue: unknown; currentIndex: number; trackId: string | null }>>`
        SELECT "userId", queue, "currentIndex", "trackId" FROM "PlaybackState"
         WHERE queue IS NOT NULL
           AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(queue) = 'array' THEN queue ELSE '[]'::jsonb END) AS entry
                  WHERE entry ->> 'id' = ANY(${retired}::text[]))
         ORDER BY "userId"
           FOR UPDATE`;
    if (states.length === 0) return;

    const gone = new Set(retired);
    const retiredEntry = (entry: unknown): entry is { id: unknown } =>
        typeof entry === "object" && entry !== null && gone.has(String((entry as { id?: unknown }).id));
    const copyIds = new Set<string>();
    for (const { queue } of states) {
        for (const entry of queue as unknown[]) {
            const copy = retiredEntry(entry) ? movedTo.get(String(entry.id)) : undefined;
            if (copy) copyIds.add(copy);
        }
    }
    const described = new Map<string, QueueEntry>((await hydrateQueue([...copyIds], tx)).map((e) => [e.id, e]));
    // What an entry becomes: itself, or for a retired one its copy, or nothing.
    const becomes = (entry: unknown): unknown[] => {
        if (!retiredEntry(entry)) return [entry];
        const copy = described.get(movedTo.get(String(entry.id)) ?? "");
        return copy ? [copy] : [];
    };

    for (const { userId, queue, currentIndex, trackId } of states) {
        const entries = queue as unknown[];
        const next = entries.flatMap(becomes);
        const current = Math.min(Math.max(currentIndex, 0), entries.length - 1);
        const nextBefore = entries.slice(0, current).flatMap(becomes).length;
        const currentDropped = becomes(entries[current]).length === 0;
        const nextIndex = Math.min(nextBefore, next.length - 1);
        // The state names the current song, so it follows the current song; one that names anything else is left.
        const namesCurrent = trackId !== null && (gone.has(trackId) || entriesOf([entries[current]])[0]?.id === trackId);
        await tx.playbackState.update({
            where: { userId },
            data:
                next.length === 0
                    ? { queue: Prisma.DbNull, queueSource: null, currentIndex: 0, position: 0, changedBy: null, ...(namesCurrent ? { trackId: null } : {}) }
                    : {
                          queue: next as Prisma.InputJsonArray,
                          currentIndex: nextIndex,
                          changedBy: null,
                          ...(currentDropped ? { position: 0 } : {}),
                          ...(namesCurrent ? { trackId: (next[nextIndex] as { id: string }).id } : {}),
                      },
        });
    }
}

/**
 * For each retiring track, the copies of the same song on the same album (same disc and track number, same title
 * ignoring case), from one candidate query: its history goes to the best copy on a library album, and its queue places
 * to the best of those a person can play. A copy on a Discover album is no copy at all (a Discover song reaches nothing
 * that is not Discover), and neither is one whose file is flagged missing (it retires itself). A corrupt copy is a
 * copy for history only: a queue or playlist is never pointed at a file a person could not play, but a fixed file has
 * its history waiting.
 *
 * Best means: playable, then a lossless codec, then the higher bitrate (file size over duration; Track keeps no
 * bitrate, and a song of unknown duration ranks last), then the lower id, so every sweep chooses the same.
 */
async function findReplacements(tx: Prisma.TransactionClient, ids: string[]): Promise<Replacement[]> {
    // Titles are compared here, not in SQL: the database lower-cases ASCII only.
    const sameSlot = await tx.$queryRaw<Array<{ gone: string; kept: string; playable: boolean; goneTitle: string; keptTitle: string }>>`
        SELECT g.id AS gone, k.id AS kept, NOT k.corrupt AS playable, g.title AS "goneTitle", k.title AS "keptTitle"
          FROM "Track" g
          JOIN "Track" k
            ON k."albumId" = g."albumId"
           AND k."trackNo" = g."trackNo"
           AND k."discNumber" IS NOT DISTINCT FROM g."discNumber"
           AND k.id <> g.id
          JOIN "Album" ka ON ka.id = k."albumId" AND ka.location = 'LIBRARY'
         WHERE g.id = ANY(${ids}::text[])
           AND k."missingSince" IS NULL
         ORDER BY g.id,
                  NOT k.corrupt DESC,
                  COALESCE(k.mime ~* '(^|[^a-z])(flac|alac|pcm|wavpack|ape|monkey|tta|dsd|lossless|wav|aiff)([^a-z]|$)', false) DESC,
                  k."fileSize"::float8 / NULLIF(k.duration, 0) DESC NULLS LAST,
                  k.id
    `;
    const pairs: Replacement[] = [];
    for (const row of sameSlot) {
        if (row.goneTitle.toLowerCase() !== row.keptTitle.toLowerCase()) continue;
        const last = pairs.at(-1);
        if (last?.gone !== row.gone) pairs.push({ gone: row.gone, history: row.kept, queue: row.playable ? row.kept : null });
        else if (last.queue === null && row.playable) last.queue = row.kept;
    }
    return pairs;
}

/**
 * Holds the copies chosen to take over, and answers the pairs whose copies are still there. A key share lock: it stops
 * a delete or key change of the copy until the sweep commits, and nothing a stage move or a scan writes to an ordinary
 * column. Taken after the retiring songs' own rows (a copy is never a retiring song, so the two never meet), in id
 * order, and never waited for in earnest: only a delete holds it up, and a deleted copy is no copy.
 */
async function holdCopies(tx: Prisma.TransactionClient, pairs: Replacement[]): Promise<Replacement[]> {
    if (pairs.length === 0) return pairs;
    const wanted = [...new Set(pairs.flatMap((p) => (p.queue ? [p.history, p.queue] : [p.history])))].sort();
    const held = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Track" WHERE id = ANY(${wanted}::text[]) ORDER BY id FOR KEY SHARE`;
    const heldIds = new Set(held.map((r) => r.id));
    return pairs
        .filter((p) => heldIds.has(p.history))
        .map((p) => ({ ...p, queue: p.queue !== null && heldIds.has(p.queue) ? p.queue : null }));
}

/**
 * Moves the history of each replaced song onto its copy. A user's like, bookmark or audit choice already on the
 * copy stays as it is, and the retiring row's duplicate goes with it. Every playlist entry moves, a playlist holding
 * the copy as well now holding it twice. The caller holds the shared play-history lock of every listener whose plays
 * move, so a repair of that history (which reads, judges and deletes under the exclusive one) never sees it change in
 * the middle.
 */
async function carryHistoryToReplacements(tx: Prisma.TransactionClient, pairs: Replacement[]): Promise<Map<string, string>> {
    for (const { gone, history: kept } of pairs) {
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
    return new Map(pairs.map((p) => [p.gone, p.history]));
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
    // A deadlock with another job's transaction (the sweep takes its locks without waiting, but the cascade of a delete
    // reaches rows other jobs write) rolls the whole sweep back, so it runs once more.
    const res = await retryOnDeadlock("the library sweep",() =>
        prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt), { timeout: 120_000 }),
    );
    await unlinkArtifacts(res.artifacts);
    announcePlaylistsChanged(res.playlists);
    return { ...res, skipped: false };
}
