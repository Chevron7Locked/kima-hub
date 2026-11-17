/**
 * Deleting albums, artists and songs, and everything that must go with them. Every place that removes an album or an artist
 * (the admin delete routes, the empty-album prune, Discover's clearing, a re-file that retires an emptied album, the
 * integrity check's duplicate-artist merge) goes through here, so none of them has to remember the rest.
 *
 * What goes with an album: its songs, the Discover records pointing at those songs (`DiscoveryTrack.trackId` has no
 * foreign key, so nothing else removes them), the share links naming the album or one of its songs (a share link has
 * no foreign key either, so one left behind would dangle) and, by the database, their playlist entries. A song deleted
 * on its own (`deleteSongs`) takes the same, and the album it leaves with no song. Afterwards, once the delete
 * is committed: the playlists that held its songs are told, Discover's owned-album snapshot is rebuilt, the artist's
 * counts are recounted, and the library-changed marker moves when a client listed the album (it held a playable song).
 *
 * What "right" is for the OwnedAlbum record, a listener's keep (`artistId`, `rgMbid`, `source`):
 *
 * - A keep outlives its album. The keep is the listener's decision that this album is theirs, and Discover reads it so
 *   it never suggests or downloads the album again; a rescan can also bring the album back. So deleting a library
 *   album leaves its keep, and the integrity check reports keeps with no album rather than deleting them.
 * - A Discover album has no keep (Discover is not the library; a like moves it, and its keep is written then), so
 *   deleting one has no keep to look at.
 * - A keep lives as long as its artist, which it cannot outlive (the foreign key cascades). An artist removed because
 *   nothing of it remains (no album left: `deleteEmptyArtists`) takes its keeps with it: the scanner
 *   writes a keep for every library album, so sparing artists that hold one would leave every emptied artist behind for
 *   enrichment and search to find. An artist merged into another hands its keeps to the successor (`deleteArtists` with
 *   `keepsTo`); the more protective source stands on a clash (`ownershipRankSql`). A person deleting an artist on purpose
 *   releases its keeps too.
 *
 * What becomes of a deleted song's history is `songHistory`'s, called here before the songs go: a copy of its recording
 * on another library album takes its plays, like, playlist places and share links; with no copy its library plays stay
 * as kept plays and the rest goes with it (a Discover song's plays go with it). A delete that takes several songs of
 * one recording (an album, an artist) lets none of them be the copy, however many batches it goes in: every batch
 * is told the whole delete's songs. A delete honours the play-history lock of the listeners whose plays it moves or
 * keeps: it waits for a repair of a listener's history, except where the caller cannot wait (`deleteSongs` with
 * `canWait: false`, the library sweep), which leaves those songs alone and answers them in `left`.
 *
 * Out of this module: the song files and folders (their callers know the music root and what they may touch). Every delete
 * of albums or artists locks the rows it removes before it reads them (an artist's row, then its albums', each batch in
 * id order), so a scan filing a song into an album or an album under an artist waits for the commit and then files
 * fresh. `deleteSongs` locks its songs' albums before it deletes the songs. Where a
 * caller lists the albums or artists to delete earlier than it deletes them (the prune), `onlyEmpty` also asks again
 * under the lock at the delete, so a song or album a scan added in between is never deleted.
 *
 * `within` runs the delete inside the caller's transaction, which then owns the commit; the answer's `settle()` does
 * what follows a commit and must be called after it. Without `within` the module opens its own transaction and settles
 * itself, and `settle()` is a no-op.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { PLAYABLE_SONG } from "../../utils/playableSong";
import { announcePlaylistsChanged, playlistsHoldingTracks, type HeldPlaylist } from "../playlistEvents";
import { forgetOwnedIndex } from "../discovery/ownedIndexVersion";
import { updateArtistCounts } from "../artistCountsService";
import { markLibraryChangedQuietly } from "../libraryChanged";
import { moveOwnerArtist } from "../mbidReassign";
import { retryOnDeadlock } from "../../utils/dbConflict";
import { settleHistoryOfLeavingSongs } from "./songHistory";
import { PLAY_HISTORY_REPAIR_MAX_MS } from "../playRecording";

type Tx = Prisma.TransactionClient;

/** A statement takes at most 32767 bind parameters; ids go through in batches well under that. */
const BATCH = 5000;
// A delete that can wait for a repair of a listener's play history may wait as long as a repair may hold its lock.
const TRANSACTION_MS = PLAY_HISTORY_REPAIR_MAX_MS + 120_000;

export interface Deletion {
    /** Songs deleted by `deleteSongs`. Songs that went with their album are not counted here. */
    songs: number;
    /** Albums deleted, including those that went with an artist. */
    albums: number;
    /** Artists deleted. */
    artists: number;
    /** Songs left undeleted for a later pass, because the caller could not wait for a repair of a listener's history. */
    left: string[];
    /** What follows a commit. Already done unless `within` was given. */
    settle: () => Promise<void>;
}

/** What a delete in a transaction owes once it commits. */
interface Owed {
    songs: number;
    albums: number;
    artists: number;
    left: string[];
    playlists: HeldPlaylist[];
    recount: Set<string>;
    listed: boolean;
    what: string;
}

const emptyOwed = (what: string): Owed => ({ songs: 0, albums: 0, artists: 0, left: [], playlists: [], recount: new Set(), listed: false, what });

async function settle(owed: Owed): Promise<void> {
    announcePlaylistsChanged(owed.playlists);
    if (owed.albums > 0 || owed.artists > 0) forgetOwnedIndex();
    // The rows are gone either way; a recount that fails is caught up by the next scan's.
    for (const artistId of owed.recount) {
        await updateArtistCounts(artistId).catch((error) => logger.warn(`[Delete] Artist counts not updated after ${owed.what}:`, error));
    }
    if (owed.listed) await markLibraryChangedQuietly(owed.what);
}

async function run(within: Tx | undefined, work: (tx: Tx) => Promise<Owed>): Promise<Deletion> {
    if (within) {
        const owed = await work(within);
        return { songs: owed.songs, albums: owed.albums, artists: owed.artists, left: owed.left, settle: () => settle(owed) };
    }
    // Two deletes whose songs are copies of each other's recordings can each wait on the other's copy: the one Postgres
    // ends runs again, from the start, as the whole delete is one transaction.
    const owed = await retryOnDeadlock("a library delete", () => prisma.$transaction(work, { timeout: TRANSACTION_MS }));
    await settle(owed);
    return { songs: owed.songs, albums: owed.albums, artists: owed.artists, left: owed.left, settle: async () => {} };
}

function* batches<T>(items: T[]): Generator<T[]> {
    for (let i = 0; i < items.length; i += BATCH) yield items.slice(i, i + BATCH);
}

/**
 * The albums among `ids` (at `only`, when given; with no song left when `onlyEmpty`) with their songs, Discover records,
 * share links and album rows removed. The album rows are locked first, in id order, and everything is asked under the
 * lock: a scan adding a song to an album takes a share lock on the album row, so it either landed before the question
 * (the song goes with the album, or, for `onlyEmpty`, the album stays) or waits until this delete has committed (and
 * then fails on the album's foreign key, which a scan retries and files fresh).
 */
async function removeAlbums(
    tx: Tx,
    ids: string[],
    scope: { only?: "LIBRARY" | "DISCOVER"; onlyEmpty?: boolean },
    owed: Owed,
): Promise<void> {
    if (ids.length === 0) return;
    // Every album row is locked before anything is asked, so the songs the whole delete takes are known (and none is
    // added) before the first batch chooses a copy to hand history to.
    await tx.$queryRaw`SELECT id FROM "Album" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
    const rows: Array<{ id: string; artistId: string; _count: { tracks: number } }> = [];
    for (const batch of batches(ids)) {
        rows.push(
            ...(await tx.album.findMany({
                where: {
                    id: { in: batch },
                    ...(scope.only ? { location: scope.only } : {}),
                    ...(scope.onlyEmpty ? { tracks: { none: {} } } : {}),
                },
                select: { id: true, artistId: true, _count: { select: { tracks: true } } },
            })),
        );
    }
    if (rows.length === 0) return;
    const doomed = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Track" WHERE "albumId" = ANY(${rows.map((r) => r.id)}::text[])`;
    const leaving = doomed.map((t) => t.id);
    for (const batchRows of batches(rows)) {
        const albumIds = batchRows.map((row) => row.id);
        if (!owed.listed) {
            owed.listed = (await tx.track.findFirst({ where: { AND: [PLAYABLE_SONG, { albumId: { in: albumIds } }] }, select: { id: true } })) !== null;
        }
        for (const held of await playlistsHoldingTracks(tx, { albumId: { in: albumIds } })) {
            if (!owed.playlists.some((p) => p.playlistId === held.playlistId)) owed.playlists.push(held);
        }
        // An album with no songs counted for nothing, so its artist's counts do not move.
        for (const row of batchRows) if (row._count.tracks > 0) owed.recount.add(row.artistId);
        await tx.$executeRaw`DELETE FROM "DiscoveryTrack" WHERE "trackId" IN (SELECT id FROM "Track" WHERE "albumId" = ANY(${albumIds}::text[]))`;
        // A share link names its album or song with no foreign key, so it would outlive both. A song's link first goes
        // to a copy of its recording when there is one (the settle below), and what is left of it goes with the song.
        await tx.$executeRaw`DELETE FROM share_links WHERE "entityType" = 'album' AND "entityId" = ANY(${albumIds}::text[])`;
        const batchSongs = (await tx.track.findMany({ where: { albumId: { in: albumIds } }, select: { id: true } })).map((t) => t.id);
        await settleHistoryOfLeavingSongs(tx, batchSongs, { leaving });
        await tx.$executeRaw`DELETE FROM share_links WHERE "entityType" = 'track' AND "entityId" = ANY(${batchSongs}::text[])`;
        await tx.album.deleteMany({ where: { id: { in: albumIds } } });
        owed.albums += albumIds.length;
    }
}

/**
 * Deletes albums by id, with their songs (see the header). An id no album has is skipped. `only` deletes just the
 * albums at that location, for a caller that must never touch the other (Discover's clearing takes Discover's alone).
 * `onlyEmpty` deletes just the albums that hold no song at the moment of the delete, for a caller that listed the
 * empty ones earlier (the prune): a song added since keeps its album.
 */
export async function deleteAlbums(
    ids: string[],
    options: { within?: Tx; only?: "LIBRARY" | "DISCOVER"; onlyEmpty?: boolean } = {},
): Promise<Deletion> {
    return run(options.within, async (tx) => {
        const owed = emptyOwed("an album deleted");
        await removeAlbums(tx, ids, options, owed);
        return owed;
    });
}

/**
 * Deletes songs by id, with what points at them (see the header), and the albums they leave with no song, which go as
 * `deleteAlbums` deletes them. The songs' artists keep their keeps; an artist left with no album is the prune's to
 * remove. `detachDiscovery` is for the library sweep, which keeps a Discover record and only unnames the song in it
 * (the integrity check removes it later); any other delete removes the record. `alsoTell` names playlists the caller
 * emptied of these songs before the call (the sweep hands their places to other copies), told with the rest, once.
 * `canWait: false` is for the sweep, which never blocks behind a repair of a listener's play history: a song whose
 * listener is being repaired is left as it is and answered in `left`.
 */
export async function deleteSongs(
    ids: string[],
    options: { within?: Tx; detachDiscovery?: boolean; alsoTell?: HeldPlaylist[]; canWait?: boolean } = {},
): Promise<Deletion> {
    return run(options.within, async (tx) => {
        const owed = emptyOwed("a song deleted");
        owed.playlists.push(...(options.alsoTell ?? []));
        const albumIds = new Set<string>();
        // Every album of the whole delete is locked up front, in id order (as `removeAlbums` does): a later batch taking an
        // album while this delete holds an earlier batch's songs could meet a scan holding that album and wanting a song.
        const owning = new Set<string>();
        for (const batch of batches(ids)) {
            for (const row of await tx.track.findMany({ where: { id: { in: batch } }, select: { albumId: true } })) owning.add(row.albumId);
        }
        if (owning.size > 0) await tx.$queryRaw`SELECT id FROM "Album" WHERE id = ANY(${[...owning]}::text[]) ORDER BY id FOR UPDATE`;
        for (const batch of batches(ids)) {
            const rows = await tx.track.findMany({
                where: { id: { in: batch } },
                select: { id: true, albumId: true, album: { select: { artistId: true } } },
            });
            if (rows.length === 0) continue;
            // History follows a copy of the recording, else the plays stay (see `songHistory`). Every song of the whole
            // delete is excluded as a copy, so a later batch's song never receives it.
            const busy = await settleHistoryOfLeavingSongs(
                tx,
                rows.map((row) => row.id),
                { leaving: ids, canWait: options.canWait },
            );
            owed.left.push(...busy);
            const going = rows.filter((row) => !busy.has(row.id));
            const songIds = going.map((row) => row.id);
            if (songIds.length === 0) continue;
            if (!owed.listed) {
                owed.listed = (await tx.track.findFirst({ where: { AND: [PLAYABLE_SONG, { id: { in: songIds } }] }, select: { id: true } })) !== null;
            }
            for (const held of await playlistsHoldingTracks(tx, { id: { in: songIds } })) {
                if (!owed.playlists.some((p) => p.playlistId === held.playlistId)) owed.playlists.push(held);
            }
            for (const row of going) {
                albumIds.add(row.albumId);
                owed.recount.add(row.album.artistId);
            }
            if (options.detachDiscovery) {
                await tx.$executeRaw`UPDATE "DiscoveryTrack" SET "trackId" = NULL WHERE "trackId" = ANY(${songIds}::text[])`;
            } else {
                await tx.$executeRaw`DELETE FROM "DiscoveryTrack" WHERE "trackId" = ANY(${songIds}::text[])`;
            }
            // A share link not handed to a copy goes with its song, and then the songs go.
            await tx.$executeRaw`DELETE FROM share_links WHERE "entityType" = 'track' AND "entityId" = ANY(${songIds}::text[])`;
            await tx.$executeRaw`DELETE FROM "Track" WHERE id = ANY(${songIds}::text[])`;
            owed.songs += songIds.length;
        }
        await removeAlbums(tx, [...albumIds], { onlyEmpty: true }, owed);
        return owed;
    });
}

/**
 * Deletes artists by id, with their albums as `deleteAlbums` does. Their keeps are released, unless `keepsTo` names the
 * artist taking their place (a merge), which receives them. An id no artist has is skipped. `onlyEmpty` deletes just
 * the artists that hold no album at the moment of the delete (see `deleteAlbums`).
 */
export async function deleteArtists(
    ids: string[],
    options: { within?: Tx; keepsTo?: string; onlyEmpty?: boolean } = {},
): Promise<Deletion> {
    const { keepsTo, onlyEmpty } = options;
    return run(options.within, async (tx) => {
        const owed = emptyOwed("an artist deleted");
        const wanted = ids.filter((id) => id !== keepsTo);
        if (wanted.length === 0) return owed;
        await tx.$queryRaw`SELECT id FROM "Artist" WHERE id = ANY(${wanted}::text[]) ORDER BY id FOR UPDATE`;
        const artistIds: string[] = [];
        for (const batch of batches(wanted)) {
            const found = await tx.artist.findMany({ where: { id: { in: batch }, ...(onlyEmpty ? { albums: { none: {} } } : {}) }, select: { id: true } });
            artistIds.push(...found.map((a) => a.id));
        }
        if (artistIds.length === 0) return owed;
        const albumIds: string[] = [];
        for (const batch of batches(artistIds)) {
            albumIds.push(...(await tx.album.findMany({ where: { artistId: { in: batch } }, select: { id: true } })).map((a) => a.id));
        }
        // All the artists' albums go in one call, so the delete knows every song it takes (see `settleHistoryOfLeavingSongs`).
        await removeAlbums(tx, albumIds, {}, owed);
        for (const batch of batches(artistIds)) {
            if (keepsTo) {
                // The successor may have taken albums from the artist before this call, so its counts are recounted too.
                owed.recount.add(keepsTo);
                for (const keep of await tx.ownedAlbum.findMany({ where: { artistId: { in: batch } }, select: { artistId: true, rgMbid: true } })) {
                    await moveOwnerArtist(tx, keep.artistId, keepsTo, keep.rgMbid);
                }
            }
            // Their similar-artist links, and any keep not handed on, go with them (the database cascades).
            await tx.artist.deleteMany({ where: { id: { in: batch } } });
            owed.artists += batch.length;
            for (const artistId of batch) owed.recount.delete(artistId);
        }
        return owed;
    });
}

/**
 * Deletes every artist that has no album, and answers how many went. Their keeps go with them (see the header).
 */
export async function deleteEmptyArtists(): Promise<number> {
    const empty = await prisma.artist.findMany({ where: { albums: { none: {} } }, select: { id: true, name: true } });
    if (empty.length === 0) return 0;
    logger.debug(`Removing ${empty.length} artists with no albums: ${empty.map((a) => a.name).join(", ")}`);
    // Asked again inside the delete: an album a scan added to one of them since keeps it.
    return (await deleteArtists(empty.map((a) => a.id), { onlyEmpty: true })).artists;
}
