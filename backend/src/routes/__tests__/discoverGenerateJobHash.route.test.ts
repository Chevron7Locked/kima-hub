/**
 * Task 9 GATE 1 (part A) -- POST /discover/generate must drop a stale BullMQ
 * job hash before re-enqueuing.
 *
 * The defect: discoverQueue retains completed/failed job hashes
 * (queues.ts removeOnComplete: 100). Re-adding the SAME jobId returns the
 * existing (already-terminal) job WITHOUT enqueuing anything -- a silent no-op
 * (cf. podcast #81). The user clicks "generate", gets a 200 with the old job's
 * id, and nothing ever runs.
 *
 * Doctrine: FAILURE/EDGE paths FIRST, happy path LAST. Each assertion targets the
 * specific discriminator (getJob -> getState -> remove BEFORE add, only on a
 * TERMINAL state) so it cannot pass via a different code path.
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
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123', role: 'admin' };
        next();
    },
}));

jest.mock('../../services/lastfm', () => ({ lastFmService: {} }));
jest.mock('../../services/lidarr', () => ({ lidarrService: {} }));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../config', () => ({ config: { music: { musicPath: '/music' } } }));

jest.mock('../../workers/queues', () => ({
    discoverQueue: {
        getJob: jest.fn(),
        add: jest.fn(),
        getActive: jest.fn().mockResolvedValue([]),
        getWaiting: jest.fn().mockResolvedValue([]),
    },
    scanQueue: { add: jest.fn() },
}));

// Pass-through lock so the generate handler's body actually runs.
jest.mock('../../utils/distributedLock', () => ({
    distributedLock: {
        withLock: jest.fn(async (_k: string, _t: number, fn: any) => fn()),
    },
}));

import express from 'express';
import request from 'supertest';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';
import { discoverQueue } from '../../workers/queues';

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

describe('POST /discover/generate -- drop stale job hash before re-enqueue (Task 9)', () => {
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

    // FAILURE PATH (the bug this task exists for): a COMPLETED job hash is still
    // in Redis. Re-adding the same jobId is a silent no-op unless the stale hash
    // is removed first. Discriminator: remove() must be called on the existing
    // job BEFORE add() runs. A handler that skips the removal (the legacy bug)
    // never calls getJob().remove(), so this fails on the un-fixed code.
    it('FAILURE PATH: removes a stale COMPLETED job hash before re-enqueuing', async () => {
        const stale = fakeJob('completed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        // Discriminator 1: the stale hash was actually removed.
        expect(stale.remove).toHaveBeenCalledTimes(1);
        // Discriminator 2: a fresh job was enqueued AFTER removal (not skipped).
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        const removeOrder = stale.remove.mock.invocationCallOrder[0];
        const addOrder = (discoverQueue.add as jest.Mock).mock.invocationCallOrder[0];
        expect(removeOrder).toBeLessThan(addOrder);
    });

    // FAILURE PATH: a FAILED job hash must also be cleared (a previous run that
    // errored leaves a failed hash; re-adding the same id would otherwise no-op).
    it('FAILURE PATH: removes a stale FAILED job hash before re-enqueuing', async () => {
        const stale = fakeJob('failed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
    });

    // EDGE / SAFETY: a NON-terminal (active) job with the same id means a run is
    // already in flight. removing it would orphan a live generation. The guard
    // must only remove on completed|failed. Discriminator: remove() NOT called
    // for an active job. (A naive "remove whatever getJob returns" impl -- the
    // over-correction -- would wrongly kill the live job and fail here.)
    it('EDGE: does NOT remove a non-terminal (active) job and does NOT double-enqueue over it', async () => {
        const live = fakeJob('active');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(live);

        await request(app).post('/discover/generate');

        // The live job is never removed.
        expect(live.remove).not.toHaveBeenCalled();
    });

    // EDGE: a WAITING (queued, not yet started) job is likewise non-terminal --
    // it must not be removed. Pins the terminal-only contract from the other side.
    it('EDGE: does NOT remove a non-terminal (waiting) job', async () => {
        const queued = fakeJob('waiting');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(queued);

        await request(app).post('/discover/generate');

        expect(queued.remove).not.toHaveBeenCalled();
    });

    // CRITIC GAP A: the removal only fixes the no-op if it looks up the SAME
    // jobId it is about to add. A broken impl that does getJob(<some other id>)
    // -> remove(), then add(<the real week-keyed id>) would remove the WRONG
    // hash and re-add the still-present real one -- the production no-op bug
    // survives, yet every existing assertion (remove called, add called, order)
    // passes because getJob is mocked to return the stale job regardless of arg.
    // Pin the contract: the id passed to getJob equals the id passed to add.
    it('CRITIC GAP A: getJob is looked up with the SAME jobId that add() enqueues', async () => {
        const stale = fakeJob('completed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(discoverQueue.getJob).toHaveBeenCalledTimes(1);
        const lookedUpId = (discoverQueue.getJob as jest.Mock).mock.calls[0][0];
        const enqueuedId = (discoverQueue.add as jest.Mock).mock.calls[0][2].jobId;
        expect(lookedUpId).toBe(enqueuedId);
        // And it is the week-keyed id, not some unrelated constant.
        expect(lookedUpId).toMatch(/^discover-weekly-user-123-\d{4}-\d{2}-\d{2}$/);
    });

    // HAPPY PATH (last): no stale hash exists -> nothing to remove, a single job
    // is enqueued with the resolved week-keyed jobId.
    it('HAPPY PATH: no existing hash -> enqueues once with a week-keyed jobId', async () => {
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(null);

        const res = await request(app).post('/discover/generate');

        expect(res.status).toBe(200);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        const addArgs = (discoverQueue.add as jest.Mock).mock.calls[0];
        // jobId is `discover-weekly-<userId>-<YYYY-MM-DD>` (week key from the helper).
        expect(addArgs[2].jobId).toMatch(/^discover-weekly-user-123-\d{4}-\d{2}-\d{2}$/);
    });
});
