/**
 * POST /downloads takes only a MusicBrainz id, refuses one MusicBrainz does not
 * know, and files an album under the artist its release group credits. Another
 * user's download of the same album is not a duplicate. An artist download
 * explains a refusal instead of failing with a server error. Real router and database;
 * auth, Lidarr, MusicBrainz and the download manager are stood in.
 */

jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "dlc_user" };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
const mockAddArtist = jest.fn();
jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        isEnabled: jest.fn().mockResolvedValue(true),
        addArtist: (...a: unknown[]) => mockAddArtist(...a),
    },
}));
const mockGetReleaseGroup = jest.fn();
const mockGetArtist = jest.fn();
const mockGetReleaseGroups = jest.fn();
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroup: (...a: unknown[]) => mockGetReleaseGroup(...a),
        getArtist: (...a: unknown[]) => mockGetArtist(...a),
        getReleaseGroups: (...a: unknown[]) => mockGetReleaseGroups(...a),
    },
}));
const mockStartDownload = jest.fn();
jest.mock("../../services/simpleDownloadManager", () => ({
    simpleDownloadManager: { startDownload: (...a: unknown[]) => mockStartDownload(...a) },
}));
jest.mock("../../services/lidarrFailures", () => ({ sweepFailedDownloads: jest.fn() }));

import express from "express";
import request from "supertest";
import downloadsRouter from "../downloads";
import { UserFacingError } from "../../utils/errors";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const app = express();
app.use(express.json());
mountAsServer(app, "/downloads", downloadsRouter, "/api/downloads");

const USER = "dlc_user";
const OTHER = "dlc_other";
const RG = "d1c00000-1111-2222-3333-444455556666";
const ALBUM = "d1c00001-1111-2222-3333-444455556666";
const LIBRARY_ALBUM = "d1c00002-1111-2222-3333-444455556666";
const MBIDS = [RG, ALBUM, LIBRARY_ALBUM];
const jobsOf = (userId = USER) => prisma.downloadJob.findMany({ where: { userId, targetMbid: { in: MBIDS } }, orderBy: { createdAt: "asc" } });

async function cleanup() {
    await prisma.downloadJob.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: "dlc_" } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: "dlc_" } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
}
const post = (mbid: string) =>
    request(app).post("/downloads").send({
        type: "album",
        mbid,
        subject: "low - Things We Lost in the Fire",
        artistName: "low",
        albumTitle: "Things We Lost in the Fire",
    });

beforeEach(async () => {
    await cleanup();
    for (const id of [USER, OTHER]) await prisma.user.create({ data: { id, username: id, passwordHash: "x" } });
    mockGetReleaseGroup.mockReset();
    mockGetArtist.mockReset();
    mockAddArtist.mockReset();
    mockStartDownload.mockReset().mockResolvedValue({ success: true });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

const startedWith = async () => {
    await new Promise((r) => setImmediate(r));
    return mockStartDownload.mock.calls[0];
};

describe("POST /downloads", () => {
    it.each(["temp-abc", "clx0abcd0000abcd", ""])("refuses %p as an id", async (mbid) => {
        const res = await post(mbid);

        expect(res.status).toBe(400);
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(0);
    });

    it.each([
        { kind: "absent", evidence: {} },
        { kind: "permanent", error: { code: "HTTP_400", message: "bad id" } },
    ])("refuses an album MusicBrainz does not know ($kind)", async (answer) => {
        mockGetReleaseGroup.mockResolvedValue(answer);

        const res = await post(RG);

        expect(res.status).toBe(404);
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(0);
    });

    it("treats only the caller's own active job as a duplicate", async () => {
        mockGetReleaseGroup.mockResolvedValue({ kind: "answered", value: {} });
        const others = await prisma.downloadJob.create({
            data: { userId: OTHER, subject: "low - Things", type: "album", targetMbid: RG, status: "processing" },
        });

        const first = await post(RG).expect(200);
        const second = await post(RG).expect(200);

        // Another user's job is no duplicate; the caller's own is.
        expect(first.body.duplicate).toBeUndefined();
        expect(first.body.id).not.toBe(others.id);
        expect(second.body).toMatchObject({ id: first.body.id, duplicate: true });
        expect(await jobsOf()).toHaveLength(1);
        expect(await jobsOf(OTHER)).toHaveLength(1);
    });

    it("keeps the requested name when MusicBrainz is down", async () => {
        expectLog("warn");
        mockGetReleaseGroup.mockResolvedValue({
            kind: "transient",
            error: { code: "ETIMEDOUT", message: "timeout" },
        });

        const res = await post(RG);

        expect(res.status).toBe(200);
        const [job] = await jobsOf();
        expect(job.metadata).toMatchObject({ artistName: "low" });
    });

    it("files the album under the release group's credited artist", async () => {
        mockGetReleaseGroup.mockResolvedValue({
            kind: "answered",
            value: { "artist-credit": [{ artist: { id: "x", name: "Low" } }] },
            evidence: {},
        });

        const res = await post(RG);

        expect(res.status).toBe(200);
        const [job] = await jobsOf();
        expect(job).toMatchObject({ id: res.body.id, status: "pending", targetMbid: RG, type: "album" });
        expect(job.metadata).toMatchObject({ artistName: "Low", albumTitle: "Things We Lost in the Fire" });
    });

    it("starts the album with the names it was given", async () => {
        mockGetReleaseGroup.mockResolvedValue({ kind: "answered", value: {} });

        const res = await post(RG).expect(200);

        expect(await startedWith()).toEqual([res.body.id, "low", "Things We Lost in the Fire", RG]);
    });

    it("reads the names from the subject when they are not given", async () => {
        mockGetReleaseGroup.mockResolvedValue({ kind: "answered", value: {} });

        const res = await request(app).post("/downloads").send({ type: "album", mbid: RG, subject: "low - Things - We Lost" }).expect(200);

        expect(await startedWith()).toEqual([res.body.id, "low", "Things - We Lost", RG]);
    });

    it("answers a second request for the same album with the job already queued", async () => {
        mockGetReleaseGroup.mockResolvedValue({ kind: "answered", value: {} });
        const queued = await prisma.downloadJob.create({
            data: { userId: USER, subject: "low - Things", type: "album", targetMbid: RG, status: "processing" },
        });

        const res = await post(RG).expect(200);

        expect(res.body).toMatchObject({ id: queued.id, status: "processing", duplicate: true });
        expect(await jobsOf()).toHaveLength(1);
        expect(mockStartDownload).not.toHaveBeenCalled();
    });

    describe("artist", () => {
        const postArtist = () =>
            request(app).post("/downloads").send({ type: "artist", mbid: RG, subject: "low" });

        it("refuses an artist id MusicBrainz does not know", async () => {
            mockGetArtist.mockResolvedValue({ kind: "absent", evidence: {} });

            const res = await postArtist();

            expect(res.status).toBe(404);
            expect(mockAddArtist).not.toHaveBeenCalled();
        });

        it("tells the user where to set Lidarr profiles", async () => {
            mockGetArtist.mockResolvedValue({ kind: "answered", value: { name: "Low" } });
            mockAddArtist.mockRejectedValue(
                new UserFacingError("Lidarr's music folder /music has no default profiles. Set them in Lidarr, or choose them in Kima's Lidarr settings", 409)
            );

            const res = await postArtist();

            expect(res.status).toBe(409);
            expect(res.body.error).toMatch(/has no default profiles/);
            expect(mockAddArtist).toHaveBeenCalledWith(RG, "Low", config.music.musicPath);
        });

        it("queues one job per album, each in one batch, and skips an album already in the library", async () => {
            mockGetArtist.mockResolvedValue({ kind: "answered", value: { name: "Low" } });
            mockAddArtist.mockResolvedValue({ id: 7 });
            mockGetReleaseGroups.mockResolvedValue({
                kind: "answered",
                value: [
                    { id: ALBUM, title: "Ones and Sixes" },
                    { id: LIBRARY_ALBUM, title: "Double Negative" },
                ],
            });
            await prisma.artist.create({ data: { id: "dlc_art", name: "Low", normalizedName: "low", identityKey: "dlclow" } });
            await prisma.album.create({
                data: { id: "dlc_alb", rgMbid: LIBRARY_ALBUM, artistId: "dlc_art", identityKey: "dlc_ik", title: "Double Negative", primaryType: "Album", location: "LIBRARY" },
            });

            const res = await postArtist().expect(200);

            const jobs = await jobsOf();
            expect(jobs).toHaveLength(1);
            expect(res.body).toMatchObject({ albumCount: 1, jobs: [{ id: jobs[0].id, subject: "Low - Ones and Sixes" }] });
            expect(jobs[0]).toMatchObject({ targetMbid: ALBUM, artistMbid: RG, status: "pending" });
            const metadata = jobs[0].metadata as Record<string, unknown>;
            expect(Object.keys(metadata).sort()).toEqual(
                ["albumTitle", "artistMbid", "artistName", "batchId", "downloadType", "rootFolderPath"],
            );
            expect(await startedWith()).toEqual([jobs[0].id, "Low", "Ones and Sixes", ALBUM]);
        });
    });
});

describe("GET /downloads", () => {
    it("is gone: the web and the app read active downloads from the notifications", async () => {
        await request(app).get("/downloads").expect(404);
    });
});
