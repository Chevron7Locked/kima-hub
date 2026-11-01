/**
 * Discover clearing against Lidarr as it really answered: three conversations recorded from a real Lidarr 3.1.6 by
 * Kima's own code (fixtures discover-clear-delete, album-not-found, album-lookup-none), replayed unchanged. Real test
 * database, real files in a temporary music root. Lidarr deletes an album's files itself, so after a successful
 * Lidarr delete Kima removes only its rows and the files in the temp folder stay.
 */

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "dcrec_user", role: "admin" };
        next();
    };
    return { requireAuthOrToken: signIn, requireAuth: signIn, requireAdmin: signIn, requireAcquirePermission: signIn };
});
jest.mock("../../config", () => ({
    config: {
        music: { musicPath: require("path").join(require("os").tmpdir(), `kima-dcrec-music-${process.pid}`) },
        redisUrl: process.env.REDIS_URL,
    },
}));
jest.mock("../../workers/scanRequest", () => ({
    requestScan: jest.fn().mockResolvedValue({ queued: true, jobId: "test-scan" }),
}));
jest.mock("../../workers/queues", () => ({
    discoverQueue: { getJob: jest.fn(), add: jest.fn(), getActive: jest.fn().mockResolvedValue([]), getWaiting: jest.fn().mockResolvedValue([]) },
    scanQueue: { add: jest.fn().mockResolvedValue({ id: "test-scan" }) },
}));
jest.mock("../../workers/unifiedEnrichment", () => ({
    triggerEnrichmentNow: jest.fn().mockResolvedValue(undefined),
}));

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";
import { loadScenario, startLidarrReplay, type LidarrReplay } from "../../__tests__/helpers/lidarrReplay";
import { removeDiscoveryAlbum } from "../../services/discovery/lidarrRemoval";
import { lidarrService } from "../../services/lidarr";
import { clearDiscoverAlbum } from "../../services/discovery/discoverClearing";
import discoverRoutes from "../discover";

jest.setTimeout(120_000);

const P = "dcrec";
const USER = "dcrec_user";
const WEEK = new Date(Date.UTC(2026, 9, 19));
const TRAY_KEY = `discover-clear-lidarr:${USER}`;
const MUSIC = path.resolve(config.music.musicPath);
const ARTIST = "Coldplay";
const MOON_RG = "3988c875-b35f-4c3e-b143-ccb484d45347";
const MOON_LIDARR_ID = 35543;
const NO_SUCH_LIDARR_ID = 2147480000;
const NO_SUCH_RG = "00000000-0000-4000-8000-000000000000";

let lidarr: LidarrReplay | null = null;

function app() {
    const a = express();
    a.use(express.json());
    a.use("/discover", discoverRoutes);
    return a;
}

async function cleanup() {
    await prisma.discoveryTrack.deleteMany({ where: { discoveryAlbum: { userId: USER } } });
    await prisma.discoveryTrack.deleteMany({ where: { trackId: { startsWith: P } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

/** A DISCOVER album with one real file, its track and DiscoveryTrack row, and optionally an ACTIVE suggestion. */
async function addAlbum(key: string, title: string, rg: string, suggestion?: { lidarrAlbumId: number | null }) {
    const artistId = `${P}_art_${key}`;
    await prisma.artist.create({ data: { id: artistId, name: ARTIST, normalizedName: ARTIST.toLowerCase(), identityKey: `${P}_ik_${key}` } });
    const albumId = `${P}_alb_${key}`;
    await prisma.album.create({
        data: { id: albumId, rgMbid: rg, artistId, identityKey: `${P}_ak_${key}`, title, primaryType: "Album", year: 2024, location: "DISCOVER" },
    });
    const relative = `Singles/${ARTIST} ${key}/${title}/01.flac`;
    const trackId = `${P}_t_${key}`;
    await prisma.track.create({
        data: { id: trackId, albumId, title: `song ${key}`, trackNo: 1, duration: 200, filePath: relative, fileModified: new Date(), fileSize: 1000 },
    });
    const file = path.join(MUSIC, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `audio ${key}`);
    let suggestionId: string | null = null;
    if (suggestion) {
        const row = await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: rg, artistName: ARTIST, albumTitle: title, lidarrAlbumId: suggestion.lidarrAlbumId, weekStartDate: WEEK, status: "ACTIVE" },
        });
        suggestionId = row.id;
        await prisma.discoveryTrack.create({ data: { discoveryAlbumId: row.id, trackId, fileName: "01.flac", filePath: relative } });
    }
    return { albumId, trackId, file, suggestionId };
}

const trayRow = () => prisma.notification.findUnique({ where: { userId_groupKey: { userId: USER, groupKey: TRAY_KEY } } });

async function startReplay(name: string, upTo: number) {
    lidarr = await startLidarrReplay(loadScenario(name));
    lidarr.replay(upTo);
    await useLidarr(lidarr.url);
}

beforeAll(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.mkdirSync(MUSIC, { recursive: true });
});

afterAll(async () => {
    await useLidarr("", { lidarrEnabled: false });
    fs.rmSync(MUSIC, { recursive: true, force: true });
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "admin" } });
});

afterEach(async () => {
    await lidarr?.close();
    lidarr = null;
});

describe("Lidarr deletes the album (recorded)", () => {
    it("clears the album's rows, leaves the files to Lidarr, and clears the tray row", async () => {
        await startReplay("discover-clear-delete", 31);
        const moon = await addAlbum("moon", "Moon Music", MOON_RG, { lidarrAlbumId: MOON_LIDARR_ID });
        await prisma.notification.create({
            data: { userId: USER, groupKey: TRAY_KEY, type: "error", title: "1 Discover album not deleted", message: "from an earlier clear" },
        });

        const res = await request(app()).delete("/discover/clear");

        expect(res.status).toBe(200);
        expect(res.body.lidarrFailed).toEqual([]);
        expect(lidarr!.asked.map((a) => `${a.method} ${a.path}`)).toContain(
            `DELETE /api/v1/album/${MOON_LIDARR_ID}?deleteFiles=true&addImportListExclusion=false`,
        );
        expect(await prisma.album.count({ where: { id: moon.albumId } })).toBe(0);
        expect(await prisma.track.count({ where: { id: moon.trackId } })).toBe(0);
        expect(await prisma.discoveryTrack.count({ where: { trackId: moon.trackId } })).toBe(0);
        // Lidarr removes the files; Kima does not, so the temp file is still there.
        expect(fs.existsSync(moon.file)).toBe(true);
        expect(await trayRow()).toBeNull();
    });
});

describe("Lidarr no longer has the album id (recorded 404)", () => {
    it("is not counted as removed, and says why", async () => {
        await startReplay("album-not-found", 4);
        const outcome = await removeDiscoveryAlbum(NO_SUCH_LIDARR_ID, MOON_RG, { rgMbids: [MOON_RG], artistName: ARTIST, albumTitle: "Moon Music" });
        expect(outcome.removed).toBe(false);
        expect(outcome.reason).toContain("Lidarr no longer knows this album");
        expect(lidarr!.asked.map((a) => a.method)).toEqual(["GET"]);
    });

    it("keeps the album and reports it in the tray when a clear meets it", async () => {
        await startReplay("album-not-found", 4);
        const moon = await addAlbum("stale", "Moon Music", MOON_RG, { lidarrAlbumId: NO_SUCH_LIDARR_ID });

        const res = await request(app()).delete("/discover/clear");

        expect(res.status).toBe(200);
        expect(res.body.lidarrFailed).toHaveLength(1);
        expect(res.body.lidarrFailed[0].reason).toContain("Lidarr no longer knows this album");
        expect(await prisma.album.count({ where: { id: moon.albumId } })).toBe(1);
        expect(fs.existsSync(moon.file)).toBe(true);
        expect((await trayRow())!.message).toContain("Moon Music");
    });
});

describe("Lidarr has no album for a release-group id (recorded empty lookup)", () => {
    it("answers null from findAlbumByForeignId", async () => {
        await startReplay("album-lookup-none", 3);
        expect(await lidarrService.findAlbumByForeignId(NO_SUCH_RG)).toBeNull();
    });

    it("keeps a DISCOVER album with no recorded id and no Soulseek evidence, and reports it", async () => {
        await startReplay("album-lookup-none", 3);
        const orphan = await addAlbum("lost", "Moon Music", NO_SUCH_RG);

        const result = await clearDiscoverAlbum({ rgMbid: NO_SUCH_RG, artistName: ARTIST, albumTitle: "Moon Music", lidarrAlbumId: null, suggestionId: null });

        expect(result.cleared).toBe(false);
        expect(lidarr!.asked.map((a) => `${a.method} ${a.path}`)).toEqual([`GET /api/v1/album?foreignAlbumId=${NO_SUCH_RG}`]);
        expect(await prisma.album.count({ where: { id: orphan.albumId } })).toBe(1);
        expect(fs.existsSync(orphan.file)).toBe(true);

        // Discover's own finished download of it (not from Soulseek, so Lidarr is asked) is the record that makes the album Discover's to clear (as
        // createDiscoveryDownloadJob writes it); an album no Discover record names goes back to the library instead.
        const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: WEEK, targetSongCount: 10, status: "completed" } });
        await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${ARTIST} - Moon Music`, type: "album", status: "completed", targetMbid: NO_SUCH_RG, discoveryBatchId: batch.id,
                metadata: { downloadType: "discovery", artistName: ARTIST, albumTitle: "Moon Music", albumMbid: NO_SUCH_RG },
            },
        });

        const res = await request(app()).delete("/discover/clear");
        expect(res.body.lidarrFailed).toHaveLength(1);
        // The listener's own Discover record names the album, so it is reported to that listener.
        expect((await trayRow())!.message).toContain("Moon Music");
    });
});

describe("a DISCOVER album no Discover record names", () => {
    it("goes back to the library with its files; nothing is deleted and Lidarr is not asked to delete", async () => {
        await startReplay("album-lookup-none", 3);
        const orphan = await addAlbum("norecord", "Moon Music", NO_SUCH_RG);

        const res = await request(app()).delete("/discover/clear");

        expect(res.body.lidarrFailed).toEqual([]);
        expect((await prisma.album.findUnique({ where: { id: orphan.albumId } }))?.location).toBe("LIBRARY");
        expect(await prisma.track.count({ where: { id: orphan.trackId } })).toBe(1);
        expect(fs.existsSync(orphan.file)).toBe(true);
        expect(lidarr!.asked.filter((a) => a.method === "DELETE")).toEqual([]);
    });
});
