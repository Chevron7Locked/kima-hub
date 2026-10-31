import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/** Albums with no songs go, then artists with no albums. */
export async function pruneEmptyAlbumsAndArtists(): Promise<{ albums: number; artists: number }> {
    const orphanedAlbums = await prisma.album.findMany({
        where: { tracks: { none: {} } },
        select: { id: true },
    });
    if (orphanedAlbums.length > 0) {
        logger.debug(`Removing ${orphanedAlbums.length} orphaned albums...`);
        await prisma.album.deleteMany({ where: { id: { in: orphanedAlbums.map((a) => a.id) } } });
    }

    const orphanedArtists = await prisma.artist.findMany({
        where: { albums: { none: {} } },
        select: { id: true, name: true },
    });
    if (orphanedArtists.length > 0) {
        logger.debug(`Removing ${orphanedArtists.length} orphaned artists: ${orphanedArtists.map((a) => a.name).join(", ")}`);
        await prisma.artist.deleteMany({ where: { id: { in: orphanedArtists.map((a) => a.id) } } });
    }
    return { albums: orphanedAlbums.length, artists: orphanedArtists.length };
}
