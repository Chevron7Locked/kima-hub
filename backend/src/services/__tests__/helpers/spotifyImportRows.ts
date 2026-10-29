import { prisma } from "../../../utils/db";

/** Removes the playlists, listeners and library rows whose ids start with `prefix`. */
export async function removeImportRows(prefix: string) {
    await prisma.$executeRawUnsafe(`DELETE FROM "Playlist" WHERE id LIKE '${prefix}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${prefix}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${prefix}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${prefix}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${prefix}%'`);
}

/** An artist with one album holding `titles`; `normalizedName` is the form the library stores for the artist. */
export async function artistWithTracks(prefix: string, key: string, name: string, titles: string[], normalizedName: string) {
    await prisma.artist.create({
        data: { id: `${prefix}${key}`, name, normalizedName, identityKey: `${prefix}-${key}` },
    });
    await prisma.album.create({
        data: { id: `${prefix}${key}alb`, artistId: `${prefix}${key}`, rgMbid: `${prefix}-rg-${key}`, primaryType: "Album", title: `${name} Album` },
    });
    for (const [i, title] of titles.entries()) {
        await prisma.track.create({
            data: {
                id: `${prefix}${key}t${i}`, albumId: `${prefix}${key}alb`, title, trackNo: i + 1, duration: 200,
                filePath: `/tmp/${prefix}-${key}-${i}.flac`, fileModified: new Date(), fileSize: 1000,
            },
        });
    }
}
