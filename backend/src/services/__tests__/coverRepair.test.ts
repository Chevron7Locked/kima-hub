/**
 * Cover Repair Tests
 *
 * Tests the repairBrokenCovers flow: identifies native paths pointing
 * to missing files and clears them for re-fetch.
 *
 * Run with: npx jest coverRepair.test --no-coverage
 */

import fs from "fs";
import path from "path";

jest.mock("../../config", () => ({
    config: {
        music: {
            transcodeCachePath: "/tmp/kima-cover-repair-test/transcode",
        },
    },
    USER_AGENT: "Kima/test",
}));

const mockFindManyArtist = jest.fn();
const mockUpdateArtist = jest.fn().mockResolvedValue({});
const mockFindManyAlbum = jest.fn();
const mockUpdateAlbum = jest.fn().mockResolvedValue({});

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: mockFindManyArtist,
            update: mockUpdateArtist,
        },
        album: {
            findMany: mockFindManyAlbum,
            update: mockUpdateAlbum,
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        del: jest.fn().mockResolvedValue(1),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { repairBrokenCovers } from "../imageBackfill";

describe("repairBrokenCovers", () => {
    const coversBase = "/tmp/kima-cover-repair-test/covers";

    beforeAll(() => {
        fs.mkdirSync(path.join(coversBase, "artists"), { recursive: true });
        fs.mkdirSync(path.join(coversBase, "albums"), { recursive: true });
    });

    afterAll(() => {
        fs.rmSync("/tmp/kima-cover-repair-test", { recursive: true, force: true });
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("clears heroUrl for artists with missing native files", async () => {
        mockFindManyArtist.mockResolvedValue([
            { id: "a1", name: "Missing Artist", heroUrl: "native:artists/a1.jpg" },
        ]);
        mockFindManyAlbum.mockResolvedValue([]);

        const result = await repairBrokenCovers();

        expect(result.artistsRepaired).toBe(1);
        expect(mockUpdateArtist).toHaveBeenCalledWith({
            where: { id: "a1" },
            data: { heroUrl: null, enrichmentStatus: "pending", lastEnriched: null },
        });
    });

    it("skips artists with existing native files", async () => {
        const filePath = path.join(coversBase, "artists", "a2.jpg");
        fs.writeFileSync(filePath, "fake image data here!");

        mockFindManyArtist.mockResolvedValue([
            { id: "a2", name: "Existing Artist", heroUrl: "native:artists/a2.jpg" },
        ]);
        mockFindManyAlbum.mockResolvedValue([]);

        const result = await repairBrokenCovers();

        expect(result.artistsRepaired).toBe(0);
        expect(mockUpdateArtist).not.toHaveBeenCalled();
    });

    it("clears coverUrl for albums with missing native files", async () => {
        mockFindManyArtist.mockResolvedValue([]);
        mockFindManyAlbum.mockResolvedValue([
            { id: "alb1", title: "Missing Album", coverUrl: "native:albums/alb1.jpg" },
        ]);

        const result = await repairBrokenCovers();

        expect(result.albumsRepaired).toBe(1);
        expect(mockUpdateAlbum).toHaveBeenCalledWith({
            where: { id: "alb1" },
            data: { coverUrl: null },
        });
    });

    it("handles mixed valid and invalid covers", async () => {
        const validPath = path.join(coversBase, "artists", "valid.jpg");
        fs.writeFileSync(validPath, "fake image data here!");

        mockFindManyArtist.mockResolvedValue([
            { id: "valid", name: "Valid", heroUrl: "native:artists/valid.jpg" },
            { id: "broken", name: "Broken", heroUrl: "native:artists/gone.jpg" },
        ]);
        mockFindManyAlbum.mockResolvedValue([]);

        const result = await repairBrokenCovers();

        expect(result.artistsRepaired).toBe(1);
        expect(mockUpdateArtist).toHaveBeenCalledTimes(1);
        expect(mockUpdateArtist).toHaveBeenCalledWith({
            where: { id: "broken" },
            data: { heroUrl: null, enrichmentStatus: "pending", lastEnriched: null },
        });
    });
});
