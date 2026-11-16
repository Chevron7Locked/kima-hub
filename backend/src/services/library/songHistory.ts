/**
 * What becomes of a song's history when the song leaves the library, and what a returning recording gets back.
 *
 * History is what a listener built around a song: their plays, like, playlist places, share links, bookmarks and audit
 * choices. A song's history follows its recording (`Track.recordingMbid`, the MusicBrainz recording id, and nothing
 * else: no name, ISRC or fingerprint match) to the best copy of it on a library album, wherever that album is: the copy
 * a person can play, then a lossless one, then the higher bitrate, then the lower id, so every delete chooses the same.
 * A copy on a Discover album is no copy (a Discover song receives no history), nor is one whose file is missing, nor a
 * song with no recording id, which follows nothing. A like both songs had keeps the earlier `likedAt`.
 *
 * When no copy takes the history, the plays of a library song stay: `Play.trackId` is set null by the database when the
 * song goes, and `keepPlays` first writes on each play what is needed to count it (title, artist, album, recording and
 * length), in the delete's own transaction. A Discover song's plays go with it: Discover is only Discover, nothing reads
 * them, and a kept play is therefore always a library play. Likes, playlist places, share links and the rest go with the
 * song, as they always have. The listens module reads kept plays (see its header).
 *
 * A kept play whose recording a library song holds again attaches to that song (`adoptKeptPlays`): the identification
 * stage calls it as it writes a song's recording id, and the scan calls it for every recording left over, so a recording
 * that returns on a re-added or re-filed album has its plays back. A listener whose history is being repaired is skipped
 * until the next run.
 *
 * Plays move or become kept only while no repair of their listener's history runs (`lockPlayHistory`): a delete that can
 * wait takes the listener's shared lock, which waits for a repair to finish; one that cannot (the library sweep) leaves
 * the songs of a listener under repair for a later pass, and `settleHistoryOfLeavingSongs` says which.
 *
 * The functions here run inside a caller's transaction (`Tx`), after the caller holds the songs' album rows.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { losslessCodecSql } from "../../utils/audioCodec";
import { playableSongSql } from "../../utils/playableSong";
import { listenersWithBusyPlayHistory, lockPlayHistory, songsWithBusyPlayHistory } from "../playRecording";
import { keptRecordings, listenersOf } from "../stats/listens";

type Tx = Prisma.TransactionClient;

/**
 * A song leaving and the copies of it that take over: `history` is the best copy on a library album (a corrupt one
 * counts: its history waits there for a fixed file), `queue` the best of those a person can play, or null when none
 * can be played. They are the same copy whenever a playable one exists.
 */
export interface Replacement {
    gone: string;
    history: string;
    queue: string | null;
}

/** The order that chooses among copies, for a query that names the copy `k` and its album `ka`. */
export function bestCopyFirst(): Prisma.Sql {
    return Prisma.sql`(${playableSongSql("k", "ka")}) DESC,
                  (${losslessCodecSql(Prisma.sql`k.mime`)}) DESC,
                  COALESCE(k.bitrate::float8, k."fileSize"::float8 * 8 / 1000 / NULLIF(k.duration, 0)) DESC NULLS LAST,
                  k.id`;
}

/**
 * For each of `ids` that is on a library album and has a recording id (a Discover song hands its history to no one), the copies of that recording on library albums, as `Replacement`s. A copy that
 * is one of `leaving` (the songs going in the same delete) is no copy, and neither is one flagged missing. Songs with
 * no recording id, or no copy, have no entry.
 */
export async function recordingCopies(tx: Tx, ids: string[], leaving: string[] = ids): Promise<Replacement[]> {
    if (ids.length === 0) return [];
    const rows = await tx.$queryRaw<Array<{ gone: string; kept: string; playable: boolean }>>`
        SELECT g.id AS gone, k.id AS kept, (${playableSongSql("k", "ka")}) AS playable
          FROM "Track" g
          JOIN "Album" ga ON ga.id = g."albumId" AND ga.location = 'LIBRARY'
          JOIN "Track" k ON k."recordingMbid" = g."recordingMbid" AND k.id <> ALL(${leaving}::text[])
          JOIN "Album" ka ON ka.id = k."albumId" AND ka.location = 'LIBRARY'
         WHERE g.id = ANY(${ids}::text[])
           AND g."recordingMbid" IS NOT NULL
           AND k."missingSince" IS NULL
         ORDER BY g.id, ${bestCopyFirst()}`;
    return pairsOf(rows);
}

/** Folds candidate copies, best first within each leaving song, into one `Replacement` per song. */
export function pairsOf(rows: Array<{ gone: string; kept: string; playable: boolean }>): Replacement[] {
    const pairs: Replacement[] = [];
    for (const row of rows) {
        const last = pairs.at(-1);
        if (last?.gone !== row.gone) pairs.push({ gone: row.gone, history: row.kept, queue: row.playable ? row.kept : null });
        else if (last.queue === null && row.playable) last.queue = row.kept;
    }
    return pairs;
}

/**
 * Holds the copies chosen to take over, and answers the pairs whose copies are still there. A key share lock: it stops
 * a delete or key change of the copy until the transaction commits, and nothing a stage move or a scan writes to an
 * ordinary column. Taken after the leaving songs' own rows (a copy is never a leaving song, so the two never meet), in
 * id order, and never waited for in earnest: only a delete holds it up, and a deleted copy is no copy.
 */
export async function holdCopies(tx: Tx, pairs: Replacement[]): Promise<Replacement[]> {
    if (pairs.length === 0) return pairs;
    const wanted = [...new Set(pairs.flatMap((p) => (p.queue ? [p.history, p.queue] : [p.history])))].sort();
    // What the copy is now, not what the candidate query saw: a copy whose file went missing or corrupt, or whose album
    // left the library, in between is judged on the row as the lock finds it.
    const held = await tx.$queryRaw<Array<{ id: string; playable: boolean; usable: boolean }>>`
        SELECT t.id, (${playableSongSql("t", "al")}) AS playable,
               (t."missingSince" IS NULL AND al.location = 'LIBRARY') AS usable
          FROM "Track" t
          JOIN "Album" al ON al.id = t."albumId"
         WHERE t.id = ANY(${wanted}::text[])
         ORDER BY t.id
           FOR KEY SHARE OF t`;
    const usable = new Set(held.filter((r) => r.usable).map((r) => r.id));
    const playable = new Set(held.filter((r) => r.playable).map((r) => r.id));
    return pairs
        .filter((p) => usable.has(p.history))
        .map((p) => ({ ...p, queue: p.queue !== null && playable.has(p.queue) ? p.queue : null }));
}

/**
 * Moves the history of each leaving song onto its copy. A user's bookmark or audit choice already on the copy stays as
 * it is, and the leaving row's duplicate goes with it; a like both had keeps the earlier `likedAt`. Every playlist entry
 * moves, a playlist holding the copy as well now holding it twice. A share link names its song with no foreign key, so it
 * follows the song to the copy. The caller holds the shared play-history lock of every listener whose plays move, when
 * it must not wait for a repair (the sweep), so a repair never sees that history change in the middle.
 */
export async function carryHistory(tx: Tx, pairs: Replacement[]): Promise<Map<string, string>> {
    for (const { gone, history: kept } of pairs) {
        await tx.$executeRaw`UPDATE "Play" SET "trackId" = ${kept} WHERE "trackId" = ${gone}`;
        await tx.$executeRaw`
            UPDATE "LikedTrack" o SET "likedAt" = LEAST(o."likedAt", l."likedAt")
              FROM "LikedTrack" l
             WHERE l."trackId" = ${gone} AND o."trackId" = ${kept} AND o."userId" = l."userId"`;
        await tx.$executeRaw`
            UPDATE "LikedTrack" l SET "trackId" = ${kept}
             WHERE l."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM "LikedTrack" o WHERE o."userId" = l."userId" AND o."trackId" = ${kept})`;
        await tx.$executeRaw`
            UPDATE "PlaylistItem" SET "trackId" = ${kept} WHERE "trackId" = ${gone}`;
        await tx.$executeRaw`
            UPDATE share_links SET "entityId" = ${kept} WHERE "entityType" = 'track' AND "entityId" = ${gone}`;
        await tx.$executeRaw`
            UPDATE subsonic_bookmarks b SET "trackId" = ${kept}
             WHERE b."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM subsonic_bookmarks o WHERE o."userId" = b."userId" AND o."trackId" = ${kept})`;
        await tx.$executeRaw`
            UPDATE "PlayAuditIgnore" a SET "trackId" = ${kept}
             WHERE a."trackId" = ${gone}
               AND NOT EXISTS (SELECT 1 FROM "PlayAuditIgnore" o WHERE o."userId" = a."userId" AND o."trackId" = ${kept})`;
    }
    if (pairs.length > 0) logger.info(`[History] ${pairs.length} leaving song(s) handed their history to another copy of the same recording`);
    return new Map(pairs.map((p) => [p.gone, p.history]));
}

/**
 * What becomes of the plays of `ids` that no copy took. A library song's are written with what is needed to count them
 * once it is gone; a Discover song's are deleted (nothing reads them, and the database would only null them).
 */
async function keepPlays(tx: Tx, ids: string[]): Promise<void> {
    await tx.$executeRaw`
        DELETE FROM "Play"
         WHERE "trackId" IN (SELECT t.id FROM "Track" t JOIN "Album" al ON al.id = t."albumId"
                              WHERE t.id = ANY(${ids}::text[]) AND al.location = 'DISCOVER')`;
    await tx.$executeRaw`
        UPDATE "Play" p
           SET "keptTitle" = COALESCE(t."displayTitle", t.title),
               "keptArtistName" = ar.name,
               "keptAlbumTitle" = al.title,
               "keptRecordingMbid" = t."recordingMbid",
               "keptDuration" = t.duration
          FROM "Track" t
          JOIN "Album" al ON al.id = t."albumId"
          JOIN "Artist" ar ON ar.id = al."artistId"
         WHERE p."trackId" = t.id AND t.id = ANY(${ids}::text[])`;
}

/**
 * Settles the history of songs about to be deleted, in the delete's transaction and before the delete: what has a
 * copy of its recording on another library album hands its history to it, and what has not leaves its library plays
 * kept (a Discover song's plays are deleted). The caller holds the songs' album rows.
 *
 * `leaving` is every song the whole delete takes, which may be more than `ids` (a delete that goes in batches): none of
 * them is a copy, so a history never moves onto a song a later batch deletes. It defaults to `ids`.
 *
 * The songs' rows are locked here, and then every listener's shared play-history lock is taken: `canWait` (the default)
 * waits for a repair of a listener's history, `canWait: false` never waits and instead answers the songs it left
 * untouched because their listener is being repaired, which the caller must not delete yet. Locks taken are held to the
 * end of the transaction.
 */
export async function settleHistoryOfLeavingSongs(
    tx: Tx,
    ids: string[],
    options: { leaving?: string[]; canWait?: boolean } = {},
): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    // A waiting delete takes each listener's history lock before the song rows, the order a recording takes them in (the
    // history lock, then the row its play needs): the other order could deadlock with a repair queued between them.
    const locked = new Set<string>();
    const lockListeners = async () => {
        for (const userId of new Set((await listenersOf(tx, ids)).map((p) => p.userId))) {
            if (locked.has(userId)) continue;
            locked.add(userId);
            await lockPlayHistory(tx, userId);
        }
    };
    if (options.canWait !== false) await lockListeners();
    // A play recorded for a song waits on its row, so the listeners read below are all the song has in this transaction.
    await tx.$queryRaw`SELECT id FROM "Track" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
    let busy = new Set<string>();
    if (options.canWait === false) {
        busy = await songsWithBusyPlayHistory(tx, ids);
    } else {
        // A listener whose play landed between the first read and the row locks.
        await lockListeners();
    }
    const settling = busy.size > 0 ? ids.filter((id) => !busy.has(id)) : ids;
    const played = [...new Set((await listenersOf(tx, settling)).map((p) => p.trackId))];
    const withHistory = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM "Track" t
         WHERE t.id = ANY(${settling}::text[]) AND t."recordingMbid" IS NOT NULL
           AND (t.id = ANY(${played}::text[])
             OR EXISTS (SELECT 1 FROM "LikedTrack" x WHERE x."trackId" = t.id)
             OR EXISTS (SELECT 1 FROM "PlaylistItem" x WHERE x."trackId" = t.id)
             OR EXISTS (SELECT 1 FROM share_links x WHERE x."entityType" = 'track' AND x."entityId" = t.id)
             OR EXISTS (SELECT 1 FROM subsonic_bookmarks x WHERE x."trackId" = t.id)
             OR EXISTS (SELECT 1 FROM "PlayAuditIgnore" x WHERE x."trackId" = t.id))`;
    const copies = await holdCopies(tx, await recordingCopies(tx, withHistory.map((r) => r.id), options.leaving ?? ids));
    await carryHistory(tx, copies);
    await keepPlays(tx, settling);
    return busy;
}

/**
 * Attaches kept plays to the library song that now holds their recording: the best copy, as everywhere. `mbids` narrows
 * it to those recordings (the identification stage, naming the one it just wrote); left out, every recording a kept play
 * carries. Answers how many plays attached. A song flagged missing takes none.
 *
 * A listener whose play history is being repaired is skipped for this run (it never waits, as a scan must not block
 * behind a per-user maintenance job): their plays stay kept, and the next scan or identification attaches them. The
 * others' shared history locks are held until the end. Runs in `db`'s transaction when given one, else in its own.
 */
export async function adoptKeptPlays(db: Tx | typeof prisma = prisma, mbids?: string[]): Promise<number> {
    const attach = async (tx: Tx): Promise<number> => {
        const kept = await keptRecordings(tx, mbids);
        if (kept.length === 0) return 0;
        const busy = await listenersWithBusyPlayHistory(tx, kept.map((k) => k.userId));
        if (busy.size > 0) {
            logger.info(`[HISTORY] kept plays of ${busy.size} listener(s) left for the next run: their play history is being repaired`);
        }
        const free = kept.filter((k) => !busy.has(k.userId));
        if (free.length === 0) return 0;
        const listeners = [...new Set(free.map((k) => k.userId))];
        const recordings = [...new Set(free.map((k) => k.recordingMbid))];
        return tx.$executeRaw`
        UPDATE "Play" p
           SET "trackId" = c.id, "keptTitle" = NULL, "keptArtistName" = NULL, "keptAlbumTitle" = NULL,
               "keptRecordingMbid" = NULL, "keptDuration" = NULL
          FROM (
                SELECT DISTINCT ON (k."recordingMbid") k.id, k."recordingMbid"
                  FROM "Track" k
                  JOIN "Album" ka ON ka.id = k."albumId" AND ka.location = 'LIBRARY'
                 WHERE k."missingSince" IS NULL AND k."recordingMbid" = ANY(${recordings}::text[])
                 ORDER BY k."recordingMbid", ${bestCopyFirst()}
          ) c
         WHERE p."trackId" IS NULL AND p."keptTitle" IS NOT NULL AND p."keptRecordingMbid" = c."recordingMbid"
           AND p."userId" = ANY(${listeners}::text[])`;
    };
    if (db !== prisma) return attach(db as Tx);
    try {
        return await prisma.$transaction(attach);
    } catch (error) {
        // The chosen song was deleted between the question and the write (the foreign key says so): the plays stay kept,
        // and the next scan or identification asks again.
        if ((error as { meta?: { code?: unknown } }).meta?.code === "23503") return 0;
        throw error;
    }
}
