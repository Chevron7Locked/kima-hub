/**
 * DELETE /discover/batch marks the cancelled batch failed with completedAt and a
 * message, so the completed-only lookup behind /current skips it.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        discoveryBatch: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
        },
        discoveryAlbum: { findMany: jest.fn() },
        unavailableAlbum: { findMany: jest.fn() },
        album: { findMany: jest.fn(), findFirst: jest.fn() },
        track: { findMany: jest.fn() },
        downloadJob: { updateMany: jest.fn() },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../middleware/auth', () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123', role: 'admin' };
        next();
    },
}));

jest.mock('../../workers/queues', () => require('./helpers/discoverMocks').discoverQueuesMock());
jest.mock('../../utils/systemSettings', () => require('./helpers/discoverMocks').systemSettingsMock());
jest.mock('../../services/lidarr', () => require('./helpers/discoverMocks').emptyLidarrMock());
jest.mock('../../utils/distributedLock', () => require('./helpers/discoverMocks').distributedLockMock());
jest.mock('../../config', () => require('./helpers/discoverMocks').musicConfigMock());

import express from 'express';
import request from 'supertest';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';
import { redisClient } from '../../utils/redis';
import { closeClient } from '../../utils/closeRedisClient';

afterAll(async () => {
    // The router pulls in services/listenBrainz, which opens the shared Redis
    // client at import. Left open, Jest finishes the suite and outlives the
    // process on that socket.
    await closeClient(redisClient);
});

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/discover', discoverRoutes);
    return app;
}

describe('DELETE /discover/batch -- cancel marks the batch failed, not completed', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.downloadJob.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (prisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});
    });

    it('writes a cancelled active batch as failed with completedAt and an error message', async () => {
        const before = Date.now();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValue([
            { id: 'batch-stuck-1', status: 'downloading', jobs: [] },
        ]);

        const res = await request(app).delete('/discover/batch');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.batchesCancelled).toBe(1);

        // "completed" would make /current read the cancelled batch as a real, empty week.
        expect((prisma.discoveryBatch.update as jest.Mock).mock.calls.length).toBe(1);
        const updateArgs = (prisma.discoveryBatch.update as jest.Mock).mock.calls[0][0];
        expect(updateArgs.where).toEqual({ id: 'batch-stuck-1' });
        expect(updateArgs.data.status).toBe('failed');
        expect(updateArgs.data.status).not.toBe('completed');
        expect(updateArgs.data.errorMessage).toBe('Cancelled by user');
        // completedAt marks the batch terminal, so terminal lookups still find it.
        expect(updateArgs.data.completedAt).toBeInstanceOf(Date);
        const completedAtMs = (updateArgs.data.completedAt as Date).getTime();
        expect(completedAtMs).toBeGreaterThanOrEqual(before);
        expect(completedAtMs).toBeLessThanOrEqual(Date.now());
    });

    it('keeps a cancelled batch out of the completed-only lookup behind /current', async () => {
        // The lookup finds nothing for a failed batch, so /current falls back to the calendar week.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(false);
        const calls = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls;
        expect(calls.some((c) => c[0]?.where?.status === 'completed')).toBe(true);
    });
});
