/**
 * Two users can each have a job on the same Lidarr album. A grab, an import and
 * a failure reach both jobs, and the album stays monitored while either still
 * wants it.
 */

import { prisma } from "../../utils/db";
import { useLidarrCancelScenario } from "../../__tests__/helpers/lidarrCancelScenario";
import { simpleDownloadManager } from "../simpleDownloadManager";
import * as downloadJobs from "../downloads/jobs";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const { unmonitored } = useLidarrCancelScenario();

const ALICE = "sdm_shared_alice";
const BOB = "sdm_shared_bob";
const ALBUM = 42;

const job = (id: string, userId: string, data: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: {
            id,
            userId,
            subject: "Interpol - Antics",
            type: "album",
            status: "processing",
            attempts: 1,
            targetMbid: "rg-antics",
            lidarrAlbumId: ALBUM,
            metadata: { artistName: "Interpol", albumTitle: "Antics" },
            ...data,
        },
    });

const row = (id: string) => prisma.downloadJob.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
    for (const id of [ALICE, BOB]) {
        await prisma.user.create({ data: { id, username: id, passwordHash: "x", role: "user", tokenVersion: 0 } });
    }
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: { in: [ALICE, BOB] } } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
    await closeEngineConnections();
});

it("gives Lidarr's grab to every job waiting for the album", async () => {
    await job("sdm_a", ALICE);
    await job("sdm_b", BOB);

    const result = await simpleDownloadManager.onDownloadGrabbed("dl-1", "rg-antics", "Antics", "Interpol", ALBUM);

    expect(result.matched).toBe(true);
    expect((await row("sdm_a")).lidarrRef).toBe("dl-1");
    expect((await row("sdm_b")).lidarrRef).toBe("dl-1");
});

it("does not credit a grab nobody asked for to a user who wanted another album", async () => {
    await job("sdm_a", ALICE, { status: "completed", lidarrRef: "dl-old" });

    const result = await simpleDownloadManager.onDownloadGrabbed(
        "dl-2", "rg-bright", "Turn on the Bright Lights", "Interpol", 43
    );

    expect(result).toEqual({ matched: false });
    expect(await prisma.downloadJob.count({ where: { userId: { in: [ALICE, BOB] } } })).toBe(1);
});

it("completes every job on the album when the import names only the download", async () => {
    await job("sdm_a", ALICE, { lidarrRef: "dl-1" });
    await job("sdm_b", BOB);

    await simpleDownloadManager.onDownloadComplete("dl-1");

    expect((await row("sdm_a")).status).toBe("completed");
    expect((await row("sdm_b")).status).toBe("completed");
});

it("still names the job when another path completed it between the read and the move", async () => {
    await job("sdm_a", ALICE, { lidarrRef: "dl-1" });
    const realComplete = downloadJobs.complete;
    const spy = jest.spyOn(downloadJobs, "complete").mockImplementationOnce(async (jobs, extra) => {
        await realComplete(jobs, { by: "the-other-path" });
        return realComplete(jobs, extra);
    });

    const result = await simpleDownloadManager.onDownloadComplete("dl-1");
    spy.mockRestore();

    expect(result.jobId).toBe("sdm_a");
    expect((await row("sdm_a")).status).toBe("completed");
});

it("counts one failure against each job and keeps searching", async () => {
    await job("sdm_a", ALICE, { lidarrRef: "dl-1" });
    await job("sdm_b", BOB, { lidarrRef: "dl-1" });

    const result = await simpleDownloadManager.onImportFailed("dl-1", "Import failed");

    expect(result.searchAgain).toBe(true);
    expect((await row("sdm_a")).attempts).toBe(2);
    expect((await row("sdm_b")).attempts).toBe(2);
    expect(unmonitored()).toEqual([]);
});

it("keeps the album monitored while another user's job still wants it", async () => {
    await job("sdm_a", ALICE, { lidarrRef: "dl-1", attempts: 3 });
    await job("sdm_b", BOB, { lidarrRef: "dl-1" });

    const result = await simpleDownloadManager.onImportFailed("dl-1", "Import failed");

    expect(result.searchAgain).toBe(true);
    expect(unmonitored()).toEqual([]);
    expect((await row("sdm_a")).status).toBe("failed");
    expect((await row("sdm_b")).status).toBe("processing");
});

it("unmonitors the album once no job wants it", async () => {
    await job("sdm_a", ALICE, { lidarrRef: "dl-1", attempts: 3 });
    await job("sdm_b", BOB, { lidarrRef: "dl-1", attempts: 3 });

    const result = await simpleDownloadManager.onImportFailed("dl-1", "Import failed");

    expect(result.searchAgain).toBe(false);
    expect(unmonitored()).toEqual([[ALBUM]]);
});

it("restarts the clock on a job that searches again", async () => {
    const started = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await job("sdm_a", ALICE, {
        lidarrRef: "dl-1",
        metadata: { artistName: "Interpol", albumTitle: "Antics", startedAt: started },
    });

    await simpleDownloadManager.onImportFailed("dl-1", "Import failed");

    const restarted = Date.parse((await row("sdm_a")).metadata!["startedAt" as never]);
    expect(restarted).toBeGreaterThan(Date.now() - 60_000);
});
