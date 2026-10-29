/** Running the enrichment controls leaves seeded embeddings and tags in place. */

// ── Queues + Redis + network services: observe, never hit the wire ──────

jest.mock("../../workers/enrichmentQueues", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentQueuesMock);
jest.mock("ioredis", () => require("../../__tests__/helpers/enrichmentMocks").ioredisMock);
jest.mock("../../config", () => require("../../__tests__/helpers/enrichmentMocks").configMock);
jest.mock("../../utils/logger", () => require("../../__tests__/helpers/enrichmentMocks").loggerMock);
jest.mock("../../services/enrichmentState", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentStateMock);
jest.mock("../../services/enrichmentFailureService", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentFailureServiceMock);
jest.mock("../../services/featureDetection", () => require("../../__tests__/helpers/enrichmentMocks").featureDetectionMock);
jest.mock("../../services/trackIdentity", () => require("../../__tests__/helpers/enrichmentMocks").trackIdentityMock);
jest.mock("../../services/musicbrainz", () => require("../../__tests__/helpers/enrichmentMocks").musicBrainzMock);
jest.mock("../../services/acoustidIdentification", () => require("../../__tests__/helpers/enrichmentMocks").acoustidIdentificationMock);
jest.mock("../../services/sourcePauseController", () => require("../../__tests__/helpers/enrichmentMocks").sourcePauseControllerMock);
jest.mock("../../workers/audioCompletionSubscriber", () => require("../../__tests__/helpers/enrichmentMocks").audioCompletionSubscriberMock);
jest.mock("../../workers/artistEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").artistEnrichmentWorkerMock);
jest.mock("../../workers/trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../../workers/podcastEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").podcastEnrichmentWorkerMock);

import { putStage, deleteSeededRows, seedArtistAndAlbum, seedPatternEmbedding } from "../../__tests__/helpers/trackStage";
import { mockQueueAdd } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import {
    waitForFingerprintWork,
    retryFailedAndBlocked,
    redecideEverything,
} from "../../workers/unifiedEnrichment";

const PREFIX = "wipe";
const id = (n: string) => `${PREFIX}_${n}`;

/** Seed a track whose questions are ALL answered, with real answers. */
async function seedAnsweredTrack(trackId: string): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            recordingMbid: "mbid-known",
            analysisStatus: "completed" as never,
            analysisRetryCount: 0,
        } as never,
    });
    await putStage(trackId, "recording", "done");
    await putStage(trackId, "analysis", "done");
    await putStage(trackId, "embedding", "done");
    // An answered track has its fingerprint too (the sweep covers every
    // track): without this record the queue would re-offer it forever.
    await putStage(trackId, "fingerprint", "done");
    await seedPatternEmbedding(trackId);
}

async function embeddingCount(trackId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM track_embeddings WHERE track_id = $1`,
        trackId,
    );
    return Number(rows[0].n);
}

async function wipe(): Promise<void> {
    // The fingerprint pool runs detached: never let an in-flight answer
    // land after the rows it belongs to are gone.
    await waitForFingerprintWork();
    await deleteSeededRows(PREFIX);
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    await wipe();
    await seedArtistAndAlbum(PREFIX, "Wipe");
});

afterAll(async () => {
    await wipe();
});

describe("re-deciding and retrying wipe nothing", () => {
    it("redecideEverything keeps every embedding", async () => {
        await seedAnsweredTrack(id("keep"));

        const { reopened } = await redecideEverything();
        expect(reopened).toBeGreaterThan(0);

        // The embedding is an ANSWER. Re-deciding re-asks the question; it
        // does not delete the answer that is already in the table.
        expect(await embeddingCount(id("keep"))).toBe(1);
    });

    it("retryFailedAndBlocked keeps every embedding", async () => {
        await seedAnsweredTrack(id("keep2"));

        const work = await retryFailedAndBlocked(50);
        // Everything is answered — nothing is handed out at all.
        expect(work.filter((w) => w.trackId.startsWith(id("keep2")))).toHaveLength(0);

        expect(await embeddingCount(id("keep2"))).toBe(1);
    });

    it("running both controls back to back still deletes nothing", async () => {
        await seedAnsweredTrack(id("keep3"));

        await redecideEverything();
        await retryFailedAndBlocked(50);

        // Even after re-deciding everything and retrying whatever is owed,
        // the answers already on disk survive untouched.
        expect(await embeddingCount(id("keep3"))).toBe(1);
        const track = await prisma.track.findUnique({ where: { id: id("keep3") } });
        expect(track).not.toBeNull();
    });
});