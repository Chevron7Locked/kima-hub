/**
 * EnrichmentFailureService Tests
 *
 * Verifies recordFailure() uses atomic upsert (not find-then-create)
 * and properly resets resolved state on re-failure.
 *
 * Run with: npx jest enrichmentFailureService.test.ts
 */

import { enrichmentFailureService } from "../enrichmentFailureService";

// Mock Prisma
jest.mock("../../utils/db", () => ({
    prisma: {
        enrichmentFailure: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
    },
}));

import { prisma } from "../../utils/db";

const mockUpsert = prisma.enrichmentFailure.upsert as jest.Mock;

describe("EnrichmentFailureService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("recordFailure", () => {
        const baseInput = {
            entityType: "audio" as const,
            entityId: "track-123",
            entityName: "Test Track",
            errorMessage: "Analysis failed: timeout",
            errorCode: "MAX_RETRIES_EXCEEDED",
            metadata: { filePath: "/music/test.flac" },
        };

        it("should use upsert with entityType_entityId composite key", async () => {
            mockUpsert.mockResolvedValue({ id: "fail-1", ...baseInput });

            await enrichmentFailureService.recordFailure(baseInput);

            expect(mockUpsert).toHaveBeenCalledTimes(1);
            const call = mockUpsert.mock.calls[0][0];
            expect(call.where).toEqual({
                entityType_entityId: {
                    entityType: "audio",
                    entityId: "track-123",
                },
            });
        });

        it("should NOT use findUnique+create pattern (TOCTOU race)", async () => {
            mockUpsert.mockResolvedValue({ id: "fail-1", ...baseInput });

            await enrichmentFailureService.recordFailure(baseInput);

            // findUnique and create should NOT be called -- upsert replaces them
            expect(prisma.enrichmentFailure.findUnique).not.toHaveBeenCalled();
            expect(prisma.enrichmentFailure.create).not.toHaveBeenCalled();
            expect(prisma.enrichmentFailure.update).not.toHaveBeenCalled();
        });

        it("should set resolved=false and resolvedAt=null in update branch", async () => {
            mockUpsert.mockResolvedValue({ id: "fail-1", ...baseInput });

            await enrichmentFailureService.recordFailure(baseInput);

            const call = mockUpsert.mock.calls[0][0];
            expect(call.update.resolved).toBe(false);
            expect(call.update.resolvedAt).toBeNull();
        });

        it("should set retryCount=1 and maxRetries=3 in create branch", async () => {
            mockUpsert.mockResolvedValue({ id: "fail-1", ...baseInput });

            await enrichmentFailureService.recordFailure(baseInput);

            const call = mockUpsert.mock.calls[0][0];
            expect(call.create.retryCount).toBe(1);
            expect(call.create.maxRetries).toBe(3);
        });

        it("should increment retryCount in update branch", async () => {
            mockUpsert.mockResolvedValue({ id: "fail-1", ...baseInput });

            await enrichmentFailureService.recordFailure(baseInput);

            const call = mockUpsert.mock.calls[0][0];
            expect(call.update.retryCount).toEqual({ increment: 1 });
        });

        it("should serialize metadata in both create and update branches", async () => {
            const metadata = { filePath: "/music/test.flac", nested: { key: "val" } };
            mockUpsert.mockResolvedValue({ id: "fail-1" });

            await enrichmentFailureService.recordFailure({
                ...baseInput,
                metadata,
            });

            const call = mockUpsert.mock.calls[0][0];
            // Metadata should be serialized (not a reference to the input object)
            expect(call.create.metadata).toEqual(metadata);
            expect(call.update.metadata).toEqual(metadata);
        });

        it("should handle null metadata", async () => {
            mockUpsert.mockResolvedValue({ id: "fail-1" });

            await enrichmentFailureService.recordFailure({
                entityType: "artist",
                entityId: "artist-456",
                errorMessage: "MusicBrainz timeout",
            });

            const call = mockUpsert.mock.calls[0][0];
            expect(call.create.metadata).toBeNull();
            // update.metadata should be undefined (don't overwrite existing)
            expect(call.update.metadata).toBeUndefined();
        });
    });
});
