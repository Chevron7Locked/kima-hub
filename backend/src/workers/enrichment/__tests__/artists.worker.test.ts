/**
 * The artist worker's own handling of a job, without the scheduler or a queue: an artist deleted since its job
 * was queued resolves silently, and a job that failed before the enrichment could record it is recorded as a
 * failure of the artist.
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
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue({});
jest.mock("../../../utils/db", () => ({
    prisma: { artist: { findUnique: (...a: unknown[]) => mockFindUnique(...a), update: (...a: unknown[]) => mockUpdate(...a) } },
}));

import type { Job } from "bullmq";
import { processArtistJob, recordArtistJobFailure } from "../artists";
import { entityGoneError, isEntityGone } from "../../entityGone";

const job = (artistId: string) =>
    ({ data: { artistId, artistName: "Name" } }) as unknown as Job<{ artistId: string; artistName: string }>;

beforeEach(() => jest.clearAllMocks());

describe("processArtistJob", () => {
    it("an artist deleted since the job was queued throws the entity-gone error", async () => {
        mockFindUnique.mockResolvedValue(null);
        const err = await processArtistJob(job("a1")).catch((e) => e);
        expect(isEntityGone(err)).toBe(true);
    });
});

describe("recordArtistJobFailure", () => {
    it("an entity-gone failure records nothing", async () => {
        await recordArtistJobFailure(job("a1"), entityGoneError("Artist", "a1"));
        expect(mockFindUnique).not.toHaveBeenCalled();
        expect(mockRecordFailure).not.toHaveBeenCalled();
    });

    it("an artist still enriching is counted as failed and the failure is recorded", async () => {
        mockFindUnique.mockResolvedValue({ enrichmentStatus: "enriching", enrichmentFailures: 0 });
        await recordArtistJobFailure(job("a1"), new Error("boom"));
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: "a1" },
            data: expect.objectContaining({ enrichmentStatus: "failed", enrichmentFailures: 1 }),
        });
        expect(mockRecordFailure).toHaveBeenCalledWith(
            expect.objectContaining({ entityType: "artist", entityId: "a1", errorMessage: "boom" }),
        );
    });

    it("an artist the enrichment already settled keeps its status, the failure is still recorded", async () => {
        mockFindUnique.mockResolvedValue({ enrichmentStatus: "failed", enrichmentFailures: 2 });
        await recordArtistJobFailure(job("a1"), new Error("boom"));
        expect(mockUpdate).not.toHaveBeenCalled();
        expect(mockRecordFailure).toHaveBeenCalledTimes(1);
    });

    it("a store that fails while recording does not throw out of the failed handler", async () => {
        mockFindUnique.mockRejectedValue(new Error("db down"));
        await expect(recordArtistJobFailure(job("a1"), new Error("boom"))).resolves.toBeUndefined();
    });
});
