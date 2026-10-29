/**
 * DELETE /discover/clear against the real test database and real files in a temporary music root: a Discover
 * album's files and folders go, a library twin and anything outside the root stay, a Lidarr-held album stays in
 * Discover and is reported in lidarrFailed, and a liked album moves to the library. Lidarr is off or a port
 * nothing listens on; no test asks Lidarr to delete an album.
 */

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Signed-in listener for every route on this router.
jest.mock("../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "dclear_user", role: "admin" };
        next();
    };
    return {
        requireAuthOrToken: signIn,
        requireAuth: signIn,
        requireAdmin: signIn,
        requireAcquirePermission: signIn,
    };
});

// The music root for this file: a temp folder, so clear touches real files it
// owns and never the developer's library. The rest of the config comes from the
// environment, because helpers (queueConnection) read config.redisUrl.
jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: require("path").join(require("os").tmpdir(), `kima-dclear-music-${process.pid}`),
        },
        redisUrl: process.env.REDIS_URL,
    },
}));

// Clear queues a library scan at the end. The scan would walk the temp folder
// and rebuild the rows under test, so the queue is stubbed; the real queues
// module is never loaded (its BullMQ workers would outlive the suite).
jest.mock("../../workers/scanRequest", () => ({
    requestScan: jest.fn().mockResolvedValue({ queued: true, jobId: "test-scan" }),
}));
jest.mock("../../workers/queues", () => ({
    discoverQueue: { getJob: jest.fn(), add: jest.fn(), getActive: jest.fn().mockResolvedValue([]), getWaiting: jest.fn().mockResolvedValue([]) },
    scanQueue: { add: jest.fn().mockResolvedValue({ id: "test-scan" }) },
}));
// A LIKED album moves to the library, which fires enrichment (a worker suite
// in itself). The like route test stubs it the same way.
jest.mock("../../workers/unifiedEnrichment", () => ({
    triggerEnrichmentNow: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../../services/artistIdentity";
import { config } from "../../config";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";
import { deadPort, discoverApp } from "./helpers/discoverClear";

jest.setTimeout(120_000);

const P = "dclear";
const USER = "dclear_user";
const WEEK = new Date(Date.UTC(2026, 9, 19));
// The album the recorded "complete" run knows: id 257, foreign id below.
const LIDARR_ALBUM_ID = 257;
const LIDARR_RG = "d0484284-1ee7-4157-951a-50f003cbcfb4";
const TRAY_KEY = `discover-clear-lidarr:${USER}`;

const MUSIC = path.resolve(config.music.musicPath);
// What `../${P}-outside-${pid}` resolves to from the music root.
const OUTSIDE = path.resolve(MUSIC, "..", `${P}-outside-${process.pid}`);

const ARTIST_NAME = "Quorvex Vellum";
const ALBUM_TITLE = "Marsh Tape";
const LIDARR_TITLE = "Guess Who's a Mess";
const CASE_TITLE = "Low Tide Hum";
const LIKED_ARTIST = "Tidelike Echoes";
const LIKED_TITLE = "Low Tide Hum";

// Folders clear must tidy away (a) and must not touch (b, d).
const SOULSEEK_DIR = path.join(MUSIC, "Singles", ARTIST_NAME, ALBUM_TITLE);
const SIBLING_FILE = path.join(MUSIC, "Singles", "Quorvex Sibling", ALBUM_TITLE, "keep.flac");
const LIBRARY_DIR = path.join(MUSIC, ARTIST_NAME, ALBUM_TITLE);
const LIDARR_DIR = path.join(MUSIC, "Lidarr", ARTIST_NAME, LIDARR_TITLE);
const CASE_DIR = path.join(MUSIC, "Singles", ARTIST_NAME, CASE_TITLE);
const LIKED_DIR = path.join(MUSIC, "Singles", LIKED_ARTIST, LIKED_TITLE);

/** One track per row: the id, the album row it belongs to, its stored relative path. */
const TRACKS = [
    // (a) The Soulseek-style album, under Singles/ like services/soulseek.ts files it.
    { id: `${P}_t1`, album: `${P}_alb_soul`, filePath: `Singles/${ARTIST_NAME}/${ALBUM_TITLE}/01 - Side A.flac` },
    { id: `${P}_t2`, album: `${P}_alb_soul`, filePath: `Singles/${ARTIST_NAME}/${ALBUM_TITLE}/02 - Side B.flac` },
    // (c) Same title and artist name as the LIBRARY twin, one path climbing out of the root.
    { id: `${P}_t3`, album: `${P}_alb_dbl`, filePath: `../${P}-outside-${process.pid}/${ALBUM_TITLE}/01 - Outside.flac` },
    // (b) The listener's own album beside it.
    { id: `${P}_t4`, album: `${P}_alb_lib`, filePath: `${ARTIST_NAME}/${ALBUM_TITLE}/01 - Own Copy.flac` },
    { id: `${P}_t5`, album: `${P}_alb_lib`, filePath: `${ARTIST_NAME}/${ALBUM_TITLE}/02 - Second Track.flac` },
    // (d) The album Lidarr holds.
    { id: `${P}_t6`, album: `${P}_alb_lid`, filePath: `Lidarr/${ARTIST_NAME}/${LIDARR_TITLE}/01.flac` },
    { id: `${P}_t7`, album: `${P}_alb_lid`, filePath: `Lidarr/${ARTIST_NAME}/${LIDARR_TITLE}/02.flac` },
    // (e) The album whose suggestion carries another id and another letter case.
    { id: `${P}_t8`, album: `${P}_alb_case`, filePath: `Singles/${ARTIST_NAME}/${CASE_TITLE}/01 - Hum.flac` },
    // (f) The LIKED suggestion's DISCOVER album, recorded under a lower-case
    // title, with a same-named LIBRARY twin beside it.
    { id: `${P}_t9`, album: `${P}_alb_like`, filePath: `Singles/${LIKED_ARTIST}/${LIKED_TITLE}/01 - Low Tide.flac` },
    { id: `${P}_t10`, album: `${P}_alb_likelib`, filePath: `${LIKED_ARTIST}/${LIKED_TITLE}/01 - Their Own.flac` },
];

const ALBUMS: {
    id: string;
    artist: string;
    rg: string;
    title: string;
    lidarrAlbumId: number | null;
    location: string;
    /** What the suggestion recorded, when it differs from the scanned album's tags. */
    suggested?: { rg: string; title: string };
    status?: "ACTIVE" | "LIKED";
}[] = [
    { id: `${P}_alb_soul`, artist: `${P}_art_a`, rg: `${P}_rg_soul`, title: ALBUM_TITLE, lidarrAlbumId: null, location: "DISCOVER" },
    { id: `${P}_alb_dbl`, artist: `${P}_art_a`, rg: `${P}_rg_dbl`, title: ALBUM_TITLE, lidarrAlbumId: null, location: "DISCOVER" },
    { id: `${P}_alb_lib`, artist: `${P}_art_a`, rg: `${P}_rg_lib`, title: ALBUM_TITLE, lidarrAlbumId: null, location: "LIBRARY" },
    { id: `${P}_alb_lid`, artist: `${P}_art_a`, rg: LIDARR_RG, title: LIDARR_TITLE, lidarrAlbumId: LIDARR_ALBUM_ID, location: "DISCOVER" },
    {
        id: `${P}_alb_case`,
        artist: `${P}_art_a`,
        rg: `${P}_rg_case_scanned`,
        title: CASE_TITLE,
        lidarrAlbumId: null,
        location: "DISCOVER",
        suggested: { rg: `${P}_rg_case_suggested`, title: CASE_TITLE.toLowerCase() },
    },
    // (f) A LIKED suggestion recorded as a lower-case title under an id no album
    // carries, with a same-named LIBRARY copy that must not be the one moved.
    {
        id: `${P}_alb_like`,
        artist: `${P}_art_c`,
        rg: `${P}_rg_like_scanned`,
        title: LIKED_TITLE,
        lidarrAlbumId: null,
        location: "DISCOVER",
        suggested: { rg: `${P}_rg_like_suggested`, title: LIKED_TITLE.toLowerCase() },
        status: "LIKED",
    },
    { id: `${P}_alb_likelib`, artist: `${P}_art_c`, rg: `${P}_rg_like_library`, title: LIKED_TITLE, lidarrAlbumId: null, location: "LIBRARY" },
];

const ARTISTS = [
    // Two artists with the same name: (a) finds its album by name, and (b)
    // proves the LIBRARY album beside it is not the one clear touches.
    { id: `${P}_art_a`, name: ARTIST_NAME },
    // (f) The LIKED album's artist and its same-named LIBRARY twin's.
    { id: `${P}_art_c`, name: LIKED_ARTIST },
];

async function cleanup() {
    await prisma.discoveryTrack.deleteMany({ where: { discoveryAlbum: { userId: USER } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.unavailableAlbum.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

/** Selects the suggestion built for an album row (it can carry another id than the album). */
function suggestionKey(albumId: string) {
    const album = ALBUMS.find((a) => a.id === albumId)!;
    return { rgMbid: album.suggested?.rg ?? album.rg };
}

/** The rows and the real files of one run, rebuilt before every test. */
async function buildFixture() {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "admin" } });
    for (const artist of ARTISTS) {
        await prisma.artist.create({
            data: { id: artist.id, name: artist.name, normalizedName: artist.name.toLowerCase(), identityKey: artistIdentityKey(artist.name) },
        });
    }
    for (const album of ALBUMS) {
        await prisma.album.create({
            data: {
                id: album.id,
                rgMbid: album.rg,
                artistId: album.artist,
                identityKey: `${P}_ak_${album.id}`,
                title: album.title,
                primaryType: "Album",
                year: 2024,
                location: album.location as "DISCOVER" | "LIBRARY",
            },
        });
        await prisma.discoveryAlbum.create({
            data: {
                userId: USER,
                rgMbid: album.suggested?.rg ?? album.rg,
                artistName: album.artist === `${P}_art_c` ? LIKED_ARTIST : ARTIST_NAME,
                albumTitle: album.suggested?.title ?? album.title,
                lidarrAlbumId: album.lidarrAlbumId,
                weekStartDate: WEEK,
                status: album.status ?? "ACTIVE",
            },
        });
    }
    await prisma.track.createMany({
        data: TRACKS.map((t, i) => ({
            id: t.id,
            albumId: t.album,
            title: `${P} song ${i + 1}`,
            trackNo: i + 1,
            duration: 200,
            filePath: t.filePath,
            fileModified: new Date(),
            fileSize: 1000,
        })),
    });
    // Soulseek's completed download records, which are what show those albums' files are Kima's to delete.
    for (const album of ALBUMS.filter((a) => a.location === "DISCOVER" && a.lidarrAlbumId === null && a.status !== "LIKED")) {
        await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${ARTIST_NAME} - ${album.title}`, type: "album", targetMbid: album.rg, status: "completed",
                metadata: { artistName: ARTIST_NAME, albumTitle: album.title, currentSource: "soulseek" }, completedAt: new Date(),
            },
        });
    }
    // Each suggestion lists its album's songs, as the playlist build records them.
    for (const t of TRACKS) {
        const suggestion = await prisma.discoveryAlbum.findFirstOrThrow({
            where: { userId: USER, ...suggestionKey(t.album) },
        });
        await prisma.discoveryTrack.create({
            data: { discoveryAlbumId: suggestion.id, trackId: t.id, fileName: path.basename(t.filePath), filePath: t.filePath },
        });
    }

    // The files on disk: every track's path under the music root, the file the
    // `../` track points at OUTSIDE it, and a sibling single under a second
    // artist folder, so the artist folders clear removes are the album's own
    // and the Singles root stays non-empty.
    for (const t of TRACKS) {
        const file = path.join(MUSIC, t.filePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `audio ${t.id}`);
    }
    fs.mkdirSync(path.dirname(SIBLING_FILE), { recursive: true });
    fs.writeFileSync(SIBLING_FILE, "another single by the same artist");
}

beforeAll(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    fs.mkdirSync(MUSIC, { recursive: true });
});

afterAll(async () => {
    await useLidarr("", { lidarrEnabled: false });
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    await cleanup();
    await closeEngineConnections();
});

beforeEach(async () => {
    await cleanup();
    await buildFixture();
    // Lidarr is off, so the Lidarr-held album stays in Discover and is reported in lidarrFailed;
    // a test that needs Lidarr to answer points Kima at its own endpoint.
    await useLidarr("", { lidarrEnabled: false });
});

describe("DELETE /discover/clear -- files, folders and traversal", () => {
    it("deletes the Soulseek album's files, then its empty folders, and the rows", async () => {
        const res = await request(discoverApp()).delete("/discover/clear");
        expect(res.status).toBe(200);
        // Six ACTIVE suggestions (the LIKED one is not among them). The five
        // without a lidarrAlbumId are cleared by Kima itself; the Lidarr-held
        // one stays for a later clear.
        expect(res.body.activeDeleted).toBe(5);
        expect(res.body.lidarrFailed).toEqual([
            { artistName: ARTIST_NAME, albumTitle: LIDARR_TITLE, reason: "Lidarr is turned off" },
        ]);

        // (a) The album's files are gone, its album folder with them, and the
        // artist folder, now empty, after it.
        for (const t of TRACKS.filter((t) => t.album === `${P}_alb_soul`)) {
            expect(fs.existsSync(path.join(MUSIC, t.filePath))).toBe(false);
        }
        expect(fs.existsSync(SOULSEEK_DIR)).toBe(false);
        expect(fs.existsSync(path.dirname(SOULSEEK_DIR))).toBe(false);

        // The sibling single keeps its own folder; the Singles root is never a
        // target, so it stays.
        expect(fs.existsSync(SIBLING_FILE)).toBe(true);
        expect(fs.existsSync(path.join(MUSIC, "Singles"))).toBe(true);

        // Rows: the DISCOVER album, its tracks, its suggestion.
        expect(await prisma.album.count({ where: { id: `${P}_alb_soul` } })).toBe(0);
        expect(await prisma.track.count({ where: { albumId: `${P}_alb_soul` } })).toBe(0);
        expect(await prisma.discoveryTrack.count({ where: { trackId: { in: ["t1", "t2"].map((n) => `${P}_${n}`) } } })).toBe(0);
        // One ACTIVE suggestion is left: the Lidarr-held album, kept in Discover.
        expect(await prisma.discoveryAlbum.count({ where: { userId: USER, status: "ACTIVE" } })).toBe(1);
    });

    it("finds an album whose suggestion carries another id and letter case, and clears it", async () => {
        const res = await request(discoverApp()).delete("/discover/clear");
        expect(res.status).toBe(200);
        expect(res.body.activeDeleted).toBe(5);
        expect(res.body.lidarrFailed).toEqual([
            { artistName: ARTIST_NAME, albumTitle: LIDARR_TITLE, reason: "Lidarr is turned off" },
        ]);

        // (e) Found by artist and title in any case, as like and unlike find it.
        expect(fs.existsSync(path.join(MUSIC, TRACKS.find((t) => t.album === `${P}_alb_case`)!.filePath))).toBe(false);
        expect(fs.existsSync(CASE_DIR)).toBe(false);
        expect(await prisma.album.count({ where: { id: `${P}_alb_case` } })).toBe(0);
        expect(await prisma.track.count({ where: { albumId: `${P}_alb_case` } })).toBe(0);
        expect(await prisma.discoveryTrack.count({ where: { trackId: `${P}_t8` } })).toBe(0);
    });

    it("moves a LIKED album the suggestion recorded under another id and letter case, never the library twin", async () => {
        const res = await request(discoverApp()).delete("/discover/clear");
        expect(res.status).toBe(200);
        expect(res.body.likedMoved).toBe(1);

        // (f) The DISCOVER album the suggestion points at -- by artist and title,
        // in any case -- is the one that joins the library.
        const moved = await prisma.album.findUnique({ where: { id: `${P}_alb_like` } });
        expect(moved?.location).toBe("LIBRARY");
        expect(await prisma.ownedAlbum.count({ where: { artistId: `${P}_art_c`, rgMbid: `${P}_rg_like_scanned`, source: "discovery_liked" } })).toBe(1);

        // The listener's own same-named LIBRARY copy: untouched, its own.
        const twin = await prisma.album.findUnique({ where: { id: `${P}_alb_likelib` } });
        expect(twin?.location).toBe("LIBRARY");
        expect(await prisma.ownedAlbum.count({ where: { rgMbid: `${P}_rg_like_library` } })).toBe(0);

        expect(await prisma.discoveryAlbum.findFirst({ where: { userId: USER, status: "LIKED" } })).toBeNull();
        expect(fs.existsSync(path.join(MUSIC, TRACKS.find((t) => t.album === `${P}_alb_like`)!.filePath))).toBe(true);
        expect(fs.existsSync(path.join(MUSIC, TRACKS.find((t) => t.album === `${P}_alb_likelib`)!.filePath))).toBe(true);
        // A moved album keeps its folder: its file stays where it is.
        expect(fs.existsSync(LIKED_DIR)).toBe(true);
    });

    it("leaves the LIBRARY album with the same title and artist name untouched", async () => {
        const res = await request(discoverApp()).delete("/discover/clear");
        expect(res.body.lidarrFailed).toEqual([
            { artistName: ARTIST_NAME, albumTitle: LIDARR_TITLE, reason: "Lidarr is turned off" },
        ]);

        // (b) Clear deletes only the DISCOVER row; the library copy's files
        // and rows stay, so the next scan finds the listener's own album.
        for (const t of TRACKS.filter((t) => t.album === `${P}_alb_lib`)) {
            expect(fs.existsSync(path.join(MUSIC, t.filePath))).toBe(true);
        }
        expect(fs.existsSync(LIBRARY_DIR)).toBe(true);
        expect(await prisma.album.count({ where: { id: `${P}_alb_lib` } })).toBe(1);
        expect(await prisma.track.count({ where: { albumId: `${P}_alb_lib` } })).toBe(2);
    });

    it("refuses a filePath that climbs out of the music root and deletes nothing outside", async () => {
        const res = await request(discoverApp()).delete("/discover/clear");
        expect(res.body.lidarrFailed).toEqual([
            { artistName: ARTIST_NAME, albumTitle: LIDARR_TITLE, reason: "Lidarr is turned off" },
        ]);

        // (c) The twin album's file lives OUTSIDE the music root, at
        // ../dclear-outside-<pid>/... Clear must refuse it.
        const outsideFile = path.join(OUTSIDE, ALBUM_TITLE, "01 - Outside.flac");
        expect(fs.existsSync(outsideFile)).toBe(true);

        // Its rows go (only the file delete is refused) and the album has no
        // lidarrAlbumId, so no Lidarr refusal keeps it: no row is left
        // pointing at a file no scan will ever index.
        expect(await prisma.track.count({ where: { id: `${P}_t3` } })).toBe(0);
        expect(await prisma.album.count({ where: { id: `${P}_alb_dbl` } })).toBe(0);
    });
});

describe("DELETE /discover/clear -- a Lidarr that did not delete", () => {
    /** The rows and files of the Lidarr-held album, all of which must survive. */
    async function expectAlbumKeptInDiscover() {
        for (const t of TRACKS.filter((t) => t.album === `${P}_alb_lid`)) {
            expect(fs.existsSync(path.join(MUSIC, t.filePath))).toBe(true);
        }
        expect(fs.existsSync(LIDARR_DIR)).toBe(true);
        expect(await prisma.album.count({ where: { id: `${P}_alb_lid` } })).toBe(1);
        expect(await prisma.track.count({ where: { albumId: `${P}_alb_lid` } })).toBe(2);
        const kept = await prisma.discoveryAlbum.findFirst({
            where: { userId: USER, lidarrAlbumId: LIDARR_ALBUM_ID },
        });
        expect(kept?.status).toBe("ACTIVE");
        // The suggestion still lists its songs.
        expect(await prisma.discoveryTrack.count({ where: { discoveryAlbumId: kept!.id } })).toBe(2);
    }

    it("with Lidarr turned off: the album keeps its files and rows, the reply names it, the tray says so", async () => {
        const res = await request(discoverApp()).delete("/discover/clear");
        expect(res.status).toBe(200);
        // The five suggestions without a lidarrAlbumId went; the Lidarr-held
        // one stayed in Discover.
        expect(res.body.activeDeleted).toBe(5);
        expect(res.body.lidarrFailed).toEqual([
            { artistName: ARTIST_NAME, albumTitle: LIDARR_TITLE, reason: "Lidarr is turned off" },
        ]);

        await expectAlbumKeptInDiscover();

        const tray = await prisma.notification.findUnique({
            where: { userId_groupKey: { userId: USER, groupKey: TRAY_KEY } },
        });
        expect(tray).not.toBeNull();
        expect(tray!.type).toBe("error");
        expect(tray!.title).toContain("1 Discover album");
        expect(tray!.message).toContain(LIDARR_TITLE);
        expect(tray!.message).toContain("Lidarr is turned off");
        expect(tray!.message).toContain("Clear Discover again");
    });

    it("when Lidarr answers with an error: the album keeps its files and rows, the reason carries the error", async () => {
        // A real failure: Kima's Lidarr points at a port nothing listens on.
        const port = await deadPort();
        await useLidarr(`http://127.0.0.1:${port}`);

        const res = await request(discoverApp()).delete("/discover/clear");
        expect(res.status).toBe(200);
        // Five of the six ACTIVE suggestions went; the Lidarr-held one stayed.
        expect(res.body.activeDeleted).toBe(5);
        expect(res.body.lidarrFailed).toHaveLength(1);
        expect(res.body.lidarrFailed[0].artistName).toBe(ARTIST_NAME);
        expect(res.body.lidarrFailed[0].albumTitle).toBe(LIDARR_TITLE);
        expect(res.body.lidarrFailed[0].reason).toContain(
            "Lidarr could not be reached or answered with an error"
        );
        expect(res.body.lidarrFailed[0].reason).toContain(String(port));

        await expectAlbumKeptInDiscover();

        const tray = await prisma.notification.findUnique({
            where: { userId_groupKey: { userId: USER, groupKey: TRAY_KEY } },
        });
        expect(tray).not.toBeNull();
        expect(tray!.type).toBe("error");
        expect(tray!.message).toContain(String(port));
    });

    it("a later clear in which the listener likes the album: the rows go and the tray row is cleared", async () => {
        // First clear, against a port nothing listens on: Lidarr cannot be reached,
        // so the album stays and the tray row appears.
        const port = await deadPort();
        await useLidarr(`http://127.0.0.1:${port}`);

        const first = await request(discoverApp()).delete("/discover/clear");
        expect(first.status).toBe(200);
        expect(first.body.activeDeleted).toBe(5);
        expect(first.body.lidarrFailed).toHaveLength(1);
        await expectAlbumKeptInDiscover();
        expect(
            await prisma.notification.count({ where: { userId: USER, groupKey: TRAY_KEY } })
        ).toBe(1);

        // The listener likes the Lidarr-held album the way the like route does
        // (its suggestion's release-group id): the ACTIVE suggestion becomes
        // LIKED, so no clear has to ask Lidarr to delete it any more.
        const like = await request(discoverApp()).post("/discover/like").send({ albumId: LIDARR_RG });
        expect(like.status).toBe(200);
        expect(like.body.success).toBe(true);
        expect(
            (await prisma.discoveryAlbum.findFirst({ where: { userId: USER, lidarrAlbumId: LIDARR_ALBUM_ID } }))
                ?.status
        ).toBe("LIKED");

        // Second clear: the like route already moved the album to the library,
        // so the clear finds nothing left to move, delete, or fail — and the
        // tray row goes.
        const second = await request(discoverApp()).delete("/discover/clear");
        expect(second.status).toBe(200);
        // The other five suggestions went in the first clear; the sixth is the
        // liked one, already LIBRARY from the like route's takeIntoLibrary.
        expect(second.body.activeDeleted).toBe(0);
        expect(second.body.likedMoved).toBe(0);
        expect(second.body.lidarrFailed).toEqual([]);

        // The album is the listener's now: LIBRARY, with the like's OwnedAlbum
        // mark. Its files stay on disk — deleting them was Lidarr's job, and
        // the suggestion no longer asks for it.
        const kept = await prisma.album.findUnique({ where: { id: `${P}_alb_lid` } });
        expect(kept?.location).toBe("LIBRARY");
        expect(
            await prisma.ownedAlbum.count({ where: { artistId: `${P}_art_a`, rgMbid: LIDARR_RG, source: "discovery_liked" } })
        ).toBe(1);
        expect(
            await prisma.discoveryAlbum.count({ where: { userId: USER, status: "ACTIVE" } })
        ).toBe(0);
        for (const t of TRACKS.filter((t) => t.album === `${P}_alb_lid`)) {
            expect(fs.existsSync(path.join(MUSIC, t.filePath))).toBe(true);
        }

        expect(
            await prisma.notification.count({ where: { userId: USER, groupKey: TRAY_KEY } })
        ).toBe(0);
    });
});
