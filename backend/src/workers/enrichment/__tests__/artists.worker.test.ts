/**
 * The artist worker's own handling of a job, without the scheduler or a queue: an artist deleted since its job
 * was queued resolves silently, and a job that failed before the enrichment could record it is recorded as a
 * failure of the artist. Real database.
 */

jest.mock("../../enrichmentQueues", () => ({
    QUEUE_NAMES: { ARTISTS: "enrichment-artists" },
    createWorkerConnection: jest.fn(),
}));
const mockRecordFailure = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: { recordFailure: (...a: unknown[]) => mockRecordFailure(...a) },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Job } from "bullmq";
import { processArtistJob, recordArtistJobFailure } from "../artists";
import { entityGoneError, isEntityGone } from "../../entityGone";
import { prisma } from "../../../utils/db";

const ID = "zz-artistWorker-1";

type ArtistJob = Job<{ artistId: string; artistName: string }>;
const job = (artistId: string) => ({ data: { artistId, artistName: "Name" } }) as unknown as ArtistJob;
const dataless = {} as unknown as ArtistJob;

const wipe = () => prisma.artist.deleteMany({ where: { id: ID } });
const seed = (enrichmentStatus: string, enrichmentFailures: number) =>
    prisma.artist.create({ data: { id: ID, name: "Name", identityKey: ID, enrichmentStatus, enrichmentFailures } });
const row = () => prisma.artist.findUniqueOrThrow({ where: { id: ID } });

beforeAll(wipe);
afterAll(wipe);
beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await wipe();
});

describe("processArtistJob", () => {
    it("an artist deleted since the job was queued throws the entity-gone error", async () => {
        const err = await processArtistJob(job(ID)).catch((e) => e);
        expect(isEntityGone(err)).toBe(true);
    });

    it("a job with no data is refused without a lookup", async () => {
        const lookup = jest.spyOn(prisma.artist, "findUnique");
        const err = await processArtistJob(dataless).catch((e) => e);
        expect((err as Error).message).toMatch(/no artistId/);
        expect(lookup).not.toHaveBeenCalled();
    });
});

describe("recordArtistJobFailure", () => {
    it("an entity-gone failure records nothing", async () => {
        await seed("enriching", 0);
        await recordArtistJobFailure(job(ID), entityGoneError("Artist", ID));
        expect((await row()).enrichmentStatus).toBe("enriching");
        expect(mockRecordFailure).not.toHaveBeenCalled();
    });

    it("an artist still enriching is counted as failed and the failure is recorded", async () => {
        await seed("enriching", 0);
        await recordArtistJobFailure(job(ID), new Error("boom"));
        expect(await row()).toMatchObject({ enrichmentStatus: "failed", enrichmentFailures: 1 });
        expect(mockRecordFailure).toHaveBeenCalledWith(
            expect.objectContaining({ entityType: "artist", entityId: ID, errorMessage: "boom" }),
        );
    });

    it("an artist the enrichment already settled keeps its status, the failure is still recorded", async () => {
        await seed("failed", 2);
        await recordArtistJobFailure(job(ID), new Error("boom"));
        expect(await row()).toMatchObject({ enrichmentStatus: "failed", enrichmentFailures: 2 });
        expect(mockRecordFailure).toHaveBeenCalledTimes(1);
    });

    it("a job with no data records nothing and does not throw", async () => {
        const lookup = jest.spyOn(prisma.artist, "findUnique");
        await expect(recordArtistJobFailure(dataless, new Error("boom"))).resolves.toBeUndefined();
        expect(lookup).not.toHaveBeenCalled();
        expect(mockRecordFailure).not.toHaveBeenCalled();
    });

    it("a store that fails while recording does not throw out of the failed handler", async () => {
        jest.spyOn(prisma.artist, "findUnique").mockRejectedValueOnce(new Error("db down") as never);
        await expect(recordArtistJobFailure(job(ID), new Error("boom"))).resolves.toBeUndefined();
    });
});
