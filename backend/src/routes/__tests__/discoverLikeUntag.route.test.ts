/**
 * Liking a Discover album takes Discover's Lidarr tag off the artist that owns the album's Lidarr record, found through
 * the stored Lidarr album id, and off no one else: a same-name Lidarr artist keeps the tag. With no stored id, or when
 * Lidarr cannot find the record, nobody is untagged. Real router and test database; auth, queues, Lidarr and the
 * enrichment wake-up are stood in.
 */
jest.mock("../../utils/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "lu_user" };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "lu_user", role: "admin" };
        next();
    },
}));
jest.mock("../../workers/unifiedEnrichment", () => ({ triggerEnrichmentNow: jest.fn().mockResolvedValue({}) }));
jest.mock("../../services/artistCountsService", () => ({ updateArtistCounts: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../../workers/queues", () => require("./helpers/discoverMocks").discoverQueuesMock());
jest.mock("../../utils/distributedLock", () => require("./helpers/discoverMocks").distributedLockMock());

const TAG = 22;
// Two Lidarr artists share a name; only the first owns the album's record.
const OWNER = { id: 5, artistName: "Interpol", foreignArtistId: "mbid-owner", tags: [TAG] };
const NAMESAKE = { id: 6, artistName: "Interpol", foreignArtistId: "mbid-namesake", tags: [TAG] };
const mockLidarr = {
    getAlbum: jest.fn(),
    getArtists: jest.fn(),
    getArtistById: jest.fn(),
    getOrCreateDiscoveryTag: jest.fn(),
    removeTagsFromArtist: jest.fn(),
    removeDiscoveryTagByMbid: jest.fn(),
};
jest.mock("../../services/lidarr", () => ({ lidarrService: mockLidarr }));

import express from "express";
import request from "supertest";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";

const P = "lu_";
const USER = `${P}user`;
const app = express();
app.use(express.json());
app.use("/discover", discoverRoutes);

async function cleanup() {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}
beforeEach(async () => {
    jest.clearAllMocks();
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    mockLidarr.getOrCreateDiscoveryTag.mockResolvedValue(TAG);
    mockLidarr.getArtists.mockResolvedValue([OWNER, NAMESAKE]);
    mockLidarr.getArtistById.mockImplementation(async (id: number) => [OWNER, NAMESAKE].find((a) => a.id === id) ?? null);
    mockLidarr.removeTagsFromArtist.mockResolvedValue(true);
    mockLidarr.removeDiscoveryTagByMbid.mockResolvedValue(true);
    mockLidarr.getAlbum.mockResolvedValue({ id: 77, artistId: OWNER.id, foreignAlbumId: `${P}rg` });
});
afterAll(async () => {
    await cleanup();
    await closeClient(redisClient);
    await prisma.$disconnect();
});

const suggest = (data: { artistMbid: string | null; lidarrAlbumId: number | null }) =>
    prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: `${P}rg`, artistName: "Interpol", albumTitle: "Album", weekStartDate: new Date(Date.UTC(2026, 9, 19)), status: "ACTIVE", ...data },
    });
const like = () => request(app).post("/discover/like").send({ albumId: `${P}rg` });
const untaggedIds = () => mockLidarr.removeTagsFromArtist.mock.calls.map((c) => c[0]);

describe("POST /discover/like untags only the artist that owns the album's Lidarr record", () => {
    it("untags the record's artist and not a same-name namesake (suggestion with a real artist id)", async () => {
        await suggest({ artistMbid: "mbid-owner", lidarrAlbumId: 77 });
        expect((await like()).status).toBe(200);
        expect(mockLidarr.getAlbum).toHaveBeenCalledWith(77);
        expect(untaggedIds()).toEqual([OWNER.id]);
        expect(mockLidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("untags the record's artist and not a namesake (suggestion with a temp- artist id)", async () => {
        await suggest({ artistMbid: "temp-abc", lidarrAlbumId: 77 });
        expect((await like()).status).toBe(200);
        expect(untaggedIds()).toEqual([OWNER.id]);
    });

    it("untags no one, and warns, when the suggestion has no stored Lidarr album id", async () => {
        await suggest({ artistMbid: "temp-abc", lidarrAlbumId: null });
        expect((await like()).status).toBe(200);
        expect(untaggedIds()).toEqual([]);
        expect(mockLidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });

    it("untags no one, and warns, when Lidarr cannot find the record", async () => {
        mockLidarr.getAlbum.mockResolvedValue(null);
        await suggest({ artistMbid: "mbid-owner", lidarrAlbumId: 77 });
        expect((await like()).status).toBe(200);
        expect(untaggedIds()).toEqual([]);
        expect(mockLidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });

    it("still keeps the album when Lidarr cannot be reached", async () => {
        mockLidarr.getAlbum.mockRejectedValue(new Error("connect ECONNREFUSED"));
        await suggest({ artistMbid: "mbid-owner", lidarrAlbumId: 77 });
        expect((await like()).status).toBe(200);
        expect(untaggedIds()).toEqual([]);
        expect((await prisma.discoveryAlbum.findFirstOrThrow({ where: { userId: USER } })).status).toBe("LIKED");
    });
});
