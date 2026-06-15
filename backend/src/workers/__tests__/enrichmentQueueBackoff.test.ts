/**
 * Regression guard for the dedup-on-failure trap on the artist and track
 * enrichment phases (the same class as the podcast wedge).
 *
 * BullMQ keeps a failed job's jobId marker, so a failed enrichment can't be
 * re-queued until the marker is gone. Each automatic phase must clean both
 * "completed" (immediately reusable on success) and "failed" (reusable after a
 * backoff grace, so a permanently-failing entity doesn't re-add every cycle).
 */

const mockArtistAdd = jest.fn().mockResolvedValue({ id: "j" });
const mockArtistClean = jest.fn().mockResolvedValue([]);
const mockTrackAdd = jest.fn().mockResolvedValue({ id: "j" });
const mockTrackClean = jest.fn().mockResolvedValue([]);

jest.mock("../enrichmentQueues", () => ({
    artistQueue: { add: mockArtistAdd, clean: mockArtistClean, resume: jest.fn() },
    trackQueue: { add: mockTrackAdd, clean: mockTrackClean, resume: jest.fn() },
    vibeQueue: { add: jest.fn(), clean: jest.fn(), resume: jest.fn() },
    podcastQueue: { add: jest.fn(), clean: jest.fn(), resume: jest.fn() },
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
jest.mock("../../services/enrichmentState", () => ({ enrichmentStateService: {} }));
jest.mock("../../services/enrichmentFailureService", () => ({ enrichmentFailureService: {} }));
jest.mock("../../services/lastfm", () => ({ lastFmService: {} }));
jest.mock("ioredis", () => jest.fn().mockImplementation(() => ({
    on: jest.fn(), publish: jest.fn(), subscribe: jest.fn(), quit: jest.fn(),
})));
jest.mock("../../config", () => ({
    config: { redis: { host: "localhost", port: 6379 }, music: { musicPath: "/music" }, nodeEnv: "test" },
}));

const mockArtistFindMany = jest.fn();
const mockArtistUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockArtistUpdate = jest.fn().mockResolvedValue({});
const mockTrackFindMany = jest.fn();
const mockTrackUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockTrackUpdate = jest.fn().mockResolvedValue({});

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: mockArtistFindMany,
            updateMany: mockArtistUpdateMany,
            update: mockArtistUpdate,
        },
        track: {
            findMany: mockTrackFindMany,
            updateMany: mockTrackUpdateMany,
            update: mockTrackUpdate,
        },
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    executeArtistsPhase,
    executeMoodTagsPhase,
} from "../unifiedEnrichment";

// clean(grace, limit, type)
const cleanCallsFor = (mock: jest.Mock, type: string) =>
    mock.mock.calls.filter((c) => c[2] === type);

describe("enrichment phases -- clean completed immediately, failed with backoff", () => {
    beforeEach(() => jest.clearAllMocks());

    it("artists phase cleans completed (grace 0) and failed (grace > 0) before queuing", async () => {
        mockArtistFindMany.mockResolvedValue([{ id: "a1", name: "Artist One" }]);

        await executeArtistsPhase();

        const completed = cleanCallsFor(mockArtistClean, "completed");
        const failed = cleanCallsFor(mockArtistClean, "failed");
        expect(completed).toHaveLength(1);
        expect(completed[0][0]).toBe(0); // grace 0 -- immediate reuse on success
        expect(failed).toHaveLength(1);
        expect(failed[0][0]).toBeGreaterThan(0); // backoff grace before retry
        expect(mockArtistAdd).toHaveBeenCalledWith(
            "enrich",
            { artistId: "a1", artistName: "Artist One" },
            { jobId: "artist-a1" },
        );
    });

    it("mood-tags phase cleans completed (grace 0) and failed (grace > 0) before queuing", async () => {
        mockTrackFindMany.mockResolvedValue([{ id: "t1", title: "Track One" }]);

        await executeMoodTagsPhase();

        const completed = cleanCallsFor(mockTrackClean, "completed");
        const failed = cleanCallsFor(mockTrackClean, "failed");
        expect(completed).toHaveLength(1);
        expect(completed[0][0]).toBe(0);
        expect(failed).toHaveLength(1);
        expect(failed[0][0]).toBeGreaterThan(0);
        expect(mockTrackAdd).toHaveBeenCalledWith(
            "enrich",
            { trackId: "t1", trackTitle: "Track One" },
            { jobId: "track-t1" },
        );
    });

    it("no work: no clean, no queue", async () => {
        mockArtistFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);

        await executeArtistsPhase();
        await executeMoodTagsPhase();

        expect(mockArtistClean).not.toHaveBeenCalled();
        expect(mockTrackClean).not.toHaveBeenCalled();
        expect(mockArtistAdd).not.toHaveBeenCalled();
        expect(mockTrackAdd).not.toHaveBeenCalled();
    });
});
