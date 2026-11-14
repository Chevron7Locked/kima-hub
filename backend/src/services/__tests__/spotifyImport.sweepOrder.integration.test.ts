/**
 * An import's first-word artist sweeps offer the matcher every song of the artists they find, in a stable order. Two
 * properties, each checked through the preview (all three sweeps of the per-song lookup) and the M3U import (its fuzzy
 * tier). Real database.
 *
 * - Nothing is cut by id: the right song is found when it has the highest id of an artist with more than 50 songs, and
 *   when the first word is a common one ("the") shared by dozens of artists with lower ids.
 * - The same song comes back whatever order the rows were inserted: 80 songs with one title, inserted highest id first,
 *   match the lowest id.
 */
import { prisma } from "../../utils/db";
import { spotifyImportService } from "../spotifyImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-sweep-order";
const USER = `${P}-user`;
const COUNT = 80;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: P } } });
}

/** The ids of the songs of `key`, lowest first. */
const idsOf = (key: string) => Array.from({ length: COUNT }, (_, n) => `${P}-${key}-${String(n).padStart(3, "0")}`);
const lowest = (key: string) => idsOf(key)[0];
const highest = (key: string) => idsOf(key)[COUNT - 1];

/**
 * An artist named `artistName` with COUNT songs inserted highest id first, so the order a scan happens to return rows
 * in is the opposite of id order. `titleOf(n)` names song n.
 */
async function seed(key: string, artistName: string, titleOf: (n: number) => string) {
    const artist = await prisma.artist.create({
        data: { name: artistName, normalizedName: artistName.toLowerCase(), identityKey: `${P}-${key}-artist` },
    });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}-album`, primaryType: "Album", title: `${P} ${key} album`, artistId: artist.id, location: "LIBRARY" },
    });
    for (let n = COUNT - 1; n >= 0; n--) {
        const id = idsOf(key)[n];
        await prisma.track.create({
            data: { id, title: titleOf(n), albumId: album.id, trackNo: n + 1, duration: 100, filePath: `/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
}

const SAME = (title: string) => () => title;
/** Distinct filler titles, with the wanted one last (so on the highest id). */
const LAST_IS = (title: string) => (n: number) => (n === COUNT - 1 ? title : `lorem ipsum ${n}`);

const previewMatch = async (artist: string, title: string) => {
    const preview = await spotifyImportService.generatePreviewFromDeezer({
        id: "d", title: "d", tracks: [{ deezerId: "t1", title, artist, album: "x" }],
    });
    return preview.matchedTracks[0].localTrack?.id ?? null;
};

let m3uCount = 0;
const m3uMatch = async (artist: string, title: string) => {
    const { playlistId } = await spotifyImportService.importFromM3U(USER, `${P}-m3u-${++m3uCount}`, [
        { filePath: `/nowhere/${P}-${m3uCount}.mp3`, durationSeconds: null, artist, title },
    ]);
    const items = await prisma.playlistItem.findMany({ where: { playlistId } });
    return items.length ? items[0].trackId : null;
};

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("an artist with more than 50 songs, the wanted one on the highest id", () => {
    it("the artist-name-holds-the-first-word sweep finds it", async () => {
        const title = `${P} one wanted`;
        await seed("one", "qzaone band", LAST_IS(title));
        expect(await previewMatch("qzaone", title)).toBe(highest("one"));
    });

    it("the artist-name-starts-with sweep finds it", async () => {
        const title = `${P} two wanted`;
        // The source artist's first five letters begin the library artist; no library artist holds its first word.
        await seed("two", "qzbtwq band", LAST_IS(title));
        expect(await previewMatch("qzbtwz", title)).toBe(highest("two"));
    });

    it("the full-credit first-word sweep finds it", async () => {
        const title = `${P} three wanted`;
        // "V.A." reads as Various Artists for the first two sweeps; only the full credit's first word finds this artist.
        await seed("three", "qzcthree v.a. band", LAST_IS(title));
        expect(await previewMatch("V.A.", title)).toBe(highest("three"));
    });

    it("the M3U fuzzy tier finds it", async () => {
        const title = `${P} four wanted`;
        await seed("four", "qzdfour band", LAST_IS(title));
        expect(await m3uMatch("qzdfour", title)).toBe(highest("four"));
    });
});

describe("a common first word shared by many artists with lower ids", () => {
    const title = `${P} common wanted`;

    beforeAll(async () => {
        // 60 other "the ..." artists, each with a song whose id sorts before the wanted artist's.
        for (let n = 0; n < 60; n++) {
            const artist = await prisma.artist.create({
                data: { name: `the qzeother ${n}`, normalizedName: `the qzeother ${n}`, identityKey: `${P}-a-other-${n}` },
            });
            const album = await prisma.album.create({
                data: { rgMbid: `${P}-a-other-${n}-rg`, identityKey: `${P}-a-other-${n}-album`, primaryType: "Album", title: `${P} other ${n}`, artistId: artist.id, location: "LIBRARY" },
            });
            await prisma.track.create({
                data: { id: `${P}-a-other-${n}`, title: `${P} other song ${n}`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${P}/a-other-${n}.flac`, fileModified: new Date(), fileSize: 1 },
            });
        }
        await seed("five", "the qzefive band", LAST_IS(title));
    });

    it("the preview finds the wanted song", async () => {
        expect(await previewMatch("The Qzefive", title)).toBe(highest("five"));
    });

    it("the M3U fuzzy tier finds the wanted song", async () => {
        expect(await m3uMatch("The Qzefive", title)).toBe(highest("five"));
    });
});

describe("80 namesake songs inserted highest id first", () => {
    it("the first-word sweeps match the same song", async () => {
        const title = `${P} six song`;
        await seed("six", "qzfsix band", SAME(title));
        expect(await previewMatch("qzfsix", title)).toBe(lowest("six"));
        expect(await previewMatch("qzfsix", title)).toBe(lowest("six"));
    });

    it("the M3U fuzzy tier matches the same song", async () => {
        const title = `${P} seven song`;
        await seed("seven", "qzgseven band", SAME(title));
        expect(await m3uMatch("qzgseven", title)).toBe(lowest("seven"));
    });
});
