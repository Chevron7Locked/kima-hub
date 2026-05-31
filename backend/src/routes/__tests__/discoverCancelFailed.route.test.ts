/**
 * Task 8 GATE 4 -- DELETE /discover/batch marks a cancelled batch `failed`,
 * not `completed`, so the Task-3 /current fallback (which queries
 * status="completed") skips it instead of reading it as a successful empty week.
 *
 * Failure path FIRST: prove the cancelled batch is written failed+completedAt+
 * errorMessage, and prove that a batch in that state is invisible to the
 * completed-only lookup that drives /current.
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
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
}));

jest.mock('../../services/lastfm', () => ({ lastFmService: {} }));
jest.mock('../../workers/queues', () => ({
    discoverQueue: {
        getJob: jest.fn(),
        add: jest.fn(),
        getActive: jest.fn().mockResolvedValue([]),
        getWaiting: jest.fn().mockResolvedValue([]),
    },
    scanQueue: { add: jest.fn() },
}));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/lidarr', () => ({ lidarrService: {} }));
jest.mock('../../utils/distributedLock', () => ({
    distributedLock: { withLock: jest.fn(async (_k: string, _t: number, fn: any) => fn()) },
}));
jest.mock('../../config', () => ({ config: { music: { musicPath: '/music' } } }));

import express from 'express';
import request from 'supertest';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/discover', discoverRoutes);
    return app;
}

describe('DELETE /discover/batch -- cancel marks the batch failed, not completed (Task 8)', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.downloadJob.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (prisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});
    });

    it('FAILURE PATH: a cancelled active batch is written status="failed" + completedAt + errorMessage', async () => {
        const before = Date.now();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValue([
            { id: 'batch-stuck-1', status: 'downloading', jobs: [] },
        ]);

        const res = await request(app).delete('/discover/batch');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.batchesCancelled).toBe(1);

        // DISCRIMINATOR: the batch update MUST set status="failed". The original
        // defect set it to "completed", which the /current fallback would read as
        // a real (empty) week.
        expect((prisma.discoveryBatch.update as jest.Mock).mock.calls.length).toBe(1);
        const updateArgs = (prisma.discoveryBatch.update as jest.Mock).mock.calls[0][0];
        expect(updateArgs.where).toEqual({ id: 'batch-stuck-1' });
        expect(updateArgs.data.status).toBe('failed');
        expect(updateArgs.data.status).not.toBe('completed');
        expect(updateArgs.data.errorMessage).toBe('Cancelled by user');
        // completedAt must be set (terminal) so terminal lookups still find it.
        expect(updateArgs.data.completedAt).toBeInstanceOf(Date);
        const completedAtMs = (updateArgs.data.completedAt as Date).getTime();
        expect(completedAtMs).toBeGreaterThanOrEqual(before);
        expect(completedAtMs).toBeLessThanOrEqual(Date.now());
    });

    it('CONSEQUENCE: a failed (cancelled) batch is excluded from the /current completed-only lookup', async () => {
        // The /current fallback queries discoveryBatch with status:"completed".
        // A Prisma mock filtered by that where-clause returns null for a batch
        // that is "failed" -- prove the handler then falls back to the calendar
        // week (stale=false) rather than serving the cancelled batch's week.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockImplementation((q: any) => {
            // Only a completed batch would be returned; our only batch is failed.
            if (q?.where?.status === 'completed') return Promise.resolve(null);
            return Promise.resolve(null);
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        // The cancelled batch's week never becomes the display week.
        expect(res.body.stale).toBe(false);
        // And the completed-only filter was actually applied.
        const calls = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls;
        expect(calls.some((c) => c[0]?.where?.status === 'completed')).toBe(true);
    });
});
