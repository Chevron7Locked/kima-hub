/**
 * When an import's downloads run out the ten-minute wait, the still-waiting jobs fail through the download-job
 * module and the import's log says how the downloads ended: counted after that settle, not before it. Real database
 * and Redis; the import's own log, the queue and the library scan are stubbed.
 */

const lines: string[] = [];

jest.mock("../../utils/playlistLogger", () => {
    const actual = jest.requireActual("../../utils/playlistLogger");
    const logger = new Proxy({}, { get: () => (message: unknown) => { if (typeof message === "string") lines.push(message); } });
    return { ...actual, createPlaylistLogger: () => logger };
});
jest.mock("../../workers/queues", () => ({ importQueue: { add: jest.fn().mockResolvedValue(undefined) } }));
jest.mock("../../workers/scanRequest", () => ({ requestScan: jest.fn().mockResolvedValue({ queued: true, jobId: "scan-1" }) }));

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { playlistImportService } from "../playlistImport";
import * as downloadJobs from "../downloads/jobs";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const USER = "sitc_user";
const preview = {
    summary: { total: 2, inLibrary: 0 },
    albumsToDownload: [],
    matchedTracks: [],
} as never;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("logs the counts after the timeout settle", async () => {
    const importJob = await playlistImportService.startImport(USER, "pl", "Road Trip", [], preview);
    // The check acts on an import that is downloading, not one still queued.
    await prisma.spotifyImportJob.update({ where: { id: importJob.id }, data: { status: "downloading" } });
    const job = (subject: string, status: string, ageMs: number) =>
        prisma.downloadJob.create({
            data: {
                userId: USER, type: "album", status, subject, createdAt: new Date(Date.now() - ageMs),
                metadata: { spotifyImportJobId: importJob.id, artistName: "Brad Sucks", albumTitle: subject },
            },
        });
    await job("done", "completed", 20 * 60_000);
    await job("stuck", "processing", 20 * 60_000);

    await playlistImportService.checkImportCompletion(importJob.id);
    await downloadJobs.whenIdle();

    // Every report of the finish says the same: the settle also tells the import, whose own check reports too.
    const finished = lines.filter((l) => l.includes("download jobs finished"));
    expect(finished.length).toBeGreaterThan(0);
    expect(new Set(finished)).toEqual(new Set(["All 2 download jobs finished (1 completed, 1 failed)"]));
    await redisClient.del(`import:job:${importJob.id}`, `import:preview:${importJob.id}`);
    await prisma.spotifyImportJob.deleteMany({ where: { id: importJob.id } });
});
