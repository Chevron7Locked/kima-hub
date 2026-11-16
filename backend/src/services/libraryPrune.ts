import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { markLibraryChangedQuietly } from "./libraryChanged";
import { deleteAlbums, deleteEmptyArtists } from "./library/albumDelete";

/**
 * Albums with no songs go, then artists with no albums, with their keeps (see
 * library/albumDelete.ts). When it removed anything it moves the library-changed marker once, at the end: a client may
 * have listed an item a moment before its last song went, so any removal counts, and one move after them all is enough.
 */
export async function pruneEmptyAlbumsAndArtists(): Promise<{ albums: number; artists: number }> {
    const orphanedAlbums = await prisma.album.findMany({
        where: { tracks: { none: {} } },
        select: { id: true },
    });
    let albums = 0;
    if (orphanedAlbums.length > 0) {
        logger.debug(`Removing ${orphanedAlbums.length} orphaned albums...`);
        albums = (await deleteAlbums(orphanedAlbums.map((a) => a.id), { onlyEmpty: true })).albums;
    }
    const artists = await deleteEmptyArtists();
    if (albums + artists > 0) await markLibraryChangedQuietly("empty albums and artists pruned");
    return { albums, artists };
}
