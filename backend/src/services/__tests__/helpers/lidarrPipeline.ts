import { prisma } from "../../../utils/db";
import { waitForRedisReady } from "../../../utils/redis";
import { loadRecording, startReplayServer, type ReplayServer } from "../../../__tests__/helpers/replayServer";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

/**
 * The download pipeline's modules, loaded after MusicBrainz points at a replay of its recorded answers (the service
 * reads that address when it is built), and a listener to own the jobs.
 */
export async function setUpPipeline(userId: string) {
    await waitForRedisReady();
    const mb: ReplayServer = await startReplayServer(loadRecording("musicbrainz", "lidarr-pipeline"));
    process.env.MUSICBRAINZ_BASE_URL = mb.url;
    const modules = {
        lidarr: await import("../../lidarr"),
        manager: (await import("../../simpleDownloadManager")).simpleDownloadManager,
        dispatch: (await import("../../webhookHandlers")).dispatchWebhookEvent,
        sweep: (await import("../../lidarrFailures")).sweepFailedDownloads,
        useLidarr: (await import("../../../__tests__/helpers/lidarrSettings")).useLidarr,
    };
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.user.create({ data: { id: userId, username: userId, passwordHash: "x", role: "user", tokenVersion: 0 } });
    return { mb, ...modules };
}

/** Removes what one test's downloads left behind. */
export async function clearDownloads(userId: string) {
    await prisma.downloadJob.deleteMany({ where: { userId } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.handledDownload.deleteMany({});
}

export async function tearDownPipeline(userId: string, mb: ReplayServer) {
    await prisma.user.deleteMany({ where: { id: userId } });
    await mb.close();
    delete process.env.MUSICBRAINZ_BASE_URL;
    await closeEngineConnections();
}
