/**
 * Candidate 6, on the real test database with the real router: a like on a suggestion whose release-group id is a
 * listener's own LIBRARY album. Only auth, queues, Lidarr and the enrichment wake-up are stood in.
 */
jest.mock("../../utils/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "cl_user" };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "cl_user", role: "admin" };
        next();
    },
}));
jest.mock("../../workers/unifiedEnrichment", () => ({ triggerEnrichmentNow: jest.fn().mockResolvedValue({}) }));
jest.mock("../../services/artistCountsService", () => ({ updateArtistCounts: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../../workers/queues", () => require("./helpers/discoverMocks").discoverQueuesMock());
jest.mock("../../utils/distributedLock", () => require("./helpers/discoverMocks").distributedLockMock());
jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        removeDiscoveryTagByMbid: jest.fn().mockResolvedValue(true),
        getArtists: jest.fn().mockResolvedValue([]),
        getOrCreateDiscoveryTag: jest.fn().mockResolvedValue(null),
        removeTagsFromArtist: jest.fn(),
    },
}));

import express from "express";
import request from "supertest";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";

const P = "cl_";
const USER = `${P}user`;
const app = express();
app.use(express.json());
app.use("/discover", discoverRoutes);

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}
beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
});
afterAll(async () => {
    await cleanup();
    await closeClient(redisClient);
    await prisma.$disconnect();
});

async function seed(owned: "native_scan" | null) {
    await prisma.artist.create({ data: { id: `${P}art`, name: "Cl Artist", normalizedName: "cl artist", identityKey: "clartist" } });
    await prisma.album.create({
        data: { id: `${P}alb`, rgMbid: `${P}rg`, artistId: `${P}art`, identityKey: `${P}ik`, title: "Cl Album", primaryType: "Album", location: "LIBRARY" },
    });
    if (owned) await prisma.ownedAlbum.create({ data: { artistId: `${P}art`, rgMbid: `${P}rg`, source: owned } });
    // The suggestion names the listener's own album by its id.
    await prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: `${P}rg`, artistName: "Cl Artist", albumTitle: "Cl Album", weekStartDate: new Date(Date.UTC(2026, 9, 19)), status: "ACTIVE" },
    });
}
const source = async () => (await prisma.ownedAlbum.findFirst({ where: { rgMbid: `${P}rg` } }))?.source ?? null;
const location = async () => (await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb` } })).location;

describe("cand 6: like then unlike on a suggestion that names the listener's own library album", () => {
    it("an album with the scanner's ownership row: the like leaves its mark alone and unlike leaves it in the library", async () => {
        await seed("native_scan");
        expect((await request(app).post("/discover/like").send({ albumId: `${P}rg` })).status).toBe(200);
        expect(await source()).toBe("native_scan");
        expect((await request(app).delete("/discover/unlike").send({ albumId: `${P}rg` })).status).toBe(200);
        expect(await location()).toBe("LIBRARY");
    });

    it("an album with no ownership row (cand 3's state): unlike must not send it to Discover", async () => {
        await seed(null);
        await request(app).post("/discover/like").send({ albumId: `${P}rg` });
        // eslint-disable-next-line no-console
        console.log("source after like:", await source());
        await request(app).delete("/discover/unlike").send({ albumId: `${P}rg` });
        expect(await location()).toBe("LIBRARY");
    });
});
