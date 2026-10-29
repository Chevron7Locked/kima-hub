/**
 * A song on a Discover album is never enriched: no stage is offered it, it never holds sound vectors back behind
 * analysis, and the enrichment page never counts it as owed. Once a like moves its album to the library, it is due.
 */

// ── Queues + Redis + network services: observe, never hit the wire ──────────

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

import { prisma } from "../../utils/db";
import { featureDetection } from "../../services/featureDetection";
import {
    analysisStillRunning,
    waitForFingerprintWork,
    getNextWork,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
} from "../../workers/unifiedEnrichment";

const PREFIX = "discskip";
const id = (n: string) => `${PREFIX}_${n}`;
const STAGES = ["fingerprint", "recording", "analysis", "embedding"] as const;

async function seed(): Promise<void> {
    await prisma.artist.create({ data: { id: id("art"), name: "Discskip Artist", identityKey: id("a") } });
    for (const [album, location] of [["lib", "LIBRARY"], ["disc", "DISCOVER"]] as const) {
        await prisma.album.create({
            data: { id: id(album), rgMbid: id(`rg_${album}`), artistId: id("art"), identityKey: id(`ik_${album}`), title: `Discskip ${album}`, primaryType: "Album", location },
        });
        await prisma.track.create({
            data: {
                id: id(`t_${album}`),
                albumId: id(album),
                title: `Track ${album}`,
                trackNo: 1,
                duration: 180,
                filePath: `/music/${PREFIX}_${album}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            } as never,
        });
    }
}

/** Every earlier stage answered for both songs, so each stage's question is due but for the album. */
async function answerAllBefore(stage: (typeof STAGES)[number]): Promise<void> {
    for (const earlier of STAGES.slice(0, STAGES.indexOf(stage))) {
        for (const track of [id("t_lib"), id("t_disc")]) {
            await prisma.trackStage.create({ data: { trackId: track, stage: earlier, status: "done" } });
        }
    }
}

async function wipe(): Promise<void> {
    await waitForFingerprintWork();
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seed();
});

afterAll(async () => {
    await wipe();
});

const ours = (work: { trackId: string }[]) => work.map((w) => w.trackId).filter((t) => t.startsWith(PREFIX));

describe("enrichment leaves Discover songs alone", () => {
    it.each(STAGES)("the %s stage is offered the library song, never the Discover one", async (stage) => {
        await answerAllBefore(stage);
        expect(ours(await getNextWork(50, stage))).toEqual([id("t_lib")]);
    });

    it("a Discover song owed analysis does not hold sound vectors back", async () => {
        (featureDetection.analyzerRunning as jest.Mock).mockResolvedValue(true);
        try {
            await prisma.trackStage.create({ data: { trackId: id("t_lib"), stage: "analysis", status: "done" } });
            // Other files in the run leave no owed songs of their own behind (they wipe), so the Discover song is
            // the only one with no analysis answer.
            expect(await analysisStillRunning(new Date())).toBe(false);
        } finally {
            (featureDetection.analyzerRunning as jest.Mock).mockResolvedValue(false);
        }
    });

    it("the enrichment page does not count a Discover song as owed", async () => {
        invalidateEnrichmentProgress();
        const withBoth = (await getEnrichmentProgress()).audioAnalysis;
        await prisma.track.delete({ where: { id: id("t_disc") } });
        invalidateEnrichmentProgress();
        const withLibraryOnly = (await getEnrichmentProgress()).audioAnalysis;
        expect(withBoth.total).toBe(withLibraryOnly.total);
    });

    it("once a like moves its album to the library, the song is due", async () => {
        expect(ours(await getNextWork(50, "fingerprint"))).toEqual([id("t_lib")]);
        await prisma.album.update({ where: { id: id("disc") }, data: { location: "LIBRARY" } });
        expect(ours(await getNextWork(50, "fingerprint")).sort()).toEqual([id("t_disc"), id("t_lib")].sort());
    });
});
