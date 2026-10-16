/**
 * `/cover-art/native:<id>.jpg` (file missing on disk) and `/album-cover/:mbid`
 * go through `artwork.ts`; the latter looks up the album so Deezer can be
 * searched by artist and title. Failure and boundary paths first.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        album: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: any, _res: any, next: any) => next(),
    apiLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../utils/colorExtractor", () => ({
    extractColorsFromImage: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: "/tmp/kima-test-cache/transcodes" } },
    USER_AGENT: "Kima/test",
}));

const mockFindAlbumArtwork = jest.fn();
jest.mock("../../services/artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
}));

import express from "express";
import request from "supertest";
import fs from "fs";
import libraryCoverArtRoutes from "../library/coverArt";
import { prisma } from "../../utils/db";

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/library", libraryCoverArtRoutes);
    return app;
}

const FOUND = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

describe("the cover-art route asks every source", () => {
    let existsSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        mockFindAlbumArtwork.mockResolvedValue(null);
        // The stored file is gone from disk -- the case that sends this route
        // looking for a replacement in the first place.
        existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
    });

    afterEach(() => existsSpy.mockRestore());

    describe("GET /cover-art/:id when the stored file has gone", () => {
        it("gives up honestly when no source has a replacement", async () => {
            (prisma.album.findUnique as jest.Mock).mockResolvedValue({
                id: "a1",
                title: "Age Of Aquarius",
                rgMbid: "rg-1",
                artist: { name: "Perturbator" },
            });

            const res = await request(makeApp()).get(
                "/library/cover-art/" + encodeURIComponent("native:a1.jpg"),
            );

            expect(res.status).toBe(404);
        });

        it("asks with the release-group id as well as the name, not Deezer alone", async () => {
            (prisma.album.findUnique as jest.Mock).mockResolvedValue({
                id: "a1",
                title: "Age Of Aquarius",
                rgMbid: "rg-1",
                artist: { name: "Perturbator" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            await request(makeApp()).get(
                "/library/cover-art/" + encodeURIComponent("native:a1.jpg"),
            );

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "rg-1",
                artistName: "Perturbator",
                albumTitle: "Age Of Aquarius",
            });
        });

        it("remembers the replacement against the album and sends the reader there", async () => {
            (prisma.album.findUnique as jest.Mock).mockResolvedValue({
                id: "a1",
                title: "Age Of Aquarius",
                rgMbid: "rg-1",
                artist: { name: "Perturbator" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const res = await request(makeApp()).get(
                "/library/cover-art/" + encodeURIComponent("native:a1.jpg"),
            );

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe(FOUND);
            expect(prisma.album.update).toHaveBeenCalledWith(
                expect.objectContaining({ data: { coverUrl: FOUND } }),
            );
        });
    });

    describe("GET /album-cover/:mbid", () => {
        it("still looks up an album whose id this app invented", async () => {
            (prisma.album.findFirst as jest.Mock).mockResolvedValue({
                title: "Reliance",
                artist: { name: "Soen" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const res = await request(makeApp()).get("/library/album-cover/temp-9");

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ coverUrl: FOUND });
        });

        it("looks the album up so the sources can search Deezer by name", async () => {
            // Given only an MBID, the sources can ask the Cover Art Archive and
            // nothing else; the album's name lets them search Deezer too.
            (prisma.album.findFirst as jest.Mock).mockResolvedValue({
                title: "Age Of Aquarius",
                artist: { name: "Perturbator" },
            });

            await request(makeApp()).get("/library/album-cover/rg-1");

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "rg-1",
                artistName: "Perturbator",
                albumTitle: "Age Of Aquarius",
            });
        });

        it("still asks for an album the library does not have a row for", async () => {
            (prisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "coverartarchive" });

            const res = await request(makeApp()).get("/library/album-cover/rg-1");

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: "rg-1",
                artistName: "",
                albumTitle: "",
            });
            expect(res.status).toBe(200);
        });

        it("says so plainly when nobody has it", async () => {
            (prisma.album.findFirst as jest.Mock).mockResolvedValue({
                title: "Age Of Aquarius",
                artist: { name: "Perturbator" },
            });

            const res = await request(makeApp()).get("/library/album-cover/rg-1");

            expect(res.status).toBe(204);
        });

        it("hands back what any source found", async () => {
            (prisma.album.findFirst as jest.Mock).mockResolvedValue({
                title: "Age Of Aquarius",
                artist: { name: "Perturbator" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });

            const res = await request(makeApp()).get("/library/album-cover/rg-1");

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ coverUrl: FOUND });
        });
    });
});
