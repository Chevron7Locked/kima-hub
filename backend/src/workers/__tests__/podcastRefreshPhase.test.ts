/**
 * Regression guard for the podcast auto-refresh wedge (production, 2026-06-14).
 *
 * Root cause: BullMQ keeps the jobId dedup marker for FAILED jobs as well as
 * completed ones. executePodcastRefreshPhase cleaned only "completed", so a
 * single failed `podcast-<id>` job (here: a Redis-corrupted data-less hash)
 * kept its marker forever -- every later add() with that jobId silently no-op'd
 * and the podcast never refreshed again. All 4 production podcasts were frozen.
 *
 * The fix: (a) clean BOTH "completed" and "failed" so a failed refresh can be
 * retried, and (b) optimistically advance lastRefreshed for the selected
 * podcasts BEFORE queuing, so a feed whose refresh fails (refreshPodcastFeed
 * only advances lastRefreshed on success/304) backs off a full window instead
 * of being re-queued every cycle.
 *
 * Failure paths first; happy path last. Each assertion targets a discriminator.
 */

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);

const mockPodcastCount = jest.fn();
const mockPodcastFindMany = jest.fn();
const mockPodcastUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

jest.mock("../enrichmentQueues", () => ({
    artistQueue: { add: mockQueueAdd, clean: mockQueueClean, resume: mockQueueResume },
    trackQueue: { add: mockQueueAdd, clean: mockQueueClean, resume: mockQueueResume },
    vibeQueue: { add: mockQueueAdd, clean: mockQueueClean, resume: mockQueueResume },
    podcastQueue: { add: mockQueueAdd, clean: mockQueueClean, resume: mockQueueResume },
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../artistEnrichmentWorker", () => ({ startArtistEnrichmentWorker: jest.fn() }));
jest.mock("../trackEnrichmentWorker", () => ({ startTrackEnrichmentWorker: jest.fn() }));
jest.mock("../podcastEnrichmentWorker", () => ({ startPodcastEnrichmentWorker: jest.fn() }));
jest.mock("../audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));
jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: { getState: jest.fn(), setState: jest.fn() },
}));
jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: { recordFailure: jest.fn(), getFailures: jest.fn() },
}));
jest.mock("../../services/lastfm", () => ({ lastFmService: {} }));
jest.mock("ioredis", () => jest.fn().mockImplementation(() => ({
    on: jest.fn(), publish: jest.fn(), subscribe: jest.fn(), quit: jest.fn(),
})));
jest.mock("../../config", () => ({
    config: { redis: { host: "localhost", port: 6379 }, music: {}, nodeEnv: "test" },
}));
jest.mock("../../utils/db", () => ({
    prisma: {
        podcast: {
            count: mockPodcastCount,
            findMany: mockPodcastFindMany,
            updateMany: mockPodcastUpdateMany,
        },
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { executePodcastRefreshPhase } from "../unifiedEnrichment";

describe("executePodcastRefreshPhase -- dedup wedge regression", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQueueClean.mockResolvedValue([]);
        mockQueueAdd.mockResolvedValue({ id: "job" });
        mockPodcastUpdateMany.mockResolvedValue({ count: 0 });
    });

    it("no podcasts: does nothing", async () => {
        mockPodcastCount.mockResolvedValue(0);
        const n = await executePodcastRefreshPhase();
        expect(n).toBe(0);
        expect(mockQueueClean).not.toHaveBeenCalled();
        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(mockPodcastUpdateMany).not.toHaveBeenCalled();
    });

    it("podcasts exist but none stale: no clean, no queue, no bump", async () => {
        mockPodcastCount.mockResolvedValue(3);
        mockPodcastFindMany.mockResolvedValue([]);
        const n = await executePodcastRefreshPhase();
        expect(n).toBe(0);
        expect(mockQueueClean).not.toHaveBeenCalled();
        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(mockPodcastUpdateMany).not.toHaveBeenCalled();
    });

    it("THE FIX: cleans the failed set, not only completed", async () => {
        mockPodcastCount.mockResolvedValue(1);
        mockPodcastFindMany.mockResolvedValue([{ id: "p1", title: "Pod One" }]);
        await executePodcastRefreshPhase();
        const cleanedStates = mockQueueClean.mock.calls.map((c) => c[2]);
        expect(cleanedStates).toContain("completed");
        expect(cleanedStates).toContain("failed"); // the regression discriminator
    });

    it("claims podcasts by bumping lastRefreshed BEFORE queuing (backoff)", async () => {
        mockPodcastCount.mockResolvedValue(2);
        mockPodcastFindMany.mockResolvedValue([
            { id: "p1", title: "Pod One" },
            { id: "p2", title: "Pod Two" },
        ]);

        const order: string[] = [];
        mockPodcastUpdateMany.mockImplementation(async () => { order.push("bump"); return { count: 2 }; });
        mockQueueAdd.mockImplementation(async () => { order.push("add"); return { id: "j" }; });

        await executePodcastRefreshPhase();

        // updateMany targets exactly the selected ids
        expect(mockPodcastUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["p1", "p2"] } },
                data: expect.objectContaining({ lastRefreshed: expect.any(Date) }),
            }),
        );
        // the bump happens before any job is queued
        expect(order[0]).toBe("bump");
        expect(order).toEqual(["bump", "add", "add"]);
    });

    it("queues each stale podcast with its real data and stable jobId", async () => {
        mockPodcastCount.mockResolvedValue(1);
        mockPodcastFindMany.mockResolvedValue([{ id: "p1", title: "Pod One" }]);

        const n = await executePodcastRefreshPhase();

        expect(n).toBe(1);
        expect(mockQueueAdd).toHaveBeenCalledWith(
            "refresh",
            { podcastId: "p1", podcastTitle: "Pod One" },
            { jobId: "podcast-p1" },
        );
    });
});
