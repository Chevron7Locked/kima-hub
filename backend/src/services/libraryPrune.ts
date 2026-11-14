import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { markLibraryChangedQuietly } from "./libraryChanged";

/**
 * Albums with no songs go, then artists with no albums. An empty library album leaving changes what a client lists, so it
 * moves the library-changed marker; an empty Discover album or an artist with no albums does not (a client lists neither).
 * `libraryAlbums` is how many of the removed albums were the library's.
 */
export async function pruneEmptyAlbumsAndArtists(): Promise<{ albums: number; artists: number; libraryAlbums: number }> {
    const orphanedAlbums = await prisma.album.findMany({
        where: { tracks: { none: {} } },
        select: { id: true, location: true },
    });
    const libraryAlbums = orphanedAlbums.filter((a) => a.location === "LIBRARY").length;
    if (orphanedAlbums.length > 0) {
        logger.debug(`Removing ${orphanedAlbums.length} orphaned albums...`);
        await prisma.album.deleteMany({ where: { id: { in: orphanedAlbums.map((a) => a.id) } } });
        if (libraryAlbums > 0) await markLibraryChangedQuietly("empty library albums pruned");
    }

    const orphanedArtists = await prisma.artist.findMany({
        where: { albums: { none: {} } },
        select: { id: true, name: true },
    });
    if (orphanedArtists.length > 0) {
        logger.debug(`Removing ${orphanedArtists.length} orphaned artists: ${orphanedArtists.map((a) => a.name).join(", ")}`);
        await prisma.artist.deleteMany({ where: { id: { in: orphanedArtists.map((a) => a.id) } } });
    }
    return { albums: orphanedAlbums.length, artists: orphanedArtists.length, libraryAlbums };
}
