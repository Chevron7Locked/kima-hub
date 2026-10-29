/**
 * Every way Discover removes an album, against the real test database and real files in a temporary music root:
 * DELETE /discover/clear (with and without suggestions), the albums no suggestion covers, the albums of completed
 * downloads no suggestion names, the weekly regeneration's cleanup, and unlike. Each test builds its own rows and
 * files and sends its own request, so each one causes what it asserts. Lidarr is off (`useLidarr` with
 * lidarrEnabled false) or a real port nothing listens on; no test asks Lidarr to delete an album, because no
 * recording of that exists.
 */

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "dcells_user", role: "admin" };
        next();
    };
    return { requireAuthOrToken: signIn, requireAuth: signIn, requireAdmin: signIn, requireAcquirePermission: signIn };
});
jest.mock("../../config", () => ({
    config: {
        music: { musicPath: require("path").join(require("os").tmpdir(), `kima-dcells-music-${process.pid}`) },
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
import net from "node:net";
import path from "path";
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../../services/artistIdentity";
import { config } from "../../config";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";
import { discoveryAlbumLifecycle } from "../../services/discovery/discoveryAlbumLifecycle";
import { discoverWeeklyService } from "../../services/discoverWeekly";
import discoverRoutes from "../discover";

jest.setTimeout(120_000);

const P = "dcells";
const USER = "dcells_user";
const OWNER = "dcells_owner";
const WEEK = new Date(Date.UTC(2026, 9, 19));
const TRAY_KEY = `discover-clear-lidarr:${USER}`;
const MUSIC = path.resolve(config.music.musicPath);
const ARTIST = "Pellam Voss";
// Release-group ids shaped like real ones, so Lidarr is asked about them when it is on.
const RG_ORPHAN = "11111111-2222-4333-8444-555555555555";

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
    await prisma.unavailableAlbum.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.notification.deleteMany({ where: { userId: OWNER } });
    await prisma.downloadJob.deleteMany({ where: { userId: OWNER } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, OWNER] } } });
}

async function deadPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const assigned = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolve(assigned));
        });
    });
}

interface AlbumSpec {
    key: string;
    rg: string;
    title?: string;
    location?: "DISCOVER" | "LIBRARY";
    /** The suggestion to create for the album, if any. */
    suggestion?: {
        rg?: string;
        title?: string;
        status?: "ACTIVE" | "LIKED" | "MOVED" | "DELETED";
        lidarrAlbumId?: number | null;
    };
}

/** An album with one real file under Singles/, its DiscoveryTrack row, and optionally a suggestion. */
async function addAlbum(spec: AlbumSpec) {
    const artistId = `${P}_art`;
    const title = spec.title ?? `Album ${spec.key}`;
    await prisma.artist.upsert({
        where: { id: artistId },
        update: {},
        create: { id: artistId, name: ARTIST, normalizedName: ARTIST.toLowerCase(), identityKey: artistIdentityKey(ARTIST) },
    });
    const albumId = `${P}_alb_${spec.key}`;
    await prisma.album.create({
        data: { id: albumId, rgMbid: spec.rg, artistId, identityKey: `${P}_ak_${spec.key}`, title, primaryType: "Album", year: 2024, location: spec.location ?? "DISCOVER" },
    });
    const relative = `Singles/${ARTIST} ${spec.key}/${title}/01.flac`;
    const trackId = `${P}_t_${spec.key}`;
    await prisma.track.create({
        data: { id: trackId, albumId, title: `song ${spec.key}`, trackNo: 1, duration: 200, filePath: relative, fileModified: new Date(), fileSize: 1000 },
    });
    const file = path.join(MUSIC, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `audio ${spec.key}`);

    let suggestionId: string | null = null;
    if (spec.suggestion) {
        const suggestion = await prisma.discoveryAlbum.create({
            data: {
                userId: USER,
                rgMbid: spec.suggestion.rg ?? spec.rg,
                artistName: ARTIST,
                albumTitle: spec.suggestion.title ?? title,
                lidarrAlbumId: spec.suggestion.lidarrAlbumId ?? null,
                weekStartDate: WEEK,
                status: spec.suggestion.status ?? "ACTIVE",
            },
        });
        suggestionId = suggestion.id;
        await prisma.discoveryTrack.create({ data: { discoveryAlbumId: suggestion.id, trackId, fileName: "01.flac", filePath: relative } });
    }
    return { albumId, trackId, file, dir: path.dirname(file), suggestionId };
}

/** The record that shows an album's files came from Soulseek: a completed job whose last attempt was Soulseek. */
async function addSoulseekJob(rg: string, title: string, extra: { lidarrAlbumId?: number | null; currentSource?: string; batchStatus?: string } = {}) {
    const batch = extra.batchStatus
        ? await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: WEEK, targetSongCount: 10, status: extra.batchStatus } })
        : null;
    await prisma.downloadJob.create({
        data: {
            discoveryBatchId: batch?.id,
            userId: USER, subject: `${ARTIST} - ${title}`, type: "album", targetMbid: rg, status: "completed",
            lidarrAlbumId: extra.lidarrAlbumId ?? null, metadata: { artistName: ARTIST, albumTitle: title, currentSource: extra.currentSource ?? "soulseek" },
            completedAt: new Date(),
        },
    });
}

/** A completed Discover download of a Lidarr album that no suggestion names. */
async function addExtraJob(rg: string, title: string, batchStatus = "completed") {
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: WEEK, targetSongCount: 10, status: batchStatus } });
    await prisma.downloadJob.create({
        data: {
            userId: USER, subject: `${ARTIST} - ${title}`, type: "album", targetMbid: rg, status: "completed", lidarrAlbumId: 901,
            metadata: { artistName: ARTIST, albumTitle: title }, discoveryBatchId: batch.id, completedAt: new Date(),
        },
    });
}

const trayRow = () => prisma.notification.findUnique({ where: { userId_groupKey: { userId: USER, groupKey: TRAY_KEY } } });

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
    await prisma.user.create({ data: { id: OWNER, username: OWNER, passwordHash: "x" } });
    await useLidarr("", { lidarrEnabled: false });
});

describe("clear with no suggestions", () => {
    it("still looks at the downloads no suggestion names, and keeps the tray row until a clean clear", async () => {
        await addExtraJob(RG_ORPHAN, "Loose Fetch");

        const first = await request(app()).delete("/discover/clear");
        expect(first.status).toBe(200);
        expect(first.body.lidarrFailed).toEqual([{ artistName: ARTIST, albumTitle: "Loose Fetch", reason: "Lidarr is turned off" }]);
        expect(await trayRow()).not.toBeNull();

        // Nothing is suggested, so the old early return would have cleared the row here.
        const second = await request(app()).delete("/discover/clear");
        expect(second.body.lidarrFailed).toHaveLength(1);
        expect(await trayRow()).not.toBeNull();
    });

    it("words a failure on a download no suggestion names without saying it is in the playlist", async () => {
        await addExtraJob(RG_ORPHAN, "Loose Fetch");
        await request(app()).delete("/discover/clear");
        const tray = await trayRow();
        expect(tray!.message).toContain("Loose Fetch");
        expect(tray!.message).not.toContain("playlist");
    });

    it("clears the tray row once nothing fails", async () => {
        await addExtraJob(RG_ORPHAN, "Loose Fetch");
        await request(app()).delete("/discover/clear");
        expect(await trayRow()).not.toBeNull();

        await prisma.downloadJob.deleteMany({ where: { userId: USER } });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.lidarrFailed).toEqual([]);
        expect(await trayRow()).toBeNull();
    });

    it("leaves the download of a batch that is still running alone", async () => {
        await addExtraJob(RG_ORPHAN, "Loose Fetch", "downloading");
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.lidarrFailed).toEqual([]);
        expect(await trayRow()).toBeNull();
    });
});

describe("what a clear leaves alone", () => {
    it("leaves other artists with no albums to the daily integrity check", async () => {
        await prisma.artist.create({ data: { id: `${P}_bare`, name: "Bare Artist", identityKey: `${P}_bare` } });
        await request(app()).delete("/discover/clear").expect(200);
        expect(await prisma.artist.count({ where: { id: `${P}_bare` } })).toBe(1);
    });
});

describe("DISCOVER albums no suggestion covers", () => {
    it("deletes a Soulseek album's files, folders and rows", async () => {
        const orphan = await addAlbum({ key: "orph", rg: `${P}_rg_orph` });
        await addSoulseekJob(`${P}_rg_orph`, "Album orph");
        const res = await request(app()).delete("/discover/clear");
        expect(res.status).toBe(200);
        expect(res.body.orphanedAlbumsDeleted).toBe(1);
        expect(fs.existsSync(orphan.file)).toBe(false);
        expect(fs.existsSync(orphan.dir)).toBe(false);
        expect(await prisma.album.count({ where: { id: orphan.albumId } })).toBe(0);
        expect(await prisma.track.count({ where: { id: orphan.trackId } })).toBe(0);
    });

    it("keeps the files of an album while its batch is still downloading", async () => {
        const orphan = await addAlbum({ key: "run", rg: `${P}_rg_run` });
        // A completed Soulseek record, so without the running-batch guard this album would be deleted.
        await addSoulseekJob(`${P}_rg_run`, "Album run", { batchStatus: "downloading" });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.lidarrFailed).toEqual([]);
        expect(fs.existsSync(orphan.file)).toBe(true);
        expect(await prisma.album.count({ where: { id: orphan.albumId } })).toBe(1);
    });

    it("a running download of another album does not keep one whose title has no letters either", async () => {
        const dots = await addAlbum({ key: "dots", rg: `${P}_rg_dots`, title: "..." });
        await addSoulseekJob(`${P}_rg_dots`, "...");
        await addSoulseekJob(`${P}_rg_bangs`, "!!!", { batchStatus: "downloading" });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.orphanedAlbumsDeleted).toBe(1);
        expect(await prisma.album.count({ where: { id: dots.albumId } })).toBe(0);
    });

    it("keeps an album Lidarr cannot be asked about, and says so in the tray", async () => {
        const orphan = await addAlbum({ key: "lid", rg: RG_ORPHAN });
        const port = await deadPort();
        await useLidarr(`http://127.0.0.1:${port}`);

        const res = await request(app()).delete("/discover/clear");
        expect(res.status).toBe(200);
        expect(res.body.orphanedAlbumsDeleted).toBe(0);
        expect(res.body.lidarrFailed).toHaveLength(1);
        expect(res.body.lidarrFailed[0].reason).toContain("Lidarr could not be reached or answered with an error");
        expect(fs.existsSync(orphan.file)).toBe(true);
        expect(await prisma.album.count({ where: { id: orphan.albumId } })).toBe(1);
        // No record names the album, so the admins are told (this listener is one), not in the listener's own row.
        expect(await trayRow()).toBeNull();
        const admin = await prisma.notification.findUnique({ where: { userId_groupKey: { userId: USER, groupKey: "discover-clear-orphans" } } });
        expect(admin!.message).toContain("Lidarr could not be reached");
    });

    it("keeps the Lidarr-held album a clear just kept, though its suggestion has another id and letter case", async () => {
        const held = await addAlbum({
            key: "held",
            rg: `${P}_rg_held_scanned`,
            title: "Low Tide Hum",
            suggestion: { rg: `${P}_rg_held_suggested`, title: "low tide hum", lidarrAlbumId: 902 },
        });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.lidarrFailed).toEqual([{ artistName: ARTIST, albumTitle: "low tide hum", reason: "Lidarr is turned off" }]);
        expect(res.body.orphanedAlbumsDeleted).toBe(0);
        expect(fs.existsSync(held.file)).toBe(true);
        expect(await prisma.album.count({ where: { id: held.albumId } })).toBe(1);
        expect(await prisma.discoveryTrack.count({ where: { trackId: held.trackId } })).toBe(1);
    });
});

describe("the weekly regeneration's cleanup", () => {
    // Each week starts clean: everything not liked goes, not only last week's suggestions.
    it("also clears Discover albums no suggestion names, and the failed downloads", async () => {
        const orphan = await addAlbum({ key: "worph", rg: `${P}_rg_worph` });
        await addSoulseekJob(`${P}_rg_worph`, "Album worph");
        const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: WEEK, targetSongCount: 10, status: "completed" } });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: `${ARTIST} - gone`, type: "album", status: "failed", discoveryBatchId: batch.id },
        });

        await discoveryAlbumLifecycle.processBeforeGeneration(USER);

        expect(fs.existsSync(orphan.file)).toBe(false);
        expect(await prisma.album.count({ where: { id: orphan.albumId } })).toBe(0);
        expect(await prisma.downloadJob.count({ where: { userId: USER, status: "failed" } })).toBe(0);
    });

    it("does not bring last week's albums back when the scan after it reconciles downloads", async () => {
        const last = await addAlbum({ key: "wlast", rg: `${P}_rg_wlast`, suggestion: {} });
        await addSoulseekJob(`${P}_rg_wlast`, "Album wlast", { batchStatus: "completed" });
        await prisma.discoveryBatch.updateMany({ where: { userId: USER }, data: { completedAt: new Date() } });

        await discoveryAlbumLifecycle.processBeforeGeneration(USER);
        await discoverWeeklyService.reconcileDiscoveryTracks();

        expect(await prisma.discoveryAlbum.count({ where: { userId: USER, status: "ACTIVE" } })).toBe(0);
        expect(await prisma.album.count({ where: { id: last.albumId } })).toBe(0);
    });

    it("keeps a liked album", async () => {
        const liked = await addAlbum({ key: "wliked", rg: `${P}_rg_wliked`, suggestion: { status: "LIKED" } });
        await discoveryAlbumLifecycle.processBeforeGeneration(USER);
        expect(fs.existsSync(liked.file)).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: liked.albumId } })).location).toBe("LIBRARY");
    });

    it("deletes a Soulseek album's files as well as its rows", async () => {
        const soul = await addAlbum({ key: "wsoul", rg: `${P}_rg_wsoul`, suggestion: {} });
        await addSoulseekJob(`${P}_rg_wsoul`, "Album wsoul");
        await discoveryAlbumLifecycle.processBeforeGeneration(USER);
        expect(fs.existsSync(soul.file)).toBe(false);
        expect(fs.existsSync(soul.dir)).toBe(false);
        expect(await prisma.album.count({ where: { id: soul.albumId } })).toBe(0);
    });

    it("keeps a Lidarr-held album that Lidarr did not delete, and tells the listener in the tray", async () => {
        const held = await addAlbum({ key: "wheld", rg: `${P}_rg_wheld`, suggestion: { lidarrAlbumId: 903 } });
        await discoveryAlbumLifecycle.processBeforeGeneration(USER);
        expect(fs.existsSync(held.file)).toBe(true);
        expect(await prisma.album.count({ where: { id: held.albumId } })).toBe(1);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: held.suggestionId! } }))?.status).toBe("ACTIVE");
        const tray = await trayRow();
        expect(tray!.type).toBe("error");
        expect(tray!.message).toContain("Lidarr is turned off");
    });

    it("moves a liked album recorded under another id and letter case, never the library twin", async () => {
        const liked = await addAlbum({
            key: "wlike",
            rg: `${P}_rg_wlike_scanned`,
            title: "Low Tide Hum",
            suggestion: { rg: `${P}_rg_wlike_suggested`, title: "low tide hum", status: "LIKED" },
        });
        const twin = await addAlbum({ key: "wtwin", rg: `${P}_rg_wtwin`, title: "Low Tide Hum", location: "LIBRARY" });

        await discoveryAlbumLifecycle.processBeforeGeneration(USER);
        expect((await prisma.album.findUnique({ where: { id: liked.albumId } }))?.location).toBe("LIBRARY");
        expect(await prisma.ownedAlbum.count({ where: { rgMbid: `${P}_rg_wlike_scanned`, source: "discovery_liked" } })).toBe(1);
        expect(await prisma.ownedAlbum.count({ where: { rgMbid: `${P}_rg_wtwin` } })).toBe(0);
        expect((await prisma.album.findUnique({ where: { id: twin.albumId } }))?.location).toBe("LIBRARY");
        expect(fs.existsSync(liked.file)).toBe(true);
    });
});

describe("unlike", () => {
    it("returns the album to Discover and leaves its suggestion ACTIVE, not deleted", async () => {
        const liked = await addAlbum({
            key: "unl",
            rg: `${P}_rg_unl`,
            location: "LIBRARY",
            suggestion: { status: "LIKED" },
        });
        await prisma.ownedAlbum.create({ data: { artistId: `${P}_art`, rgMbid: `${P}_rg_unl`, source: "discovery_liked" } });

        const res = await request(app()).delete("/discover/unlike").send({ albumId: `${P}_rg_unl` });
        expect(res.status).toBe(200);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: liked.suggestionId! } }))?.status).toBe("ACTIVE");
        expect((await prisma.album.findUnique({ where: { id: liked.albumId } }))?.location).toBe("DISCOVER");
        expect(fs.existsSync(liked.file)).toBe(true);
    });
});

describe("which albums Kima deletes files of", () => {
    const UNKNOWN = "Kima can't tell where this album's files came from, so it left them; delete them in Lidarr or by hand";

    async function expectKept(album: { albumId: string; file: string; trackId: string; suggestionId: string | null }) {
        expect(fs.existsSync(album.file)).toBe(true);
        expect(await prisma.album.count({ where: { id: album.albumId } })).toBe(1);
        expect(await prisma.track.count({ where: { id: album.trackId } })).toBe(1);
        if (album.suggestionId) {
            expect((await prisma.discoveryAlbum.findUnique({ where: { id: album.suggestionId } }))?.status).toBe("ACTIVE");
            expect(await prisma.discoveryTrack.count({ where: { discoveryAlbumId: album.suggestionId } })).toBe(1);
        }
    }

    it("keeps a suggested album with no download record, and reports why", async () => {
        const album = await addAlbum({ key: "nojob", rg: `${P}_rg_nojob`, suggestion: {} });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.activeDeleted).toBe(0);
        expect(res.body.lidarrFailed).toEqual([{ artistName: ARTIST, albumTitle: "Album nojob", reason: UNKNOWN }]);
        await expectKept(album);
        expect((await trayRow())!.message).toContain(UNKNOWN);
    });

    it("keeps an album no suggestion covers and no download record shows is Soulseek's", async () => {
        const album = await addAlbum({ key: "nojob2", rg: `${P}_rg_nojob2` });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.orphanedAlbumsDeleted).toBe(0);
        expect(res.body.lidarrFailed[0].reason).toBe(UNKNOWN);
        await expectKept(album);
    });

    it("keeps an album whose last download attempt was Lidarr's", async () => {
        const album = await addAlbum({ key: "lidsrc", rg: `${P}_rg_lidsrc`, suggestion: {} });
        await addSoulseekJob(`${P}_rg_lidsrc`, "Album lidsrc", { currentSource: "lidarr" });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.lidarrFailed[0].reason).toBe(UNKNOWN);
        await expectKept(album);
    });

    it("keeps an album when a Soulseek record is not enough: its download did not complete", async () => {
        const album = await addAlbum({ key: "failed", rg: `${P}_rg_failed`, suggestion: {} });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: `${ARTIST} - Album failed`, type: "album", targetMbid: `${P}_rg_failed`, status: "failed", metadata: { currentSource: "soulseek" } },
        });
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.lidarrFailed[0].reason).toBe(UNKNOWN);
        await expectKept(album);
    });

    it("finds the Soulseek record by artist and title when the id differs", async () => {
        const album = await addAlbum({ key: "byname", rg: `${P}_rg_byname`, suggestion: {} });
        await addSoulseekJob(`${P}_rg_other_id`, "Album byname");
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.activeDeleted).toBe(1);
        expect(fs.existsSync(album.file)).toBe(false);
    });

    it("keeps the album, its rows and its ACTIVE suggestion when a file cannot be deleted, and says the files that went stay gone", async () => {
        const album = await addAlbum({ key: "perm", rg: `${P}_rg_perm`, suggestion: {} });
        await addSoulseekJob(`${P}_rg_perm`, "Album perm");
        // A second song in a folder Kima can write to; the first song's folder is made read-only.
        const goodFile = path.join(MUSIC, "Singles", "perm good", "02.flac");
        fs.mkdirSync(path.dirname(goodFile), { recursive: true });
        fs.writeFileSync(goodFile, "audio");
        await prisma.track.create({
            data: { id: `${P}_t_perm2`, albumId: album.albumId, title: "song 2", trackNo: 2, duration: 100, filePath: "Singles/perm good/02.flac", fileModified: new Date(), fileSize: 1 },
        });
        fs.chmodSync(album.dir, 0o555);
        try {
            const res = await request(app()).delete("/discover/clear");
            expect(res.body.activeDeleted).toBe(0);
            expect(res.body.lidarrFailed).toHaveLength(1);
            expect(res.body.lidarrFailed[0].reason).toContain("Kima isn't allowed to delete these files; check the music folder's permissions");
            expect(res.body.lidarrFailed[0].reason).toContain("1 of 2 files were deleted and stay gone");
            expect(fs.existsSync(goodFile)).toBe(false);
            expect(fs.existsSync(album.file)).toBe(true);
            expect(await prisma.album.count({ where: { id: album.albumId } })).toBe(1);
            expect(await prisma.track.count({ where: { albumId: album.albumId } })).toBe(2);
            expect((await prisma.discoveryAlbum.findUnique({ where: { id: album.suggestionId! } }))?.status).toBe("ACTIVE");
            expect((await trayRow())!.message).toContain("check the music folder's permissions");
        } finally {
            fs.chmodSync(album.dir, 0o755);
        }
    });

    it("counts an album whose files are already gone as cleared", async () => {
        const album = await addAlbum({ key: "gone", rg: `${P}_rg_gone`, suggestion: {} });
        await addSoulseekJob(`${P}_rg_gone`, "Album gone");
        fs.rmSync(album.file);
        const res = await request(app()).delete("/discover/clear");
        expect(res.body.activeDeleted).toBe(1);
        expect(res.body.lidarrFailed).toEqual([]);
        expect(await prisma.album.count({ where: { id: album.albumId } })).toBe(0);
        expect(await trayRow()).toBeNull();
    });

    it("the weekly regeneration also keeps an album with no download record and reports it", async () => {
        const album = await addAlbum({ key: "wnojob", rg: `${P}_rg_wnojob`, suggestion: {} });
        await discoveryAlbumLifecycle.processBeforeGeneration(USER);
        await expectKept(album);
        expect((await trayRow())!.message).toContain(UNKNOWN);
    });
});

describe("an album the listener's library holds", () => {
    it("is left alone, with Lidarr never asked to delete it, when its suggestion is still ACTIVE", async () => {
        // An unlike that keeps the album in the library leaves the suggestion ACTIVE, recorded under another id and case.
        const own = await addAlbum({
            key: "own",
            rg: `${P}_rg_own_scanned`,
            title: "Low Tide Hum",
            location: "LIBRARY",
            suggestion: { rg: `${P}_rg_own_suggested`, title: "low tide hum", lidarrAlbumId: 904 },
        });
        // Any request to Lidarr meets a port nothing listens on and would surface as a failure.
        await useLidarr(`http://127.0.0.1:${await deadPort()}`);

        const res = await request(app()).delete("/discover/clear");
        expect(res.status).toBe(200);
        expect(res.body.lidarrFailed).toEqual([]);
        expect(fs.existsSync(own.file)).toBe(true);
        expect((await prisma.album.findUnique({ where: { id: own.albumId } }))?.location).toBe("LIBRARY");
        expect(await prisma.track.count({ where: { id: own.trackId } })).toBe(1);
        expect(await trayRow()).toBeNull();
    });
});

describe("an error while clearing one album", () => {
    const dropTrigger = () => prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS dcells_boom_t ON "Album"');
    afterEach(dropTrigger);

    /** A real database refusal: deleting this album's row raises an error. */
    async function boomAlbum(key: string) {
        const album = await addAlbum({ key, rg: `${P}_rg_${key}`, suggestion: {} });
        await addSoulseekJob(`${P}_rg_${key}`, `Album ${key}`);
        await prisma.$executeRawUnsafe(
            "CREATE OR REPLACE FUNCTION dcells_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'dcells refused'; END $$ LANGUAGE plpgsql",
        );
        await prisma.$executeRawUnsafe(
            `CREATE TRIGGER dcells_boom_t BEFORE DELETE ON "Album" FOR EACH ROW WHEN (OLD.id = '${album.albumId}') EXECUTE FUNCTION dcells_boom()`,
        );
        return album;
    }

    it("keeps the tray row and names the album when a clear hits it", async () => {
        const album = await boomAlbum("boom");
        await prisma.notification.create({
            data: { userId: USER, groupKey: TRAY_KEY, type: "error", title: "1 Discover album not deleted", message: "from an earlier clear" },
        });

        const res = await request(app()).delete("/discover/clear");
        expect(res.status).toBe(200);
        expect(res.body.activeDeleted).toBe(0);
        expect(res.body.lidarrFailed).toHaveLength(1);
        expect(res.body.lidarrFailed[0].reason).toContain("Kima hit an error clearing this album");
        const tray = await trayRow();
        expect(tray).not.toBeNull();
        expect(tray!.message).toContain("Album boom");
        expect(await prisma.album.count({ where: { id: album.albumId } })).toBe(1);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: album.suggestionId! } }))?.status).toBe("ACTIVE");
    });

    it("also reaches the tray from the weekly regeneration", async () => {
        await boomAlbum("wboom");
        await discoveryAlbumLifecycle.processBeforeGeneration(USER);
        expect((await trayRow())!.message).toContain("Kima hit an error clearing this album");
    });
});

describe("an orphan album that was not deleted", () => {
    it("is reported to the listener whose record names it, not to the listener who cleared", async () => {
        const orphan = await addAlbum({ key: "theirs", rg: `${P}_rg_theirs` });
        await prisma.downloadJob.create({
            data: { userId: OWNER, subject: `${ARTIST} - Album theirs`, type: "album", targetMbid: `${P}_rg_theirs`, status: "failed" },
        });

        const res = await request(app()).delete("/discover/clear");
        expect(res.status).toBe(200);
        expect(fs.existsSync(orphan.file)).toBe(true);

        const theirs = await prisma.notification.findUnique({ where: { userId_groupKey: { userId: OWNER, groupKey: `discover-clear-lidarr:${OWNER}` } } });
        expect(theirs!.message).toContain("Album theirs");
        expect(await trayRow()).toBeNull();
        expect(await prisma.notification.count({ where: { userId: USER, groupKey: "discover-clear-orphans" } })).toBe(0);
        expect(res.body.lidarrFailed).toEqual([]);
    });
});
