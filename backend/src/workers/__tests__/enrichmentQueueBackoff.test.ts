/**
 * Job keys and backoff for the track enrichment phase. Track jobs get a per-attempt
 * id from their `TrackStage` record. (The artist job's queueing is tested at its own
 * module: workers/enrichment/__tests__/artists.queue.test.ts.) Real test database:
 * the offer reads the seeded song and its stage record, and the claim is the real one.
 */

jest.mock("../enrichmentQueues", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentQueuesMock);
jest.mock("ioredis", () => require("../../__tests__/helpers/enrichmentMocks").ioredisMock);
jest.mock("../../config", () => require("../../__tests__/helpers/enrichmentMocks").configMock);
jest.mock("../../utils/logger", () => require("../../__tests__/helpers/enrichmentMocks").loggerMock);
jest.mock("../../services/enrichmentState", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentStateMock);
jest.mock("../../services/enrichmentFailureService", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentFailureServiceMock);
jest.mock("../../services/featureDetection", () => require("../../__tests__/helpers/enrichmentMocks").featureDetectionMock);
jest.mock("../../services/trackIdentity", () => require("../../__tests__/helpers/enrichmentMocks").trackIdentityMock);
jest.mock("../../services/musicbrainz", () => require("../../__tests__/helpers/enrichmentMocks").musicBrainzMock);
jest.mock("../../services/sourcePauseController", () => require("../../__tests__/helpers/enrichmentMocks").sourcePauseControllerMock);
jest.mock("../audioCompletionSubscriber", () => require("../../__tests__/helpers/enrichmentMocks").audioCompletionSubscriberMock);
jest.mock("../enrichment/artists", () => require("../../__tests__/helpers/enrichmentMocks").artistJobMock);
jest.mock("../trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../enrichment/podcasts", () => require("../../__tests__/helpers/enrichmentMocks").podcastJobMock);
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

import { mockQueueAdd, mockQueueClean } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import { putStage, deleteSeededRows, seedArtistAndAlbum } from "../../__tests__/helpers/trackStage";
import { executeIdentificationPhase } from "../unifiedEnrichment";

const P = "zz-bo";
const id = (n: string) => `${P}_${n}`;

async function seedTrack(n: string): Promise<void> {
    await prisma.track.create({
        data: {
            id: id(n), albumId: id("alb"), title: n, trackNo: 1, duration: 200,
            filePath: `/music/${P}/${n}.flac`, fileModified: new Date(), fileSize: 1000,
        },
    });
    // Recording is offered once the fingerprint question has an answer.
    await putStage(id(n), "fingerprint", "done", { source: "fpcalc" });
}

const wipe = () => deleteSeededRows(P);

beforeAll(wipe);
afterAll(wipe);
beforeEach(async () => {
    await wipe();
    await seedArtistAndAlbum(P, "Bo");
    jest.clearAllMocks();
});

describe("enrichment phases -- job keys and backoff", () => {
    describe("track phase (stage record owns the attempt)", () => {
        it("does not clean job markers -- the per-attempt jobId makes dedup moot", async () => {
            // Selection comes from TrackStage, so there is no marker to clear: a retry gets a fresh jobId.
            await seedTrack("t1");

            await executeIdentificationPhase();

            expect(mockQueueClean).not.toHaveBeenCalled();
        });

        it("keys each attempt with its own jobId, not the shared stage key", async () => {
            // The record's failed attempt 2 is retryable and due: it is claimed again as attempt 3.
            await seedTrack("t1");
            await putStage(id("t1"), "recording", "failed", {
                attempt: 2, retryable: true, nextRetryAt: new Date(Date.now() - 1000), source: "musicbrainz",
            });

            const queued = await executeIdentificationPhase();

            expect(queued).toBe(1);
            expect(mockQueueAdd).toHaveBeenCalledWith(
                "enrich",
                { trackId: id("t1"), trackTitle: "t1" },
                { jobId: `track-${id("t1")}-recording-3-r0` },
            );
        });

        it("a retry not yet due is not queued", async () => {
            await seedTrack("t1");
            await putStage(id("t1"), "recording", "failed", {
                attempt: 2, retryable: true, nextRetryAt: new Date(Date.now() + 60_000), source: "musicbrainz",
            });

            expect(await executeIdentificationPhase()).toBe(0);
            expect(mockQueueAdd).not.toHaveBeenCalled();
        });

        it("does not re-queue a track whose recording record is answered", async () => {
            await seedTrack("t1");
            await putStage(id("t1"), "recording", "done", { source: "musicbrainz" });

            const queued = await executeIdentificationPhase();

            expect(queued).toBe(0);
            expect(mockQueueAdd).not.toHaveBeenCalled();
        });
    });
});
