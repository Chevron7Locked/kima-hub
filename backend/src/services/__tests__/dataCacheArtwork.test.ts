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

        it("returns null when no source had an image", async () => {
            await seedArtist("Nobody", null);

            expect(await dataCacheService.getArtistImage(ARTIST, "Nobody", null)).toBeNull();
            expect(mockDownloadAndStoreImage).not.toHaveBeenCalled();
        });
    });
});
