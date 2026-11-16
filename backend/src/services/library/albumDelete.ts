/**
 * Deleting albums and artists, and everything that must go with them. Every place that removes an album or an artist
 * (the admin delete routes, the empty-album prune, Discover's clearing, a re-file that retires an emptied album, the
 * integrity check's duplicate-artist merge) goes through here, so none of them has to remember the rest.
 *
 * What goes with an album: its songs, the Discover records pointing at those songs (`DiscoveryTrack.trackId` has no
 * foreign key, so nothing else removes them) and, by the database, their playlist entries. Afterwards, once the delete
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
 *   nothing of it remains (no album left: `deleteEmptyArtists`) takes its keeps with it, as it always has: the scanner
 *   writes a keep for every library album, so sparing artists that hold one would leave every emptied artist behind for
 *   enrichment and search to find. An artist merged into another hands its keeps to the successor (`deleteArtists` with
 *   `keepsTo`); the more protective source stands on a clash (`ownershipRank`). A person deleting an artist on purpose
 *   releases its keeps too.
 *
 * Out of this module: the song files and folders (their callers know the music root and what they may touch), and
 * what a deleted album's plays and likes become (the plays go with the songs, as the database does it).
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

type Tx = Prisma.TransactionClient;

/** A statement takes at most 32767 bind parameters; ids go through in batches well under that. */
const BATCH = 5000;
const TRANSACTION_MS = 120_000;

export interface Deletion {
    /** Albums deleted, including those that went with an artist. */
    albums: number;
    /** Artists deleted. */
    artists: number;
    /** What follows a commit. Already done unless `within` was given. */
    settle: () => Promise<void>;
}

/** What a delete in a transaction owes once it commits. */
interface Owed {
    albums: number;
    artists: number;
    playlists: HeldPlaylist[];
    recount: Set<string>;
    listed: boolean;
    what: string;
}

const emptyOwed = (what: string): Owed => ({ albums: 0, artists: 0, playlists: [], recount: new Set(), listed: false, what });

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
        return { albums: owed.albums, artists: owed.artists, settle: () => settle(owed) };
    }
    const owed = await prisma.$transaction(work, { timeout: TRANSACTION_MS });
    await settle(owed);
    return { albums: owed.albums, artists: owed.artists, settle: async () => {} };
}

function* batches<T>(items: T[]): Generator<T[]> {
    for (let i = 0; i < items.length; i += BATCH) yield items.slice(i, i + BATCH);
}

/** The albums among `ids` (at `only`, when given) with their songs, Discover records and album rows removed. */
async function removeAlbums(tx: Tx, ids: string[], only: "LIBRARY" | "DISCOVER" | undefined, owed: Owed): Promise<void> {
    for (const batch of batches(ids)) {
        const rows = await tx.album.findMany({
            where: { id: { in: batch }, ...(only ? { location: only } : {}) },
            select: { id: true, artistId: true, _count: { select: { tracks: true } } },
        });
        if (rows.length === 0) continue;
        const albumIds = rows.map((row) => row.id);
        if (!owed.listed) {
            owed.listed = (await tx.track.findFirst({ where: { AND: [PLAYABLE_SONG, { albumId: { in: albumIds } }] }, select: { id: true } })) !== null;
        }
        for (const held of await playlistsHoldingTracks(tx, { albumId: { in: albumIds } })) {
            if (!owed.playlists.some((p) => p.playlistId === held.playlistId)) owed.playlists.push(held);
        }
        // An album with no songs counted for nothing, so its artist's counts do not move.
        for (const row of rows) if (row._count.tracks > 0) owed.recount.add(row.artistId);
        await tx.$executeRaw`DELETE FROM "DiscoveryTrack" WHERE "trackId" IN (SELECT id FROM "Track" WHERE "albumId" = ANY(${albumIds}::text[]))`;
        await tx.album.deleteMany({ where: { id: { in: albumIds } } });
        owed.albums += albumIds.length;
    }
}

/**
 * Deletes albums by id, with their songs (see the header). An id no album has is skipped. `only` deletes just the
 * albums at that location, for a caller that must never touch the other (Discover's clearing takes Discover's alone).
 */
export async function deleteAlbums(
    ids: string[],
    options: { within?: Tx; only?: "LIBRARY" | "DISCOVER" } = {},
): Promise<Deletion> {
    return run(options.within, async (tx) => {
        const owed = emptyOwed("an album deleted");
        await removeAlbums(tx, ids, options.only, owed);
        return owed;
    });
}

/**
 * Deletes artists by id, with their albums as `deleteAlbums` does. Their keeps are released, unless `keepsTo` names the
 * artist taking their place (a merge), which receives them. An id no artist has is skipped.
 */
export async function deleteArtists(ids: string[], options: { within?: Tx; keepsTo?: string } = {}): Promise<Deletion> {
    const { keepsTo } = options;
    return run(options.within, async (tx) => {
        const owed = emptyOwed("an artist deleted");
        for (const batch of batches(ids.filter((id) => id !== keepsTo))) {
            const artistIds = (await tx.artist.findMany({ where: { id: { in: batch } }, select: { id: true } })).map((a) => a.id);
            if (artistIds.length === 0) continue;
            const albumIds = (await tx.album.findMany({ where: { artistId: { in: artistIds } }, select: { id: true } })).map((a) => a.id);
            await removeAlbums(tx, albumIds, undefined, owed);
            if (keepsTo) {
                // The successor may have taken albums from the artist before this call, so its counts are recounted too.
                owed.recount.add(keepsTo);
                for (const keep of await tx.ownedAlbum.findMany({ where: { artistId: { in: artistIds } }, select: { artistId: true, rgMbid: true } })) {
                    await moveOwnerArtist(tx, keep.artistId, keepsTo, keep.rgMbid);
                }
            }
            // Their similar-artist links, and any keep not handed on, go with them (the database cascades).
            await tx.artist.deleteMany({ where: { id: { in: artistIds } } });
            owed.artists += artistIds.length;
            for (const artistId of artistIds) owed.recount.delete(artistId);
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
    return (await deleteArtists(empty.map((a) => a.id))).artists;
}
