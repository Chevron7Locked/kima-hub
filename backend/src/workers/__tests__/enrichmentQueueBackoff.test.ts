/**
 * Job keys and backoff for the enrichment phases. Track jobs get a per-attempt
 * id from their `TrackStage` record. Artists have no stage record, so the
 * artist phase still selects on `Track.enrichmentStatus` with its own backoff.
 */

const mockArtistAdd = jest.fn().mockResolvedValue({ id: "j" });
const mockArtistClean = jest.fn().mockResolvedValue([]);
const mockArtistGetJob = jest.fn().mockResolvedValue(null);
const mockTrackAdd = jest.fn().mockResolvedValue({ id: "j" });
const mockTrackClean = jest.fn().mockResolvedValue([]);
const mockTrackGetJob = jest.fn().mockResolvedValue(null);

jest.mock("../enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: {
        add: mockArtistAdd, clean: mockArtistClean, getJob: mockArtistGetJob, resume: jest.fn(),
        getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, active: 0, delayed: 0, prioritized: 0 }),
    },
    trackQueue: { add: mockTrackAdd, clean: mockTrackClean, getJob: mockTrackGetJob, resume: jest.fn() },
    vibeQueue: { add: jest.fn(), clean: jest.fn(), getJob: jest.fn(), resume: jest.fn() },
    podcastQueue: { add: jest.fn(), clean: jest.fn(), getJob: jest.fn(), resume: jest.fn() },
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
// The AcoustID batch asked before dispatch is not what this tests, and must never reach the network.
jest.mock("../../services/acoustidIdentification", () => ({
    ...jest.requireActual("../../services/acoustidIdentification"),
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../services/enrichmentFailureService", () => ({ enrichmentFailureService: {} }));
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
// The stage queue reads TrackStage through one raw query per stage; shape the
// rows by the stage bind parameter ($1) rather than by the SQL text.
const mockQueryRawUnsafe = jest.fn();

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
        trackStage: {
            count: jest.fn().mockResolvedValue(0),
        },
        $queryRawUnsafe: mockQueryRawUnsafe,
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    },
}));
// The in-flight cap reads each stage's worker count.
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ enrichmentConcurrency: 5, audioAnalyzerWorkers: 2, clapWorkers: 2 }),
}));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    executeArtistsPhase,
    executeIdentificationPhase,
} from "../unifiedEnrichment";

// clean(grace, limit, type)
const cleanCallsFor = (mock: jest.Mock, type: string) =>
    mock.mock.calls.filter((c) => c[2] === type);

/** One owed stage row for the stage the phase under test consults. */
function stageRow(trackId: string, stage: string, attempt = 0) {
    return {
        trackId, stage, status: "pending", attempt, source: "musicbrainz",
        filePath: `/music/${trackId}.flac`, duration: 200, title: trackId,
    };
}

describe("enrichment phases -- job keys and backoff", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistGetJob.mockResolvedValue(null);
        mockTrackGetJob.mockResolvedValue(null);
        // Artists still select from Track.enrichmentStatus; the track phase
        // selects from TrackStage.
        mockArtistFindMany.mockResolvedValue([{ id: "a1", name: "Artist One" }]);
        mockTrackFindMany.mockResolvedValue([]);
        mockQueryRawUnsafe.mockImplementation(async (_sql: string, stage: string) => {
            if (stage === "recording") return [stageRow("t1", "recording")];
            return [];
        });
    });

    describe("artist phase (no per-artist stage record — unchanged)", () => {
        it("cleans completed (grace 0) and failed (grace > 0) before queuing", async () => {
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

        it("backs off (does not re-add or park) when the jobId slot is still held", async () => {
            // A failed job younger than the grace still holds the jobId; getJob
            // returns it, so the phase must skip -- not re-add, not park the entity
            // out of selection.
            mockArtistGetJob.mockResolvedValue({ id: "artist-a1" }); // slot held

            await executeArtistsPhase();

            expect(mockArtistAdd).not.toHaveBeenCalled();
            expect(mockArtistUpdate).not.toHaveBeenCalled(); // not parked "enriching"
        });

        it("an artist left enriching with nothing queued or running is asked again", async () => {
            const { artistQueue } = jest.requireMock("../enrichmentQueues");
            artistQueue.getJobCounts.mockResolvedValueOnce({ waiting: 0, active: 0, delayed: 0, prioritized: 0 });
            await executeArtistsPhase();
            expect(mockArtistUpdateMany).toHaveBeenCalledWith({
                where: { enrichmentStatus: "enriching" },
                data: { enrichmentStatus: "pending" },
            });
        });

        it("while jobs are queued, enriching artists are left alone", async () => {
            await executeArtistsPhase();
            expect(mockArtistUpdateMany).not.toHaveBeenCalledWith(
                expect.objectContaining({ where: { enrichmentStatus: "enriching" } }),
            );
        });

        it("no work: no clean, no queue", async () => {
            mockArtistFindMany.mockResolvedValue([]);

            await executeArtistsPhase();

            expect(mockArtistClean).not.toHaveBeenCalled();
            expect(mockArtistAdd).not.toHaveBeenCalled();
        });
    });

    describe("track phase (stage record owns the attempt)", () => {
        it("does not clean job markers — the per-attempt jobId makes dedup moot", async () => {
            // Selection comes from TrackStage, so there is no marker to clear:
            // a retry gets a fresh jobId.
            await executeIdentificationPhase();

            expect(mockTrackClean).not.toHaveBeenCalled();
        });

        it("keys each attempt with its own jobId, not the shared stage key", async () => {
            mockQueryRawUnsafe.mockImplementation(async (sql: string, ...args: unknown[]) => {
                // The claim UPDATE moves the record from its failed attempt 2
                // onto attempt 3 (a `failed` claim consumes the next rung).
                if (sql.includes("SET status = 'working'"))
                    return [{ attempt: 3, redelivered: 0 }];
                if (args[0] === "recording") return [stageRow("t1", "recording", 2)];
                return [];
            });

            await executeIdentificationPhase();

            // Attempt 2 already failed and is retryable, so this is attempt 3.
            expect(mockTrackAdd).toHaveBeenCalledWith(
                "enrich",
                { trackId: "t1", trackTitle: "t1" },
                { jobId: "track-t1-recording-3-r0" },
            );
        });

        it("does not re-queue a track whose recording record is answered", async () => {
            // Nothing owes the recording stage this cycle.
            mockQueryRawUnsafe.mockResolvedValue([]);

            const queued = await executeIdentificationPhase();

            expect(queued).toBe(0);
            expect(mockTrackAdd).not.toHaveBeenCalled();
        });
    });
});