import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { deleteAlbums, deleteEmptyArtists } from "./library/albumDelete";

/**
 * Albums with no songs go, then artists with no albums, with their keeps (see
 * library/albumDelete.ts). It moves no library-changed marker: a client lists an album only while it holds a playable
 * song, and an artist only while one of its albums does, so what goes here was never listed.
 */
export async function pruneEmptyAlbumsAndArtists(): Promise<{ albums: number; artists: number }> {
    const orphanedAlbums = await prisma.album.findMany({
        where: { tracks: { none: {} } },
        select: { id: true },
    });
    let albums = 0;
    if (orphanedAlbums.length > 0) {
        logger.debug(`Removing ${orphanedAlbums.length} orphaned albums...`);
        albums = (await deleteAlbums(orphanedAlbums.map((a) => a.id))).albums;
    }
    return { albums, artists: await deleteEmptyArtists() };
}
