/**
 * When the library a client lists last changed, the one value Subsonic's `lastModified` serves. A client compares it with
 * the one it holds and refetches its artists only when it moved, so it moves only for what a client lists: a scan that
 * added, changed, flagged missing, retired or flagged corrupt a library song (workers/processors/scanProcessor.ts), a
 * person or job that deleted or moved library songs, albums or artists (routes/library, the Discover lifecycle, prune,
 * refile, data integrity), a person's edit of a name, a picture or the genres shown (routes/enrichment.ts), and a found
 * picture that replaced the one shown (services/shownChanges.ts). What a client lists is playable
 * songs and the albums and artists holding one (utils/playableSong.ts), so a change to anything else leaves it: a
 * Discover item, a song that is missing or corrupt, an empty album. Analysis writes, Discover songs and artist syncs do
 * not move it either, and it never goes backwards. It is stored in the system settings, so every process reads the same one.
 * Changes the coalescing window of services/shownChanges.ts still held when the server stopped are lost with it, so every
 * start moves the marker once (`markLibraryChangedAtStart`) and a client refetches rather than keep a stale list.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { readSystemSettingsFresh, saveSystemSettings } from "../utils/systemSettings";

/** The moment of the last change, in milliseconds since the epoch; 0 before settings exist. */
export async function libraryChangedAt(): Promise<number> {
    const row = await readSystemSettingsFresh("libraryChangedAt");
    return row?.libraryChangedAt?.getTime() ?? 0;
}

/**
 * Records that the library a client lists changed, at `at` (now). A time before the one already stored changes nothing,
 * so a clock that stepped back, or two writers, cannot make a client see the library as older. It is saved through
 * saveSystemSettings, the one settings writer, which keeps the later of the stored and the given time under the row's
 * lock, drops the settings cache and tells the in-process listeners.
 */
export async function markLibraryChanged(at: Date = new Date()): Promise<void> {
    await saveSystemSettings({ libraryChangedAt: at });
}

/**
 * `markLibraryChanged` for a change that is already done: a marker that cannot be written is logged and does not undo or
 * fail the removal, move or scan that happened. `what` names the change in that log line.
 */
export async function markLibraryChangedQuietly(what: string): Promise<void> {
    await markLibraryChanged().catch((e) => logger.error(`Failed to record the library change (${what}):`, e));
}

/** The start-up move: what a client lists may have changed in a window that died with the last process. */
export const markLibraryChangedAtStart = () => markLibraryChangedQuietly("server start");

const holdsPlayableSong = async (where: Prisma.TrackWhereInput): Promise<boolean> =>
    (await prisma.track.findFirst({ where: { AND: [PLAYABLE_SONG, where] }, select: { id: true } })) !== null;

/**
 * A shown name changed, and the marker moves when a client lists the item (`listed`). The edit is already saved, so a
 * check or a write that fails is logged under `what` and never fails the request that made the edit.
 */
export async function markLibraryChangedIfListed(listed: () => Promise<boolean>, what: string): Promise<void> {
    let moves: boolean;
    try {
        moves = await listed();
    } catch (e) {
        logger.error(`Failed to check whether a client lists the item (${what}):`, e);
        return;
    }
    if (moves) await markLibraryChangedQuietly(what);
}

/** Whether a client lists the song: it is playable. Ask before a delete or an edit, for a row that is gone cannot be asked. */
export const songIsListed = (songId: string) => holdsPlayableSong({ id: songId });

/** Whether a client lists the album: it holds a playable song. */
export const albumIsListed = (albumId: string) => holdsPlayableSong({ albumId });

/** Whether a client lists the artist: one of its albums holds a playable song. */
export const artistIsListed = (artistId: string) => holdsPlayableSong({ album: { artistId } });

/** Whether a client lists any of these artists: one of their albums holds a playable song. One query, for a batch of ids. */
export const anyArtistIsListed = (artistIds: string[]) => holdsPlayableSong({ album: { artistId: { in: artistIds } } });

/** Whether a client lists any of these albums: it holds a playable song. One query, for a batch of ids. */
export const anyAlbumIsListed = (albumIds: string[]) => holdsPlayableSong({ albumId: { in: albumIds } });
