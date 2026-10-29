/**
 * POST /discover/generate removes a finished job with the same id before
 * re-adding, since BullMQ silently ignores a re-add. A running job is left alone.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        discoveryBatch: {
            findFirst: jest.fn(),
        },
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

jest.mock('../../services/lidarr', () => require('./helpers/discoverMocks').emptyLidarrMock());
jest.mock('../../utils/systemSettings', () => require('./helpers/discoverMocks').systemSettingsMock());
jest.mock('../../config', () => require('./helpers/discoverMocks').musicConfigMock());

jest.mock('../../workers/queues', () => require('./helpers/discoverMocks').discoverQueuesMock());

// A lock that runs the body, so the generate handler's code actually runs.
jest.mock('../../utils/distributedLock', () => require('./helpers/discoverMocks').distributedLockMock());

import express from 'express';
import request from 'supertest';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';
import { discoverQueue } from '../../workers/queues';
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

/** Build a fake BullMQ Job whose getState resolves to the given lifecycle state. */
function fakeJob(state: string) {
    return {
        id: `discover-weekly-user-123-${state}`,
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn().mockResolvedValue(undefined),
    };
}

describe('POST /discover/generate -- drop stale job hash before re-enqueue', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // No active batch -> the handler proceeds to the enqueue path.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue(null);
        // add() resolves to a job with an id so the handler can return jobId.
        (discoverQueue.add as jest.Mock).mockResolvedValue({ id: 'new-job-id' });
    });

    it('removes a finished job hash before enqueuing again', async () => {
        const stale = fakeJob('completed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        const removeOrder = stale.remove.mock.invocationCallOrder[0];
        const addOrder = (discoverQueue.add as jest.Mock).mock.invocationCallOrder[0];
        expect(removeOrder).toBeLessThan(addOrder);
    });

    // A failed run leaves a failed hash; re-adding the same id would otherwise do nothing.
    it('removes a failed job hash before enqueuing again', async () => {
        const stale = fakeJob('failed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
    });

    it('leaves an active job in place', async () => {
        const live = fakeJob('active');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(live);

        await request(app).post('/discover/generate');

        expect(live.remove).not.toHaveBeenCalled();
    });

    it('leaves a waiting job in place', async () => {
        const queued = fakeJob('waiting');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(queued);

        await request(app).post('/discover/generate');

        expect(queued.remove).not.toHaveBeenCalled();
    });

    it('looks the job up by the same id it enqueues', async () => {
        const stale = fakeJob('completed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(discoverQueue.getJob).toHaveBeenCalledTimes(1);
        const lookedUpId = (discoverQueue.getJob as jest.Mock).mock.calls[0][0];
        const enqueuedId = (discoverQueue.add as jest.Mock).mock.calls[0][2].jobId;
        expect(lookedUpId).toBe(enqueuedId);
        expect(lookedUpId).toMatch(/^discover-weekly-user-123-\d{4}-\d{2}-\d{2}$/);
    });

    it('enqueues once with a week-keyed job id when no job exists', async () => {
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(null);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        const addArgs = (discoverQueue.add as jest.Mock).mock.calls[0];
        expect(addArgs[2].jobId).toMatch(/^discover-weekly-user-123-\d{4}-\d{2}-\d{2}$/);
    });
});
