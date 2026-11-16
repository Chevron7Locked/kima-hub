/**
 * An artists re-run wipes every artist's enriched genres, which a Subsonic client shows on the artist, on its albums and on
 * its songs. The library change marker (services/libraryChanged.ts) moves once after the reset when a library artist
 * lost genres it showed, and stays put when nothing a client lists changed. Real suite database.
 */
import { prisma } from "../../utils/db";
import { rerunEnrichment } from "../enrichmentRestart";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zzrmk";

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

async function seed(key: string, opts: { genres: string[] | null; withSong: boolean }) {
    await prisma.artist.create({
        data: { id: `${P}-ar-${key}`, name: `${P} ${key}`, identityKey: `${P}-${key}`, ...(opts.genres && { genres: opts.genres }) },
    });
    await prisma.album.create({
        data: {
            id: `${P}-al-${key}`, artistId: `${P}-ar-${key}`, rgMbid: `${P}-rg-${key}`, title: `${P} album ${key}`,
            primaryType: "Album", location: "LIBRARY", identityKey: `${P}-al-${key}`,
        },
    });
    if (opts.withSong) {
        await prisma.track.create({
            data: {
                id: `${P}-t-${key}`, albumId: `${P}-al-${key}`, title: `${P} song`, trackNo: 1, duration: 100,
                filePath: `/music/${P}-${key}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
            },
        });
    }
}

beforeEach(cleanup);
afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("an artists re-run and the library change marker", () => {
    it("moves it once when a library artist loses the genres it showed", async () => {
        await seed("listed", { genres: ["rock"], withSong: true });
        expect(await markerMoves(() => rerunEnrichment("artists"))).toBe(true);
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: `${P}-ar-listed` } })).genres).toBeNull();
    });

    it("leaves it when the only artist with genres has no playable song", async () => {
        await seed("unlisted", { genres: ["rock"], withSong: false });
        expect(await markerMoves(() => rerunEnrichment("artists"))).toBe(false);
    });

    it("leaves it when no artist has genres to lose", async () => {
        await seed("bare", { genres: null, withSong: true });
        expect(await markerMoves(() => rerunEnrichment("artists"))).toBe(false);
    });

    it("leaves it when the person's own genres are what shows", async () => {
        await seed("own", { genres: ["rock"], withSong: true });
        await prisma.artist.update({ where: { id: `${P}-ar-own` }, data: { userGenres: ["blues"] } });
        expect(await markerMoves(() => rerunEnrichment("artists"))).toBe(false);
    });

    it("leaves it for a re-run from a step after the artists", async () => {
        await seed("later", { genres: ["rock"], withSong: true });
        expect(await markerMoves(() => rerunEnrichment("moods"))).toBe(false);
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: `${P}-ar-later` } })).genres).toEqual(["rock"]);
    });
});
