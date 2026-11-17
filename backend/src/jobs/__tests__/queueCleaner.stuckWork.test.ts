/**
 * Stuck work is recovered whatever the download source: with no Lidarr set up at
 * all, a Spotify import stuck scanning past its deadline is failed and a Discover
 * batch stuck past its deadline is closed. Real database.
 */

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { eventBus, type SSEEvent } from "../../services/eventBus";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { queueCleaner } from "../queueCleaner";
import * as downloadJobs from "../../services/downloads/jobs";
import * as scanRequest from "../../workers/scanRequest";

jest.setTimeout(30_000);

const USER = "stuck_work_user";
const HOURS = 60 * 60 * 1000;

beforeAll(async () => {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", lidarrEnabled: false, lidarrUrl: null, lidarrApiKey: null },
        update: { lidarrEnabled: false, lidarrUrl: null, lidarrApiKey: null },
    });
    invalidateSystemSettingsCache();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("fails a Spotify import left scanning past its deadline, with no Lidarr set up", async () => {
    const job = await prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status: "scanning", albumsTotal: 1, tracksTotal: 1, pendingTracks: [],
        },
    });
    await prisma.$executeRaw`UPDATE "SpotifyImportJob" SET "updatedAt" = now() - interval '45 minutes' WHERE id = ${job.id}`;

    await queueCleaner.recoverStuckWork();

    expect(await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: "failed",
        error: "Scan timed out after 30 minutes",
    });
});

it("tells the person's import page when it fails a scan that timed out", async () => {
    const job = await prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status: "scanning", albumsTotal: 1, tracksTotal: 1, pendingTracks: [],
        },
    });
    await prisma.$executeRaw`UPDATE "SpotifyImportJob" SET "updatedAt" = now() - interval '45 minutes' WHERE id = ${job.id}`;
    const heard: SSEEvent[] = [];
    const stop = eventBus.subscribe(USER, { send: (event) => (heard.push(event), true) });

    await queueCleaner.recoverStuckWork();
    stop();

    expect(heard).toEqual(expect.arrayContaining([
        expect.objectContaining({
            type: "import:progress",
            payload: expect.objectContaining({ jobId: job.id, status: "failed", error: "Scan timed out after 30 minutes" }),
        }),
    ]));
});

it("does not lower an import's progress, nor write to one that closed, when it asks for a new scan", async () => {
    const job = await prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status: "scanning", progress: 75, albumsTotal: 1, tracksTotal: 1, pendingTracks: [],
        },
    });
    await prisma.$executeRaw`UPDATE "SpotifyImportJob" SET "updatedAt" = now() - interval '15 minutes' WHERE id = ${job.id}`;
    // The scan is asked for, and the import completes while the request is made.
    const ask = jest.spyOn(scanRequest, "requestScan").mockImplementation((async () => {
        await prisma.spotifyImportJob.update({ where: { id: job.id }, data: { status: "completed", progress: 100 } });
        return { queued: true, jobId: "stub" };
    }) as never);

    await queueCleaner.recoverStuckWork();
    ask.mockRestore();

    expect(await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "completed", progress: 100 });
    await prisma.spotifyImportJob.deleteMany({ where: { id: job.id } });
});

it("closes a Discover batch left downloading past its two-hour limit, with no Lidarr set up", async () => {
    const batch = await prisma.discoveryBatch.create({
        data: {
            userId: USER, weekStart: new Date("2026-10-05T00:00:00.000Z"), targetSongCount: 1, totalAlbums: 1,
            status: "downloading", createdAt: new Date(Date.now() - 3 * HOURS),
        },
    });

    await queueCleaner.recoverStuckWork();

    expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
        status: "failed",
        errorMessage: "Batch timed out after 2 hours",
    });
});

describe("a cancelled import whose clean-up stopped part-way", () => {
    const cancelledImport = async (minutesAgo: number) => {
        const job = await prisma.spotifyImportJob.create({
            data: {
                userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
                status: "cancelled", albumsTotal: 1, tracksTotal: 1, pendingTracks: [],
            },
        });
        await prisma.$executeRaw`UPDATE "SpotifyImportJob" SET "updatedAt" = now() - make_interval(mins => ${minutesAgo}::int) WHERE id = ${job.id}`;
        await prisma.downloadJob.create({
            data: {
                id: `${job.id}-dl`, userId: USER, subject: "Album", type: "album", status: "failed",
                metadata: { downloadType: "spotify_import", spotifyImportJobId: job.id },
            },
        });
        return job;
    };

    afterEach(async () => {
        await prisma.downloadJob.deleteMany({ where: { userId: USER } });
        await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    });

    it("finishes the clean-up once it has sat for a while", async () => {
        const job = await cancelledImport(30);

        await queueCleaner.recoverStuckWork();
        await downloadJobs.whenIdle();

        expect(await prisma.spotifyImportJob.findUnique({ where: { id: job.id } })).toBeNull();
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(0);
    });

    it("leaves a cancel that is still being carried out", async () => {
        const job = await cancelledImport(0);

        await queueCleaner.recoverStuckWork();
        await downloadJobs.whenIdle();

        expect(await prisma.spotifyImportJob.findUnique({ where: { id: job.id } })).not.toBeNull();
    });
});
