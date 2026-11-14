// shutdownWorkers stops the workers and crons and closes their queues. The enrichment state service is shared with
// code outside the workers, so its connections close once, in the server's own close steps (index.ts), not here too.
// Everything the workers module starts is replaced, so the test only asks what shutdown does.

const mockDisconnect = jest.fn(async () => {});
const mockStops = {
    unified: jest.fn(async () => {}),
    mood: jest.fn(),
    discoverCron: jest.fn(),
    cleanupCron: jest.fn(),
    syncCron: jest.fn(),
};
const mockClose = jest.fn(async () => {});

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
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../utils/redis", () => ({ redisClient: {} }));
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
jest.mock("../dataIntegrity", () => ({ runDataIntegrityCheck: jest.fn() }));
jest.mock("../../services/simpleDownloadManager", () => ({ simpleDownloadManager: {} }));
jest.mock("../../services/lidarrFailures", () => ({ sweepFailedDownloads: jest.fn() }));
jest.mock("../../jobs/queueCleaner", () => ({ queueCleaner: {} }));
jest.mock("../../services/mixes/radioRow", () => ({ warmRadioCovers: jest.fn() }));
jest.mock("../../services/enrichmentState", () => ({ enrichmentStateService: { disconnect: mockDisconnect } }));

import { shutdownWorkers } from "../index";

describe("shutdownWorkers", () => {
    it("stops every worker and cron and closes the queues", async () => {
        await shutdownWorkers();

        for (const stop of Object.values(mockStops)) expect(stop).toHaveBeenCalledTimes(1);
        // three workers and three queues
        expect(mockClose).toHaveBeenCalledTimes(6);
    });

    it("leaves the enrichment state service to the server's close steps, which close it once", async () => {
        mockDisconnect.mockClear();

        await shutdownWorkers();

        expect(mockDisconnect).not.toHaveBeenCalled();
    });
});
