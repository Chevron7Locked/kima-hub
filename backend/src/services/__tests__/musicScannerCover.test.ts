/**
 * ensureAlbumCover uses art embedded in the file first, then asks every source
 * through `artwork.ts`. Failure and boundary paths first, happy path last. The album is a real row; the sources are stubbed.
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockFindAlbumArtwork = jest.fn();
jest.mock("../artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
}));

import fs from "fs";
import { MusicScannerService } from "../musicScanner";
import { prisma } from "../../utils/db";

const FOUND = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";
const FILE = "/music/Perturbator/Dangerous Days/01.flac";

const P = "zz-scannerCover-";
const ID = `${P}alb`;
const ALBUM = { id: ID, coverUrl: null as string | null, rgMbid: "rg-1" };

async function wipe() {
    await prisma.album.deleteMany({ where: { id: ID } });
    await prisma.artist.deleteMany({ where: { id: `${P}art` } });
}
const storedCover = async () => (await prisma.album.findUniqueOrThrow({ where: { id: ID } })).coverUrl;

describe("the scanner finding a cover for an album", () => {
    let scanner: any;
    let extractCoverArt: jest.Mock;
    let existsSpy: jest.SpyInstance;

    const ensure = (album = ALBUM) =>
        scanner.ensureAlbumCover(album, FILE, "Perturbator", "Dangerous Days");

    beforeAll(wipe);
    afterAll(wipe);

    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        await prisma.artist.create({ data: { id: `${P}art`, name: "Perturbator", identityKey: `${P}art` } });
        await prisma.album.create({
            data: { id: ID, artistId: `${P}art`, title: "Dangerous Days", identityKey: ID, rgMbid: ID, primaryType: "Album" },
        });
        mockFindAlbumArtwork.mockResolvedValue(null);
        extractCoverArt = jest.fn().mockResolvedValue(null);
        scanner = new (MusicScannerService as any)();
        scanner.coverArtExtractor = { extractCoverArt };
        scanner.coverCachePath = "/cache/covers";
        existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    });

    afterEach(() => existsSpy.mockRestore());

    it("does nothing at all when there is no extractor configured", async () => {
        scanner.coverArtExtractor = null;

        await ensure();

        expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        expect(await storedCover()).toBeNull();
    });

    it("leaves an album alone when its stored cover file is still on disk", async () => {
        await prisma.album.update({ where: { id: ID }, data: { coverUrl: "native:albums/alb-1.jpg" } });

        await ensure({ ...ALBUM, coverUrl: "native:albums/alb-1.jpg" });

        expect(extractCoverArt).not.toHaveBeenCalled();
        expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        expect(await storedCover()).toBe("native:albums/alb-1.jpg");
    });

    it("goes looking again when the stored cover file has gone missing", async () => {
        existsSpy.mockReturnValue(false);
        await prisma.album.update({ where: { id: ID }, data: { coverUrl: "native:albums/alb-1.jpg" } });

        await ensure({ ...ALBUM, coverUrl: "native:albums/alb-1.jpg" });

        expect(extractCoverArt).toHaveBeenCalledWith(FILE, ID);
    });

    it("asks every source, not Deezer alone, when the file carries no art", async () => {
        await ensure();

        expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
            rgMbid: "rg-1",
            artistName: "Perturbator",
            albumTitle: "Dangerous Days",
        });
    });

    it("stores what the sources found", async () => {
        mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "coverartarchive" });

        await ensure();

        expect(await storedCover()).toBe(FOUND);
    });

    it("writes nothing when no source had one", async () => {
        await ensure();

        expect(await storedCover()).toBeNull();
    });

    it("does not fail a scan because a picture could not be found", async () => {
        // A scan that dies over artwork loses the music too.
        mockFindAlbumArtwork.mockRejectedValue(new Error("every provider is down"));

        await expect(ensure()).resolves.toBeUndefined();
        expect(await storedCover()).toBeNull();
    });

    it("prefers the art embedded in the file over anything outside", async () => {
        extractCoverArt.mockResolvedValue("albums/alb-1.jpg");

        await ensure();

        expect(await storedCover()).toBe("native:albums/alb-1.jpg");
        expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
    });
});
