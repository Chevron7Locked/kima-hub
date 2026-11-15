/**
 * POST /discover/generate removes a finished job with the same id before
 * re-adding, since BullMQ silently ignores a re-add. A running job is left alone.
 * Real router and database; auth, the queue, the lock and Lidarr are stood in.
 */

jest.mock('../../middleware/auth', () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'dgj_user' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'dgj_user', role: 'admin' };
        next();
    },
}));

jest.mock('../../services/lidarr', () => require('./helpers/discoverMocks').emptyLidarrMock());

jest.mock('../../workers/queues', () => require('./helpers/discoverMocks').discoverQueuesMock());

// A lock that runs the body, so the generate handler's code actually runs.
jest.mock('../../utils/distributedLock', () => require('./helpers/discoverMocks').distributedLockMock());

import express from 'express';
import request from 'supertest';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';
import { discoverQueue } from '../../workers/queues';
import { distributedLock } from '../../utils/distributedLock';
import { LockHeldError, LockLostError, LockUnavailableError } from '../../utils/lockErrors';
import { redisClient } from '../../utils/redis';
import { closeClient } from '../../utils/closeRedisClient';
import { mountAsServer } from "./helpers/serverMount";

const USER = 'dgj_user';

async function cleanup() {
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

afterAll(async () => {
    await cleanup();
    // The router pulls in services/listenBrainz, which opens the shared Redis
    // client at import. Left open, Jest finishes the suite and outlives the
    // process on that socket.
    await closeClient(redisClient);
    await prisma.$disconnect();
});

function makeApp() {
    const app = express();
    app.use(express.json());
    mountAsServer(app, '/discover', discoverRoutes, "/api/discover");
    return app;
}

/** Build a fake BullMQ Job whose getState resolves to the given lifecycle state. */
function fakeJob(state: string) {
    return {
        id: `discover-weekly-dgj_user-${state}`,
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn().mockResolvedValue(undefined),
    };
}

describe('POST /discover/generate -- drop stale job hash before re-enqueue', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        // No active batch -> the handler proceeds to the enqueue path.
        await cleanup();
        await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
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
        expect(lookedUpId).toMatch(/^discover-weekly-dgj_user-\d{4}-\d{2}-\d{2}$/);
    });

    it('enqueues once with a week-keyed job id when no job exists', async () => {
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(null);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        const addArgs = (discoverQueue.add as jest.Mock).mock.calls[0];
        expect(addArgs[2].jobId).toMatch(/^discover-weekly-dgj_user-\d{4}-\d{2}-\d{2}$/);
    });

    it('enqueues nothing while the listener has a batch downloading, but a finished batch does not block', async () => {
        const batch = { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 40 };
        await prisma.discoveryBatch.create({ data: { ...batch, status: 'downloading' } });

        const blocked = await request(app).post('/discover/generate');

        expect(blocked.status).toBe(409);
        expect(discoverQueue.add).not.toHaveBeenCalled();

        await prisma.discoveryBatch.updateMany({ where: { userId: USER }, data: { status: 'completed' } });
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(null);

        const free = await request(app).post('/discover/generate');

        expect(free.status).toBe(200);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
    });

    it('says generation is in progress when another request holds the lock, and unavailable when Redis is down', async () => {
        const withLock = distributedLock.withLock as jest.Mock;
        withLock.mockRejectedValueOnce(new LockHeldError('discover:generate:dgj_user'));
        const held = await request(app).post('/discover/generate');

        withLock.mockRejectedValueOnce(new LockUnavailableError('discover:generate:dgj_user'));
        const down = await request(app).post('/discover/generate');

        expect(held.status).toBe(409);
        expect(held.body.code).toBe('LOCK_CONFLICT');
        expect(down.status).toBe(503);
        expect(down.body.code).toBe('LOCK_UNAVAILABLE');
        expect(discoverQueue.add).not.toHaveBeenCalled();
    });

    it('enqueues nothing, and says to try again, when the lock is lost before the enqueue', async () => {
        const withLock = distributedLock.withLock as jest.Mock;
        withLock.mockImplementationOnce(async (key: string, _ttl: number, fn: (signal: AbortSignal) => unknown) => {
            const lost = new AbortController();
            lost.abort(new LockLostError(key));
            return fn(lost.signal);
        });

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(503);
        expect(res.body.code).toBe('LOCK_LOST');
        expect(discoverQueue.add).not.toHaveBeenCalled();
    });
});
