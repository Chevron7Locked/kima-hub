/**
 * A cycle's end hands the shown picture, year and genre changes its workers noted to the Subsonic change marker,
 * so clients see them when the cycle is over, not when the quiet window ends. Real test database; Redis, queues
 * and the network-facing services are stood in; the scheduler is real.
 */

jest.mock("../scanActivity", () => ({ libraryScanRunning: jest.fn().mockResolvedValue(false) }));
jest.mock("../enrichmentQueues", () => {
    const queues = require("../../__tests__/helpers/enrichmentMocks").enrichmentQueuesMock;
    for (const q of [queues.artistQueue, queues.trackQueue, queues.vibeQueue, queues.podcastQueue]) {
        q.getJobCounts = jest.fn().mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0 });
    }
    return queues;
});
jest.mock("ioredis", () => require("../../__tests__/helpers/enrichmentMocks").ioredisMock);
jest.mock("../../config", () => require("../../__tests__/helpers/enrichmentMocks").configMock);
jest.mock("../../utils/logger", () => require("../../__tests__/helpers/enrichmentMocks").loggerMock);
jest.mock("../../services/enrichmentState", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentStateMock);
jest.mock("../../services/enrichmentFailureService", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentFailureServiceMock);
jest.mock("../../services/featureDetection", () => require("../../__tests__/helpers/enrichmentMocks").featureDetectionMock);
jest.mock("../../services/acoustidIdentification", () => ({
    ...jest.requireActual("../../services/acoustidIdentification"),
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../services/albumIdentification", () => ({
    ...jest.requireActual("../../services/albumIdentification"),
    identifyAlbumsBySound: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../services/sourcePauseController", () => require("../../__tests__/helpers/enrichmentMocks").sourcePauseControllerMock);
jest.mock("../audioCompletionSubscriber", () => require("../../__tests__/helpers/enrichmentMocks").audioCompletionSubscriberMock);
jest.mock("../enrichment/artists", () => require("../../__tests__/helpers/enrichmentMocks").artistJobMock);
jest.mock("../trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../enrichment/podcasts", () => require("../../__tests__/helpers/enrichmentMocks").podcastJobMock);
jest.mock("../../services/moods/state", () => ({
    buildMoods: jest.fn().mockResolvedValue({ scored: 0, stateChanged: false }),
    moodProgress: jest.fn().mockResolvedValue({ total: 0, completed: 0 }),
}));
jest.mock("../../services/moods/tags", () => ({ writeMoodTags: jest.fn().mockResolvedValue(0) }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ audioAnalyzerWorkers: 2, clapWorkers: 2 }),
}));
jest.mock("../../services/shownPictureChanges", () => ({
    ...jest.requireActual("../../services/shownPictureChanges"),
    flushShownPictureChanges: jest.fn().mockResolvedValue(undefined),
}));

import { mockRedis, enrichmentStateMock } from "../../__tests__/helpers/enrichmentMocks";
import { flushShownPictureChanges } from "../../services/shownPictureChanges";
import { triggerEnrichmentNow, startUnifiedEnrichmentWorker, stopUnifiedEnrichmentWorker } from "../unifiedEnrichment";

const state = enrichmentStateMock.enrichmentStateService;
const flush = flushShownPictureChanges as jest.Mock;

beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "queueMicrotask"] });
    state.getState.mockResolvedValue({ status: "idle" });
    state.updateState.mockImplementation(async () => ({}));
    mockRedis.set.mockResolvedValue("OK");
    await startUnifiedEnrichmentWorker();
    flush.mockClear();
});

afterEach(async () => {
    await stopUnifiedEnrichmentWorker();
    jest.useRealTimers();
});

describe("the end of an enrichment cycle", () => {
    it("flushes the shown changes its workers noted", async () => {
        await triggerEnrichmentNow();
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it("flushes when the cycle fails part-way", async () => {
        state.updateState.mockImplementation(async (update: { currentPhase?: string | null }) => {
            if (update.currentPhase === "artists") throw new Error("state store down");
            return {};
        });
        await triggerEnrichmentNow();
        expect(flush).toHaveBeenCalledTimes(1);
    });
});
