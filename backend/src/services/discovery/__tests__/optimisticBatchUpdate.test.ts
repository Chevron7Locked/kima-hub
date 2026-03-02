/**
 * Tests for optimistic locking on DiscoveryBatch updates
 */

import { prisma } from '../../../utils/db';
import { updateBatchStatus } from '../optimisticBatchUpdate';

describe('updateBatchStatus with optimistic locking', () => {
    let testUserId: string;
    let testBatchId: string;

    beforeEach(async () => {
        testUserId = 'test-user-' + Date.now();

        const batch = await prisma.discoveryBatch.create({
            data: {
                userId: testUserId,
                weekStart: new Date('2024-01-01'),
                targetSongCount: 40,
                status: 'downloading',
                totalAlbums: 0,
                completedAlbums: 0,
                failedAlbums: 0,
                version: 0,
            },
        });
        testBatchId = batch.id;
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await prisma.discoveryBatch.deleteMany({
            where: { userId: testUserId },
        });
    });

    it('should successfully update batch status on first attempt', async () => {
        const result = await updateBatchStatus(testBatchId, {
            status: 'scanning',
            completedAlbums: 5,
            failedAlbums: 1,
        });

        expect(result.success).toBe(true);
        expect(result.retries).toBe(0);

        const updated = await prisma.discoveryBatch.findUnique({
            where: { id: testBatchId },
        });

        expect(updated?.status).toBe('scanning');
        expect(updated?.completedAlbums).toBe(5);
        expect(updated?.failedAlbums).toBe(1);
        expect(updated?.version).toBe(1);
    });

    it('should increment version on each update', async () => {
        await updateBatchStatus(testBatchId, { status: 'scanning' });
        await updateBatchStatus(testBatchId, { completedAlbums: 3 });
        await updateBatchStatus(testBatchId, { failedAlbums: 1 });

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: testBatchId },
        });

        expect(batch?.version).toBe(3);
    });

    it('should retry on version conflict and eventually succeed', async () => {
        let firstUpdateVersion: number | undefined;

        const update1 = updateBatchStatus(testBatchId, {
            completedAlbums: 5,
        }).then((result) => {
            firstUpdateVersion = result.version;
            return result;
        });

        const update2 = updateBatchStatus(testBatchId, {
            failedAlbums: 2,
        });

        const [result1, result2] = await Promise.all([update1, update2]);

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);

        const totalRetries = result1.retries + result2.retries;
        expect(totalRetries).toBeGreaterThan(0);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: testBatchId },
        });

        expect(batch?.completedAlbums).toBe(5);
        expect(batch?.failedAlbums).toBe(2);
        expect(batch?.version).toBe(2);
    });

    it('should fail after max retries on persistent conflict', async () => {
        const maxRetries = 5;

        const mockError = new Error('Record to update not found');
        (mockError as any).code = 'P2025';

        jest.spyOn(prisma.discoveryBatch, 'findUnique').mockResolvedValue({
            id: testBatchId,
            version: 0,
        } as any);

        jest.spyOn(prisma.discoveryBatch, 'update').mockRejectedValue(
            mockError
        );

        const result = await updateBatchStatus(
            testBatchId,
            { status: 'failed' },
            { maxRetries }
        );

        expect(result.success).toBe(false);
        expect(result.retries).toBeGreaterThanOrEqual(maxRetries);
        expect(result.error).toContain('Max retries');
    });

    it('should preserve existing fields not in update data', async () => {
        const result = await updateBatchStatus(testBatchId, {
            completedAlbums: 10,
        });

        expect(result.success).toBe(true);
        if (!result.success) {
            console.log('Update failed:', result.error);
        }

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: testBatchId },
        });

        expect(batch?.status).toBe('downloading');
        expect(batch?.completedAlbums).toBe(10);
        expect(batch?.targetSongCount).toBe(40);
    });

    it('should handle multiple concurrent updates correctly', async () => {
        const updates = Array.from({ length: 10 }, (_, i) =>
            updateBatchStatus(testBatchId, {
                completedAlbums: i + 1,
            })
        );

        const results = await Promise.all(updates);

        const allSucceeded = results.every((r) => r.success);
        expect(allSucceeded).toBe(true);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: testBatchId },
        });

        expect(batch?.version).toBe(10);
        expect(batch?.completedAlbums).toBeGreaterThan(0);
        expect(batch?.completedAlbums).toBeLessThanOrEqual(10);
    });

    it('should return error for non-existent batch', async () => {
        const result = await updateBatchStatus('non-existent-id', {
            status: 'completed',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('should handle null/undefined update fields correctly', async () => {
        await prisma.discoveryBatch.update({
            where: { id: testBatchId },
            data: { errorMessage: 'Initial error' },
        });

        const result = await updateBatchStatus(testBatchId, {
            status: 'completed',
            errorMessage: null,
        });

        expect(result.success).toBe(true);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: testBatchId },
        });

        expect(batch?.errorMessage).toBeNull();
    });

    it('should include expectedStatus in WHERE clause when provided', async () => {
        // Update batch status with expectedStatus
        const result = await updateBatchStatus(testBatchId, {
            status: 'scanning',
            expectedStatus: 'downloading',
        });

        expect(result.success).toBe(true);

        // Verify the batch was actually updated
        const updated = await prisma.discoveryBatch.findUnique({
            where: { id: testBatchId },
        });
        expect(updated?.status).toBe('scanning');
    });

    it('should fail when expectedStatus does not match current status', async () => {
        // First update to 'scanning'
        await updateBatchStatus(testBatchId, { status: 'scanning' });

        // Now try to update with expectedStatus 'downloading' (mismatch)
        const result = await updateBatchStatus(testBatchId, {
            status: 'completed',
            expectedStatus: 'downloading',
        }, { maxRetries: 2 });

        // Should fail because status is 'scanning', not 'downloading'
        expect(result.success).toBe(false);
    });
});
