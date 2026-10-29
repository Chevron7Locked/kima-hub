/**
 * Retrying a playlist's pending song through Soulseek, from the playlist (one song or all) and from a failed download
 * in Activity: each retry is a download job that ends completed with the file, or failed with the reason, and a
 * finished download asks for a scan. A retry from Activity checks the song is still the caller's before it clears the
 * failed row. Real database and routers; Soulseek, the settings and the scan queue are stood in for.
 */

const mockSearch = jest.fn();
const mockDownload = jest.fn();
const mockAvailable = jest.fn();
jest.mock("../../services/soulseek", () => ({
    soulseekService: {
        isAvailable: () => mockAvailable(),
        searchTrack: (...a: unknown[]) => mockSearch(...a),
        downloadBestMatch: (...a: unknown[]) => mockDownload(...a),
    },
}));
const mockSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    ...jest.requireActual("../../utils/systemSettings"),
    getSystemSettings: () => mockSettings(),
}));
const mockScan = jest.fn();
jest.mock("../../workers/scanRequest", () => ({ requestScan: (...a: unknown[]) => mockScan(...a) }));
jest.mock("../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"], role: "user" };
        next();
    };
    return {
        requireAuth: signIn,
        requireAuthOrToken: signIn,
        requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    };
});

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import playlistsRoutes from "../playlists";
import notificationRoutes from "../notifications";

const P = "ptr";
const OWNER = `${P}_owner`;
const OTHER = `${P}_other`;
const app = express().use(express.json()).use("/playlists", playlistsRoutes).use("/notifications", notificationRoutes);
const as = (user: string) => ({ "x-user": user });
const MATCH = [{ filename: "a.flac" }];

let playlistId: string;

async function pending(title: string) {
    return prisma.playlistPendingTrack.create({
        data: { playlistId, spotifyArtist: "Low", spotifyTitle: title, spotifyAlbum: "Things We Lost", albumMbid: `${P}-rg-${title}`, sort: 0, rank: `a${title}` },
    });
}

/** The job's final state, once the background download has finished with it. */
async function settled(jobId: string) {
    for (let i = 0; i < 100; i++) {
        const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
        if (job.status !== "processing") return job;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`job ${jobId} never finished`);
}
const jobsFor = (pendingTrackId: string) =>
    prisma.downloadJob.findMany({ where: { userId: OWNER, metadata: { path: ["pendingTrackId"], equals: pendingTrackId } }, orderBy: { createdAt: "asc" } });

async function cleanup() {
    await prisma.downloadJob.deleteMany({ where: { userId: { in: [OWNER, OTHER] } } });
    await prisma.user.deleteMany({ where: { id: { in: [OWNER, OTHER] } } });
}

beforeAll(async () => {
    await cleanup();
    for (const id of [OWNER, OTHER]) await prisma.user.create({ data: { id, username: id, passwordHash: "x" } });
});

beforeEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: OWNER } });
    await prisma.playlist.deleteMany({ where: { userId: OWNER } });
    playlistId = (await prisma.playlist.create({ data: { userId: OWNER, name: `${P} list` } })).id;
    mockSettings.mockReset().mockResolvedValue({ musicPath: "/music" });
    mockAvailable.mockReset().mockResolvedValue(true);
    mockSearch.mockReset().mockResolvedValue({ found: true, allMatches: MATCH });
    mockDownload.mockReset().mockResolvedValue({ success: true, filePath: "/music/Low/a.flac" });
    mockScan.mockReset().mockResolvedValue({ queued: true, jobId: "scan-1" });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("POST /playlists/:id/pending/:trackId/retry", () => {
    const retry = (id: string) => request(app).post(`/playlists/${playlistId}/pending/${id}/retry`).set(as(OWNER));

    it("downloads the best match, completes the job with the file and asks for a scan", async () => {
        const pt = await pending("Sunflower");

        const res = await retry(pt.id).expect(200);

        expect(res.body).toMatchObject({ success: true, downloadJobId: expect.any(String) });
        const job = await settled(res.body.downloadJobId);
        expect(job).toMatchObject({ status: "completed", type: "track", targetMbid: pt.albumMbid });
        expect(job.metadata).toMatchObject({ downloadType: "pending-track-retry", playlistId, pendingTrackId: pt.id, filePath: "/music/Low/a.flac" });
        expect(mockDownload).toHaveBeenCalledWith("Low", "Sunflower", "Things We Lost", MATCH, "/music");
        expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER, source: "retry-pending-track", albumMbid: pt.albumMbid }));
    });

    it("says so when Soulseek has nothing, and fails the job", async () => {
        const pt = await pending("Tonight");
        mockSearch.mockResolvedValue({ found: false, allMatches: [] });

        const res = await retry(pt.id).expect(200);

        expect(res.body).toMatchObject({ success: false, error: "No matching files found" });
        const [job] = await jobsFor(pt.id);
        expect(job).toMatchObject({ status: "failed", error: "No matching files found" });
        expect(mockDownload).not.toHaveBeenCalled();
    });

    it("fails the job with the download's reason", async () => {
        const pt = await pending("Laser Beam");
        mockDownload.mockResolvedValue({ success: false, error: "peer went away" });

        const res = await retry(pt.id).expect(200);

        expect(await settled(res.body.downloadJobId)).toMatchObject({ status: "failed", error: "peer went away" });
        expect(mockScan).not.toHaveBeenCalled();
    });

    it("refuses without a music folder", async () => {
        const pt = await pending("Point of Disgust");
        mockSettings.mockResolvedValue({ musicPath: null });

        expect((await retry(pt.id).expect(400)).body.error).toBe("Music path not configured");
    });

    it("fails the job when the search itself fails", async () => {
        const pt = await pending("Monkey");
        mockSearch.mockRejectedValue(new Error("slskd is down"));

        await retry(pt.id).expect(500);

        const [job] = await jobsFor(pt.id);
        expect(job).toMatchObject({ status: "failed", error: "slskd is down" });
    });

    it("refuses when Soulseek is not set up, and the failed job says why", async () => {
        const pt = await pending("Dinosaur Act");
        mockAvailable.mockResolvedValue(false);

        const res = await retry(pt.id).expect(400);

        expect(res.body.error).toBe("Soulseek is turned off or not set up");
        const [job] = await jobsFor(pt.id);
        expect(job).toMatchObject({ status: "failed", error: "Soulseek is turned off or not set up" });
        expect(mockSearch).not.toHaveBeenCalled();
    });
});

describe("POST /playlists/:id/pending/retry-all", () => {
    it("retries every pending song in turn, each job ending on its own outcome", async () => {
        const found = await pending("Canada");
        const missing = await pending("Pissing");
        mockSearch.mockImplementation(async (_artist: string, title: string) => (title === "Canada" ? { found: true, allMatches: MATCH } : { found: false, allMatches: [] }));

        const res = await request(app).post(`/playlists/${playlistId}/pending/retry-all`).set(as(OWNER)).expect(200);

        expect(res.body).toMatchObject({ success: true, queued: 2 });
        const [a] = await jobsFor(found.id);
        const [b] = await jobsFor(missing.id);
        expect(await settled(a.id)).toMatchObject({ status: "completed" });
        expect(await settled(b.id)).toMatchObject({ status: "failed", error: "No matching files found" });
        expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({ source: "retry-pending-track-batch", albumMbid: found.albumMbid }));
    });

    it("queues nothing when Soulseek is not set up", async () => {
        const pt = await pending("Murderer");
        mockAvailable.mockResolvedValue(false);

        const res = await request(app).post(`/playlists/${playlistId}/pending/retry-all`).set(as(OWNER)).expect(400);

        expect(res.body.error).toBe("Soulseek is turned off or not set up");
        expect(await jobsFor(pt.id)).toEqual([]);
    });
});

describe("POST /notifications/downloads/:id/retry of a pending song", () => {
    async function failedRetryOf(pendingTrackId: string, onPlaylist = playlistId) {
        return prisma.downloadJob.create({
            data: {
                userId: OWNER, subject: "Low - x", type: "track", targetMbid: `pendingTrack:${pendingTrackId}`, status: "failed",
                metadata: { downloadType: "pending-track-retry", playlistId: onPlaylist, pendingTrackId },
            },
        });
    }
    const retryFromActivity = (jobId: string) => request(app).post(`/notifications/downloads/${jobId}/retry`).set(as(OWNER));

    it("starts a new job and clears the failed one", async () => {
        const pt = await pending("Words");
        const failed = await failedRetryOf(pt.id);

        const res = await retryFromActivity(failed.id).expect(200);

        expect(res.body).toMatchObject({ success: true, newJobId: expect.any(String) });
        expect(await settled(res.body.newJobId)).toMatchObject({ status: "completed" });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: failed.id } })).cleared).toBe(true);
    });

    it("keeps the failed row when the song is no longer on that playlist", async () => {
        const pt = await pending("Over the Ocean");
        const elsewhere = await prisma.playlist.create({ data: { userId: OWNER, name: `${P} other list` } });
        const failed = await failedRetryOf(pt.id, elsewhere.id);

        await retryFromActivity(failed.id).expect(404);

        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: failed.id } })).cleared).toBe(false);
        expect(mockSearch).not.toHaveBeenCalled();
    });

    it("keeps the failed row when the playlist is gone", async () => {
        const pt = await pending("Two-Step");
        const failed = await failedRetryOf(pt.id, "no-such-playlist");

        await retryFromActivity(failed.id).expect(404);

        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: failed.id } })).cleared).toBe(false);
    });
});
