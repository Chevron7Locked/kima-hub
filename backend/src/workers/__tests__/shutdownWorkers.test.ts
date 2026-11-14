// shutdownWorkers stops the workers and crons and closes their queues. `enrichmentStateService` is shared with
// code outside the workers, so its connections close once, in the server's own close steps (closeSteps.ts), not here too.
// Everything the workers module starts is replaced, so the test only asks what shutdown does. The database is the
// real one: the only thing asked of it is that its client is disconnected once, which a spy on the real client records.

const mockDisconnect = jest.fn(async () => {});
const mockStops = {
    unified: jest.fn(async () => {}),
    mood: jest.fn(),
    discoverCron: jest.fn(),
    cleanupCron: jest.fn(),
    syncCron: jest.fn(),
};
const mockClose = jest.fn(async () => {});
const mockIntegrity = jest.fn();

jest.mock("bullmq", () => ({
    Worker: class {
        on() {
            return this;
        }
        close = mockClose;
    },
}));
jest.mock("../queues", () => ({
    scanQueue: { close: mockClose },
    discoverQueue: { close: mockClose },
    importQueue: { close: mockClose },
}));
jest.mock("../enrichmentQueues", () => ({ createWorkerConnection: jest.fn() }));
jest.mock("../processors/scanProcessor", () => ({ processScan: jest.fn() }));
jest.mock("../processors/refileProcessor", () => ({ processRefile: jest.fn() }));
jest.mock("../processors/discoverProcessor", () => ({ processDiscoverWeekly: jest.fn() }));
jest.mock("../processors/importProcessor", () => ({ processImportJob: jest.fn() }));
jest.mock("../scanRequest", () => ({ requestScan: jest.fn() }));
const mockRedisQuit = jest.fn(async () => {});
const mockSoulseekDisconnect = jest.fn();
jest.mock("../../services/soulseek", () => ({ soulseekService: { disconnect: mockSoulseekDisconnect } }));
jest.mock("../../utils/redis", () => ({ redisClient: { quit: mockRedisQuit } }));
jest.mock("../../services/stages/stageRecords", () => ({ SCAN_AGAIN_KEY: "scan-again" }));
jest.mock("../../services/spotifyImport", () => ({ spotifyImportService: {} }));
jest.mock("../unifiedEnrichment", () => ({
    startUnifiedEnrichmentWorker: jest.fn(async () => {}),
    triggerEnrichmentNow: jest.fn(),
    stopUnifiedEnrichmentWorker: mockStops.unified,
}));
jest.mock("../moodSnapshotWorker", () => ({
    startMoodSnapshotWorker: jest.fn(async () => {}),
    stopMoodSnapshotWorker: mockStops.mood,
}));
jest.mock("../discoverCron", () => ({ startDiscoverWeeklyCron: jest.fn(), stopDiscoverWeeklyCron: mockStops.discoverCron }));
jest.mock("../dataCleanup", () => ({ startDataCleanupCron: jest.fn(), stopDataCleanupCron: mockStops.cleanupCron }));
jest.mock("../librarySyncCron", () => ({ startLibrarySyncCron: jest.fn(), stopLibrarySyncCron: mockStops.syncCron }));
jest.mock("../dataIntegrity", () => ({ runDataIntegrityCheck: mockIntegrity }));
jest.mock("../../services/simpleDownloadManager", () => ({ simpleDownloadManager: {} }));
jest.mock("../../services/lidarrFailures", () => ({ sweepFailedDownloads: jest.fn() }));
jest.mock("../../jobs/queueCleaner", () => ({ queueCleaner: {} }));
jest.mock("../../services/mixes/radioRow", () => ({ warmRadioCovers: jest.fn() }));
jest.mock("../../services/enrichmentState", () => ({ enrichmentStateService: { disconnect: mockDisconnect } }));

import { shutdownWorkers } from "../index";
import { closeSteps } from "../../closeSteps";
import { prisma } from "../../utils/db";

// Spied without running: nothing here connected, and the suite's other files keep their own clients.
const mockDbDisconnect = jest.spyOn(prisma, "$disconnect").mockResolvedValue();

describe("shutdownWorkers", () => {
    it("stops every worker and cron and closes the queues", async () => {
        await shutdownWorkers();

        for (const stop of Object.values(mockStops)) expect(stop).toHaveBeenCalledTimes(1);
        // three workers and three queues
        expect(mockClose).toHaveBeenCalledTimes(6);
    });

    it("leaves enrichmentStateService to the server's close steps, which close it once", async () => {
        mockDisconnect.mockClear();

        await shutdownWorkers();

        expect(mockDisconnect).not.toHaveBeenCalled();
    });

    it("is closed once by the server's own close list: workers, Soulseek, enrichmentStateService, Redis, the database", async () => {
        for (const close of closeSteps) await close();

        expect(mockDisconnect).toHaveBeenCalledTimes(1);
        expect(mockSoulseekDisconnect).toHaveBeenCalledTimes(1);
        expect(mockRedisQuit).toHaveBeenCalledTimes(1);
        expect(mockDbDisconnect).toHaveBeenCalledTimes(1);
        // the three workers and three queues of shutdownWorkers
        expect(mockClose).toHaveBeenCalledTimes(6);
    });

    it("schedules nothing afterwards, even for a cycle that was still running when it cleared the timers", async () => {
        jest.useFakeTimers();
        try {
            let finishCycle!: () => void;
            mockIntegrity.mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        finishCycle = resolve;
                    }),
            );
            let workers!: typeof import("../index");
            jest.isolateModules(() => {
                workers = require("../index");
            });

            await jest.advanceTimersByTimeAsync(10_000); // the data integrity cycle starts and stays running
            expect(mockIntegrity).toHaveBeenCalledTimes(1);

            await workers.shutdownWorkers();
            finishCycle(); // it ends after shutdown, where it used to schedule its next run
            await jest.advanceTimersByTimeAsync(0);

            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});
