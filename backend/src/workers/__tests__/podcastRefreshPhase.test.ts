/**
 * The podcast refresh phase cleans both completed and failed jobs, since BullMQ
 * keeps a failed job's id and silently ignores a re-add. It advances
 * lastRefreshed before queuing, so a failing feed waits a full window.
 * Failure paths first, happy path last.
 */

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);

jest.mock("../enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
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
jest.mock("ioredis", () => jest.fn().mockImplementation(() => ({
    on: jest.fn(), publish: jest.fn(), subscribe: jest.fn(), quit: jest.fn(),
})));
jest.mock("../../config", () => ({
    config: { redis: { host: "localhost", port: 6379 }, music: {}, nodeEnv: "test" },
}));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { executePodcastRefreshPhase } from "../unifiedEnrichment";
import { prisma } from "../../utils/db";

const P = "zz-podcastRefresh-";
const HOUR = 60 * 60 * 1000;

async function wipe() {
    await prisma.podcast.deleteMany({ where: { id: { startsWith: P } } });
}

/** A podcast last refreshed `hoursAgo` hours ago; the phase refreshes those not refreshed in the last hour. */
const seedPodcast = (n: string, title: string, hoursAgo: number) =>
    prisma.podcast.create({
        data: { id: `${P}${n}`, feedUrl: `https://example.test/${P}${n}.xml`, title, lastRefreshed: new Date(Date.now() - hoursAgo * HOUR) },
    });

const lastRefreshed = async (n: string) => (await prisma.podcast.findUniqueOrThrow({ where: { id: `${P}${n}` } })).lastRefreshed;

describe("executePodcastRefreshPhase -- dedup wedge regression", () => {
    beforeAll(wipe);
    afterAll(wipe);
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        mockQueueClean.mockResolvedValue([]);
        mockQueueAdd.mockResolvedValue({ id: "job" });
    });

    it("no podcasts: does nothing", async () => {
        const n = await executePodcastRefreshPhase();
        expect(n).toBe(0);
        expect(mockQueueClean).not.toHaveBeenCalled();
        expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("podcasts exist but none stale: no clean, no queue, no bump", async () => {
        await seedPodcast("1", "Pod One", 0.2);
        await seedPodcast("2", "Pod Two", 0.5);
        const before = await lastRefreshed("1");

        const n = await executePodcastRefreshPhase();

        expect(n).toBe(0);
        expect(mockQueueClean).not.toHaveBeenCalled();
        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(await lastRefreshed("1")).toEqual(before);
    });

    it("cleans the failed set, not only completed", async () => {
        await seedPodcast("1", "Pod One", 3);
        await executePodcastRefreshPhase();
        const cleanedStates = mockQueueClean.mock.calls.map((c) => c[2]);
        expect(cleanedStates).toContain("completed");
        expect(cleanedStates).toContain("failed");
    });

    it("claims podcasts by bumping lastRefreshed before queuing (backoff)", async () => {
        await seedPodcast("1", "Pod One", 3);
        await seedPodcast("2", "Pod Two", 5);
        await seedPodcast("3", "Fresh", 0.1);
        const freshBefore = await lastRefreshed("3");
        const started = Date.now();

        // What the stored rows say at the moment each job is queued.
        const claimedWhenQueued: boolean[] = [];
        mockQueueAdd.mockImplementation(async (_name: string, data: { podcastId: string }) => {
            claimedWhenQueued.push((await prisma.podcast.findUniqueOrThrow({ where: { id: data.podcastId } })).lastRefreshed.getTime() >= started);
            return { id: "j" };
        });

        await executePodcastRefreshPhase();

        // the bump happens before any job is queued, and only the stale podcasts are bumped
        expect(claimedWhenQueued).toEqual([true, true]);
        expect((await lastRefreshed("1")).getTime()).toBeGreaterThanOrEqual(started);
        expect((await lastRefreshed("2")).getTime()).toBeGreaterThanOrEqual(started);
        expect(await lastRefreshed("3")).toEqual(freshBefore);
    });

    it("queues each stale podcast with its real data and stable jobId", async () => {
        await seedPodcast("1", "Pod One", 3);

        const n = await executePodcastRefreshPhase();

        expect(n).toBe(1);
        expect(mockQueueAdd).toHaveBeenCalledWith(
            "refresh",
            { podcastId: `${P}1`, podcastTitle: "Pod One" },
            { jobId: `podcast-${P}1` },
        );
    });
});
