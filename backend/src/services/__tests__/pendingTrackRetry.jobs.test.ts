/**
 * A pending song's retry settles its download job through the download-job module: a download that lands completes
 * the job with the file's path, one that cannot be found or fetched fails it with the reason and the failure marks,
 * and a job someone cancelled meanwhile stays cancelled. A retry is the user's own request, so it sends no tray row.
 * Real database; Soulseek and the scan queue are stubbed.
 */
jest.mock("../soulseek", () => ({
    soulseekService: { isAvailable: jest.fn(), searchTrack: jest.fn(), downloadBestMatch: jest.fn() },
}));
jest.mock("../../workers/scanRequest", () => ({ requestScan: jest.fn().mockResolvedValue({ queued: true, jobId: "scan-1" }) }));

import type { DownloadJob, PlaylistPendingTrack } from "@prisma/client";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { soulseekService } from "../soulseek";
import { requestScan } from "../../workers/scanRequest";
import * as downloadJobs from "../downloads/jobs";
import { createRetryJob, downloadSources, failRetryJob, findSources, NO_SOURCES } from "../pendingTrackRetry";

jest.setTimeout(30_000);

const USER = "pending_retry_jobs_user";
const soulseek = soulseekService as unknown as Record<"searchTrack" | "downloadBestMatch", jest.Mock>;
const PENDING = {
    id: "pending-track-1", playlistId: "playlist-1", spotifyArtist: "Brad Sucks", spotifyTitle: "Dropping Out of School",
    spotifyAlbum: "I Don't Know What I'm Doing", albumMbid: null, artistMbid: null,
} as unknown as PlaylistPendingTrack;

const newJob = () => createRetryJob(USER, PENDING);
const read = (id: string) => prisma.downloadJob.findUniqueOrThrow({ where: { id } });
const trayRows = () => prisma.notification.count({ where: { userId: USER } });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

beforeEach(() => {
    soulseek.searchTrack.mockReset();
    soulseek.downloadBestMatch.mockReset();
    (requestScan as jest.Mock).mockClear();
});

it("fails the job with the reason and the failure marks", async () => {
    const job = await newJob();

    await failRetryJob(job.id, "Soulseek is turned off or not set up");

    const row = await read(job.id);
    expect(row).toMatchObject({ status: "failed", error: "Soulseek is turned off or not set up" });
    expect(row.completedAt).not.toBeNull();
    expect(row.metadata).toMatchObject({ downloadType: "pending-track-retry", statusText: "Soulseek is turned off or not set up" });
    expect(row.metadata).toHaveProperty("failedAt");
    expect(await trayRows()).toBe(0);
});

it("fails the job when Soulseek has no files for the song", async () => {
    soulseek.searchTrack.mockResolvedValue({ found: false, allMatches: [] });
    const job = await newJob();

    expect(await findSources(job, PENDING)).toEqual([]);

    expect(await read(job.id)).toMatchObject({ status: "failed", error: NO_SOURCES });
});

it("completes the job with the file's path, keeps its metadata, and asks for a scan", async () => {
    soulseek.downloadBestMatch.mockResolvedValue({ success: true, filePath: "/music/Brad Sucks/song.flac" });
    const job = await newJob();

    await downloadSources(job, PENDING, [{ file: "song.flac" }] as never, "/music", "playlist-retry");

    const row = await read(job.id);
    expect(row).toMatchObject({ status: "completed", error: null });
    expect(row.completedAt).not.toBeNull();
    expect(row.metadata).toMatchObject({
        downloadType: "pending-track-retry", pendingTrackId: PENDING.id, filePath: "/music/Brad Sucks/song.flac",
    });
    expect(requestScan).toHaveBeenCalledTimes(1);
    expect(await trayRows()).toBe(0);
});

it("fails the job when the download fails", async () => {
    soulseek.downloadBestMatch.mockResolvedValue({ success: false, error: "peer went offline" });
    const job = await newJob();

    await downloadSources(job, PENDING, [{ file: "song.flac" }] as never, "/music", "playlist-retry");

    const row = await read(job.id);
    expect(row).toMatchObject({ status: "failed", error: "peer went offline" });
    expect(row.metadata).toHaveProperty("failedAt");
    expect(requestScan).not.toHaveBeenCalled();
});

it("leaves a job cancelled while the download ran as cancelled", async () => {
    const job = await newJob();
    soulseek.downloadBestMatch.mockImplementation(async () => {
        await downloadJobs.cancel([job]);
        return { success: true, filePath: "/music/Brad Sucks/song.flac" };
    });

    await downloadSources(job as DownloadJob, PENDING, [{ file: "song.flac" }] as never, "/music", "playlist-retry");

    const row = await read(job.id);
    expect(row).toMatchObject({ status: "failed", error: "Cancelled by user" });
    expect(row.metadata).toMatchObject({ cancelled: true });
    expect(row.metadata).not.toHaveProperty("filePath");
});
