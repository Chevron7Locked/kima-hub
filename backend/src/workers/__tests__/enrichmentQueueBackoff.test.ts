/**
 * Job keys and backoff for the track enrichment phase. Track jobs get a per-attempt
 * id from their `TrackStage` record. (The artist job's queueing is tested at its own
 * module: workers/enrichment/__tests__/artists.queue.test.ts.)
 */

const mockTrackAdd = jest.fn().mockResolvedValue({ id: "j" });
const mockTrackClean = jest.fn().mockResolvedValue([]);
const mockTrackGetJob = jest.fn().mockResolvedValue(null);

jest.mock("../enrichmentQueues", () => ({
    QUEUE_NAMES: {
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    trackQueue: { add: mockTrackAdd, clean: mockTrackClean, getJob: mockTrackGetJob, resume: jest.fn() },
    vibeQueue: { add: jest.fn(), clean: jest.fn(), getJob: jest.fn(), resume: jest.fn() },
    podcastQueue: { add: jest.fn(), clean: jest.fn(), getJob: jest.fn(), resume: jest.fn() },
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../enrichment/artists", () => ({ queueOwedArtists: jest.fn().mockResolvedValue(0), startArtistWorker: jest.fn() }));
jest.mock("../trackEnrichmentWorker", () => ({ startTrackEnrichmentWorker: jest.fn() }));
jest.mock("../enrichment/podcasts", () => ({ queueStalePodcasts: jest.fn().mockResolvedValue(0), startPodcastWorker: jest.fn() }));
jest.mock("../audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));
jest.mock("../../services/enrichmentState", () => ({ enrichmentStateService: {} }));
// The album step before dispatch is not what this tests, and must never reach the network.
jest.mock("../../services/albumIdentification", () => ({
    ...jest.requireActual("../../services/albumIdentification"),
    identifyAlbumsBySound: jest.fn().mockResolvedValue([]),
}));
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

const mockTrackFindMany = jest.fn();
const mockTrackUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockTrackUpdate = jest.fn().mockResolvedValue({});
// The stage queue reads TrackStage through one raw query per stage; shape the
// rows by the stage bind parameter ($1) rather than by the SQL text.
const mockQueryRawUnsafe = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
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
// The claim is the stage-record module's (tested there); here only the job id it hands back matters.
const mockClaim = jest.fn();
jest.mock("../../services/stages/stageRecords", () => ({
    ...jest.requireActual("../../services/stages/stageRecords"),
    claim: (...args: unknown[]) => mockClaim(...args),
}));
// The in-flight cap reads each stage's worker count.
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ enrichmentConcurrency: 5, audioAnalyzerWorkers: 2, clapWorkers: 2 }),
}));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { executeIdentificationPhase } from "../unifiedEnrichment";

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
        mockTrackGetJob.mockResolvedValue(null);
        mockTrackFindMany.mockResolvedValue([]);
        mockQueryRawUnsafe.mockImplementation(async (_sql: string, stage: string) => {
            if (stage === "recording") return [stageRow("t1", "recording")];
            return [];
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
            // The record's failed attempt 2 is claimed again as attempt 3.
            mockClaim.mockImplementation(async (_trackId: string, _stage: string, opts: { jobKey: string }) => ({
                kind: "claimed", attempt: 3, redelivered: 0, jobId: `${opts.jobKey}-3-r0`,
            }));
            mockQueryRawUnsafe.mockImplementation(async (_sql: string, ...args: unknown[]) => {
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