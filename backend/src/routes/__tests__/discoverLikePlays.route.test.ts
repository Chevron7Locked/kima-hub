/**
 * A like and an unlike leave the listener's Play rows alone: plays are not labelled by what the suggestion was at the
 * time, so what counts as the listener's own library plays follows where the album is. Real routers, real database;
 * only auth, queues, Lidarr and the enrichment wake-up are stood in.
 */
jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "dlp_user" };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "dlp_user", role: "admin" };
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
import tracksRouter from "../library/tracks";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

const P = "dlp_";
const USER = `${P}user`;
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: USER, role: "admin" };
    next();
});
app.use("/discover", discoverRoutes);
app.use("/library", tracksRouter);

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
    await prisma.artist.create({ data: { id: `${P}art`, name: "Dlp Artist", normalizedName: "dlp artist", identityKey: "dlpartist" } });
    await prisma.album.create({
        data: { id: `${P}alb`, rgMbid: `${P}rg`, artistId: `${P}art`, identityKey: `${P}ik`, title: "Dlp Album", primaryType: "Album", location: "DISCOVER" },
    });
    await prisma.track.create({
        data: { id: `${P}t`, albumId: `${P}alb`, title: "Dlp Song", trackNo: 1, duration: 100, filePath: `${P}t.flac`, fileModified: new Date(), fileSize: 1 },
    });
    const suggestion = await prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: `${P}rg`, artistName: "Dlp Artist", albumTitle: "Dlp Album", weekStartDate: new Date(Date.UTC(2026, 9, 19)), status: "ACTIVE" },
    });
    await prisma.discoveryTrack.create({ data: { discoveryAlbumId: suggestion.id, trackId: `${P}t`, fileName: "t.flac", filePath: `${P}t.flac` } });
    await prisma.play.createMany({
        data: [
            { id: `${P}p1`, userId: USER, trackId: `${P}t`, playedAt: new Date(Date.now() - 3_600_000) },
            { id: `${P}p2`, userId: USER, trackId: `${P}t`, playedAt: new Date(Date.now() - 600_000) },
        ],
    });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

const playRows = () => prisma.play.findMany({ where: { userId: USER }, orderBy: { id: "asc" }, select: { id: true, source: true } });
const recentArtists = async () => {
    const res = await request(app).get("/library/recently-listened");
    expect(res.status).toBe(200);
    return (res.body.items as Array<{ id: string; type: string }>).filter((i) => i.id === `${P}art`);
};

describe("a like and an unlike", () => {
    it("leave the Play rows as they were, and recently listened follows where the album is", async () => {
        expectLog("warn");
        const before = await playRows();
        expect(before.map((r) => r.id)).toEqual([`${P}p1`, `${P}p2`]);

        // In Discover: the plays are not the listener's library plays.
        expect(await recentArtists()).toHaveLength(0);

        expect((await request(app).post("/discover/like").send({ albumId: `${P}rg` })).status).toBe(200);
        expect(await playRows()).toEqual(before);
        expect(await recentArtists()).toHaveLength(1);

        expect((await request(app).delete("/discover/unlike").send({ albumId: `${P}rg` })).status).toBe(200);
        expect(await playRows()).toEqual(before);
        expect(await recentArtists()).toHaveLength(0);
    });
});
