/**
 * The podcast worker's handling of a failed refresh, without the scheduler or a queue: only a job's final
 * attempt is recorded as a failure, and a job with no data has nothing to record against.
 */

jest.mock("../../enrichmentQueues", () => ({
    QUEUE_NAMES: { PODCASTS: "enrichment-podcasts" },
    createWorkerConnection: jest.fn(),
}));
jest.mock("../../../routes/podcasts", () => ({ refreshPodcastFeed: jest.fn() }));
const mockRecordFailure = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: { recordFailure: (...a: unknown[]) => mockRecordFailure(...a) },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Job } from "bullmq";
import { recordPodcastJobFailure } from "../podcasts";

const job = (data: unknown, attemptsMade: number, attempts = 3) =>
    ({ data, attemptsMade, opts: { attempts } }) as unknown as Job<{ podcastId: string; podcastTitle: string }>;

beforeEach(() => jest.clearAllMocks());

describe("recordPodcastJobFailure", () => {
    it("a retry that will be tried again records nothing", async () => {
        await recordPodcastJobFailure(job({ podcastId: "p1", podcastTitle: "Pod" }, 1), new Error("feed down"));
        expect(mockRecordFailure).not.toHaveBeenCalled();
    });

    it("the final attempt records the podcast's failure", async () => {
        await recordPodcastJobFailure(job({ podcastId: "p1", podcastTitle: "Pod" }, 3), new Error("feed down"));
        expect(mockRecordFailure).toHaveBeenCalledWith({
            entityType: "podcast",
            entityId: "p1",
            entityName: "Pod",
            errorMessage: "feed down",
        });
    });

    it("a job stripped of its data has nothing to record against", async () => {
        await recordPodcastJobFailure(job(undefined, 3), new Error("corrupt"));
        expect(mockRecordFailure).not.toHaveBeenCalled();
    });

    it("a store that refuses the record does not throw out of the failed handler", async () => {
        mockRecordFailure.mockRejectedValueOnce(new Error("db down"));
        await expect(
            recordPodcastJobFailure(job({ podcastId: "p1", podcastTitle: "Pod" }, 3), new Error("feed down")),
        ).resolves.toBeUndefined();
    });
});
