/**
 * An import's first-word artist sweeps read the same candidates every run: when 60 songs share a title under namesake
 * artists, the song a source song matches does not depend on the order the rows were inserted. Checked through the
 * preview (all three sweeps of the per-song lookup) and the M3U import (its fuzzy tier). Real database.
 *
 * Prisma orders a `take` query with no `orderBy` by primary key on its own, so this passes with or without the sweeps'
 * explicit `orderBy: { id: "asc" }`; it pins the behaviour so a change of query shape cannot lose it.
 */
import { prisma } from "../../utils/db";
import { spotifyImportService } from "../spotifyImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-sweep-order";
const USER = `${P}-user`;
const COUNT = 60;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: P } } });
}

/** The ids of the 60 songs of `key`, lowest first. */
const idsOf = (key: string) => Array.from({ length: COUNT }, (_, n) => `${P}-${key}-${String(n).padStart(3, "0")}`);

/**
 * The 60 songs of `key`, one title under an artist named `artistName`, inserted highest id first so the order a scan
 * happens to return rows in is the opposite of id order.
 */
async function seed(key: string, artistName: string, title: string) {
    const artist = await prisma.artist.create({
        data: { name: artistName, normalizedName: artistName.toLowerCase(), identityKey: `${P}-${key}-artist` },
    });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}-album`, primaryType: "Album", title: `${P} ${key} album`, artistId: artist.id, location: "LIBRARY" },
    });
    for (const [n, id] of [...idsOf(key)].reverse().entries()) {
        await prisma.track.create({
            data: { id, title, albumId: album.id, trackNo: n + 1, duration: 100, filePath: `/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
}

const matchOf = async (artist: string, title: string) => {
    const preview = await spotifyImportService.generatePreviewFromDeezer({
        id: "d", title: "d", tracks: [{ deezerId: "t1", title, artist, album: "x" }],
    });
    return preview.matchedTracks[0].localTrack?.id ?? null;
};

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("60 namesake songs inserted highest id first", () => {
    it("the artist-name-contains sweep matches the same song", async () => {
        const title = `${P} one song`;
        await seed("one", "qzaone band", title);
        expect(await matchOf("qzaone", title)).toBe(idsOf("one")[0]);
        expect(await matchOf("qzaone", title)).toBe(idsOf("one")[0]);
    });

    it("the artist-name-starts-with sweep matches the same song", async () => {
        const title = `${P} two song`;
        // The source artist's first five letters begin the library artist; no library artist contains its first word.
        await seed("two", "qzbtwq band", title);
        expect(await matchOf("qzbtwz", title)).toBe(idsOf("two")[0]);
    });

    it("the full-credit first-word sweep matches the same song", async () => {
        const title = `${P} three song`;
        // "V.A." reads as Various Artists for the first two sweeps; only the full credit's first word finds this artist.
        await seed("three", "qzcthree v.a. band", title);
        expect(await matchOf("V.A.", title)).toBe(idsOf("three")[0]);
    });

    it("the M3U fuzzy tier matches the same song", async () => {
        const title = `${P} four song`;
        await seed("four", "qzdfour band", title);
        const { playlistId } = await spotifyImportService.importFromM3U(USER, `${P}-m3u`, [
            { filePath: `/nowhere/${P}-four.mp3`, durationSeconds: null, artist: "qzdfour", title },
        ]);
        const items = await prisma.playlistItem.findMany({ where: { playlistId } });
        expect(items.map((i) => i.trackId)).toEqual([idsOf("four")[0]]);
    });
});
