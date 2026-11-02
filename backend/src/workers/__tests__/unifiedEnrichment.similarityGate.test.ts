/**
 * Similarity waits until analysis and sound vectors are settled for the whole library, including answers
 * still due a retry; the map's one-time layout also waits for the artist genres.
 */

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

const mockUpdateMap = jest.fn().mockResolvedValue({ laidOut: 0, placed: 0 });
jest.mock("../../services/matching/map", () => ({
    updateMap: (settled: boolean) => mockUpdateMap(settled),
}));
const mockBuildMatching = jest.fn().mockResolvedValue({ feelUpdated: 0 });
jest.mock("../../services/matching/state", () => ({
    buildMatching: () => mockBuildMatching(),
    matchingProgress: jest.fn().mockResolvedValue({ total: 0, completed: 0 }),
}));

import { putStage as seedStage } from "../../__tests__/helpers/trackStage";
import { prisma } from "../../utils/db";
import { executeSimilarityPhase, invalidateEnrichmentProgress } from "../../workers/unifiedEnrichment";

const PREFIX = "simgate";
const id = (n: string) => `${PREFIX}_${n}`;

const putStage = (trackId: string, stage: string, status: string, retryable = true) =>
    seedStage(trackId, stage, status, { source: "test", attempt: 1, retryable, evidence: {}, seedError: false });

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await prisma.artist.create({
        data: { id: id("art"), name: "Gate Artist", identityKey: id("a"), enrichmentStatus: "completed" },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Gate Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: id("t"), albumId: id("alb"), title: "Gate Track", trackNo: 1, duration: 180,
            filePath: `/tmp/${id("t")}.flac`, fileModified: new Date(), fileSize: 1000,
        },
    });
    for (const stage of ["recording", "analysis", "embedding", "fingerprint"]) await putStage(id("t"), stage, "done");
    invalidateEnrichmentProgress();
});

afterAll(async () => {
    await wipe();
});

describe("the map's first layout waits for the formula's inputs", () => {
    it("lays out once every input is settled", async () => {
        await executeSimilarityPhase();
        expect(mockUpdateMap).toHaveBeenCalledWith(true);
    });

    it.each(["pending", "enriching", "failed"])("waits while an artist is %s", async (status) => {
        await prisma.artist.update({ where: { id: id("art") }, data: { enrichmentStatus: status } });
        await executeSimilarityPhase();
        expect(mockUpdateMap).toHaveBeenCalledWith(false);
    });

    it.each([
        ["an analysis is waiting", "analysis", "pending"],
        ["an analysis is in flight", "analysis", "working"],
        ["a sound vector is waiting", "embedding", "pending"],
        ["a sound vector is due a retry", "embedding", "failed"],
    ])("builds nothing while %s: similarity comes after the moods", async (_what, stage, status) => {
        await putStage(id("t"), stage, status, true);
        expect(await executeSimilarityPhase()).toBe(0);
        expect(mockBuildMatching).not.toHaveBeenCalled();
        expect(mockUpdateMap).not.toHaveBeenCalled();
    });

    it("does not wait on an analysis a person set aside", async () => {
        await putStage(id("t"), "analysis", "blocked", false);
        await executeSimilarityPhase();
        expect(mockUpdateMap).toHaveBeenCalledWith(true);
    });
});
