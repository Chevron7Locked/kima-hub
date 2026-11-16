/**
 * dataCache's album cover and artist image go through `artwork.ts`. The album
 * lookup reads title and artist from the real database so Deezer can be searched.
 * Failure and boundary paths first, happy path last.
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
        mget: jest.fn().mockResolvedValue([]),
        pipeline: jest.fn(() => ({ setex: jest.fn(), exec: jest.fn().mockResolvedValue([]) })),
    },
}));

const mockFindAlbumArtwork = jest.fn();
const mockFindArtistArtwork = jest.fn();
jest.mock("../artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
    // Real, not a stub: what counts as a usable id is the thing under test.
}));

const mockDownloadAndStoreImage = jest.fn();
jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: (...a: unknown[]) => mockDownloadAndStoreImage(...a),
    isNativePath: (p: string) => typeof p === "string" && p.startsWith("native:"),
}));

import { dataCacheService } from "../dataCache";
import { prisma } from "../../utils/db";
import { useShutdownCheck } from "../../utils/stopCheck";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";
import { flushShownChanges } from "../shownChanges";

const P = "zz-dataCache-";
const ALBUM = `${P}alb`;
const ARTIST = `${P}art`;
const REAL_MBID = "10e85e9b-0f07-33d4-a927-18a273f86eca";

async function wipe() {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** An artist and an album of theirs; the album has `coverUrl` when it already has a cover. */
async function seedAlbum(title: string, artistName: string, coverUrl: string | null = null) {
    await prisma.artist.create({ data: { id: `${P}albart`, name: artistName, identityKey: `${P}albart` } });
    await prisma.album.create({
        data: { id: ALBUM, artistId: `${P}albart`, title, identityKey: ALBUM, rgMbid: ALBUM, primaryType: "Album", coverUrl },
    });
}

/** An artist with no image yet. */
const seedArtist = (name: string, mbid: string | null) =>
    prisma.artist.create({ data: { id: ARTIST, name, identityKey: ARTIST, mbid } });

beforeAll(wipe);
afterAll(wipe);

const FOUND = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

describe("dataCache asks every source, not just one", () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockFindArtistArtwork.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
    });

    describe("album covers", () => {
        it("still looks for an album whose id this app invented", async () => {
            // A "temp-" id has no MusicBrainz match, but Deezer can still find
            // the album by artist and title.
            await seedAlbum("Reliance", "Soen");
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const cover = await dataCacheService.getAlbumCover(ALBUM, "temp-123");

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "temp-123",
                artistName: "Soen",
                albumTitle: "Reliance",
            });
            expect(cover).toBe(FOUND);
        });

        it("gives up only when there is nothing at all to search on", async () => {
            // no such album

            expect(await dataCacheService.getAlbumCover(ALBUM, "temp-123")).toBeNull();
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });

        it("reads the title and artist out of the database, so Deezer can be asked", async () => {
            // With the title and artist the album sources can search; without
            // them only the archive is tried.
            await seedAlbum("Age Of Aquarius", "Brad Sucks");

            await dataCacheService.getAlbumCover(ALBUM, REAL_MBID);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: REAL_MBID,
                artistName: "Brad Sucks",
                albumTitle: "Age Of Aquarius",
            });
        });

        it("stores what the sources found against the album", async () => {
            await seedAlbum("Age Of Aquarius", "Brad Sucks");
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const cover = await dataCacheService.getAlbumCover(ALBUM, REAL_MBID);

            expect(cover).toBe(FOUND);
            expect((await prisma.album.findUnique({ where: { id: ALBUM } }))?.coverUrl).toBe(FOUND);
        });

        it("returns null, and stores nothing, when no source had it", async () => {
            await seedAlbum("Age Of Aquarius", "Brad Sucks");

            expect(await dataCacheService.getAlbumCover(ALBUM, REAL_MBID)).toBeNull();
            expect((await prisma.album.findUnique({ where: { id: ALBUM } }))?.coverUrl).toBeNull();
        });

        it("still works on a real id when the album row has gone missing", async () => {
            // the album row is not there
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "coverartarchive" });

            const cover = await dataCacheService.getAlbumCover(ALBUM, REAL_MBID);

            // Nothing to ask Deezer with, but the archive only needs the id.
            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: REAL_MBID,
                artistName: "",
                albumTitle: "",
            });
            expect(cover).toBe(FOUND);
        });

        it("never asks anyone when the album already has a cover", async () => {
            await seedAlbum("Age Of Aquarius", "Brad Sucks", "native:albums/a1.jpg");

            expect(await dataCacheService.getAlbumCover(ALBUM, REAL_MBID)).toBe(
                "native:albums/a1.jpg",
            );
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });
    });

    describe("artist images", () => {
        it("goes through the one door rather than its own hand-rolled chain", async () => {
            await seedArtist("Brad Sucks", "9c070e4f-28c1-4b98-b371-d8514c31ba55");
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });
            mockDownloadAndStoreImage.mockResolvedValue("native:artists/x1.jpg");

            const image = await dataCacheService.getArtistImage(ARTIST, "Brad Sucks", "9c070e4f-28c1-4b98-b371-d8514c31ba55");

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Brad Sucks",
                mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55",
            });
            expect(image).toBe("native:artists/x1.jpg");
        });

        it("does not hand a placeholder MBID to the sources", async () => {
            // A "temp-" id is this app's own invention, not a MusicBrainz id;
            // Fanart would 404 on every one of them.
            await seedArtist("Brad Sucks", "temp-9");
            mockFindArtistArtwork.mockResolvedValue(null);

            await dataCacheService.getArtistImage(ARTIST, "Brad Sucks", "temp-9");

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Brad Sucks",
                mbid: undefined,
            });
        });

        it("falls back to the address itself when the local copy cannot be written", async () => {
            await seedArtist("Brad Sucks", "9c070e4f-28c1-4b98-b371-d8514c31ba55");
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            mockDownloadAndStoreImage.mockResolvedValue(null);

            expect(await dataCacheService.getArtistImage(ARTIST, "Brad Sucks", "9c070e4f-28c1-4b98-b371-d8514c31ba55")).toBe(FOUND);
        });

        it("hands the image download a signal that aborts when the shutdown begins", async () => {
            await seedArtist("Brad Sucks", null);
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            let begun = false;
            useShutdownCheck(() => begun);
            let seen: AbortSignal | undefined;
            mockDownloadAndStoreImage.mockImplementation(async (_url, _id, _type, signal?: AbortSignal) => {
                seen = signal;
                begun = true;
                await new Promise((resolve) => setTimeout(resolve, 300));
                return null;
            });

            try {
                await dataCacheService.getArtistImage(ARTIST, "Brad Sucks", null);
                expect(seen).toBeInstanceOf(AbortSignal);
                expect(seen!.aborted).toBe(true);
            } finally {
                useShutdownCheck(() => false);
            }
        });

        it("returns null when no source had an image", async () => {
            await seedArtist("Nobody", null);

            expect(await dataCacheService.getArtistImage(ARTIST, "Nobody", null)).toBeNull();
            expect(mockDownloadAndStoreImage).not.toHaveBeenCalled();
        });
    });
});

/**
 * A picture the cache finds and stores for a listed artist or album is a change a Subsonic client shows: the library marker
 * moves (once per window, through services/shownChanges.ts), unless a person's own picture covers it or no client lists it.
 */
describe("dataCache found pictures and the library marker", () => {
    const withSong = (kind: "playable" | "discover") =>
        prisma.track.create({
            data: { id: `${P}t`, albumId: ALBUM, title: "song", trackNo: 1, duration: 100, filePath: `${P}/01.flac`, fileModified: new Date(), fileSize: 1 },
        }).then(() => (kind === "discover" ? prisma.album.update({ where: { id: ALBUM }, data: { location: "DISCOVER" } }) : null));

    beforeEach(async () => {
        jest.clearAllMocks();
        await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
        await wipe();
        await flushShownChanges();
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockFindArtistArtwork.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
    });
    afterAll(async () => {
        await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
        await flushShownChanges();
    });

    const flushed = (work: () => Promise<unknown>) =>
        markerMoves(async () => {
            await work();
            await flushShownChanges();
        });

    it("moves the marker when an album cover is found for a listed album", async () => {
        await seedAlbum("Age Of Aquarius", "Brad Sucks");
        await withSong("playable");
        mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
        expect(await flushed(() => dataCacheService.getAlbumCover(ALBUM, REAL_MBID))).toBe(true);
    });

    it("leaves the marker when the album's own cover shows already, or the album is a discover one", async () => {
        await seedAlbum("Age Of Aquarius", "Brad Sucks");
        await withSong("playable");
        await prisma.album.update({ where: { id: ALBUM }, data: { userCoverUrl: "native:albums/mine.jpg" } });
        mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
        // The found cover is stored under the own one, which keeps showing.
        expect(await flushed(() => dataCacheService.getAlbumCover(ALBUM, REAL_MBID))).toBe(false);

        await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
        await wipe();
        await seedAlbum("Age Of Aquarius", "Brad Sucks");
        await withSong("discover");
        expect(await flushed(() => dataCacheService.getAlbumCover(ALBUM, REAL_MBID))).toBe(false);
    });

    it("moves the marker when an artist image is found for a listed artist, and not for a discover one", async () => {
        await seedAlbum("Age Of Aquarius", "Brad Sucks");
        await withSong("playable");
        mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });
        expect(await flushed(() => dataCacheService.getArtistImage(`${P}albart`, "Brad Sucks", null))).toBe(true);

        await prisma.artist.update({ where: { id: `${P}albart` }, data: { heroUrl: null } });
        await prisma.album.update({ where: { id: ALBUM }, data: { location: "DISCOVER" } });
        expect(await flushed(() => dataCacheService.getArtistImage(`${P}albart`, "Brad Sucks", null))).toBe(false);
    });
});

/** An artist shows its own picture when one is set, else the found one: an emptied own picture ("") is not a picture. */
describe("an emptied own artist picture", () => {
    const HERO = "native:artists/found.jpg";
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        mockFindArtistArtwork.mockResolvedValue(null);
    });

    it("shows the found picture on the artist page read", async () => {
        await prisma.artist.create({ data: { id: ARTIST, name: "Soen", identityKey: ARTIST, heroUrl: HERO, userHeroUrl: "" } });
        expect(await dataCacheService.getArtistImage(ARTIST, "Soen", null)).toBe(HERO);
        expect(mockFindArtistArtwork).not.toHaveBeenCalled();
    });

    it("shows the found picture in a list", async () => {
        const shown = await dataCacheService.getArtistImagesBatch([{ id: ARTIST, heroUrl: HERO, userHeroUrl: "" }]);
        expect(shown.get(ARTIST)).toBe(HERO);
    });
});
