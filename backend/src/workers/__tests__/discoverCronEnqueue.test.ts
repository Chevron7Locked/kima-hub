/**
 * Task 9 GATE 1 (part B) -- the cron enqueue path must (a) take the same
 * distributed lock the manual /generate path holds, and (b) drop a stale BullMQ
 * job hash before re-adding the same jobId.
 *
 * Two defects in one path:
 *  1. SILENT DROP: re-adding the same jobId returns the retained completed/failed
 *     hash without enqueuing (queues.ts removeOnComplete: 100). The cron silently
 *     does nothing for any user whose previous week's hash is still in Redis.
 *  2. TOCTOU: the cron enqueue holds no lock, so its getJob->remove->add races a
 *     concurrent manual /generate (which DOES hold distributedLock,
 *     discover.ts:202). Two enqueues / a remove-then-add interleave can drop a
 *     job or double-run.
 *
 * The cron body lives inside cron.schedule's callback. We mock node-cron to
 * capture that callback and invoke it directly.
 *
 * Doctrine: FAILURE/race paths FIRST, happy path LAST. Every assertion targets a
 * specific discriminator (lock key, remove-inside-callback, terminal-only remove,
 * per-user isolation on lock failure).
 */

// Capture the scheduled callback so the test can fire it deterministically.
let scheduledCallback: (() => Promise<void>) | null = null;
jest.mock('node-cron', () => ({
    __esModule: true,
    default: {
        schedule: jest.fn((_expr: string, cb: () => Promise<void>) => {
            scheduledCallback = cb;
            return { stop: jest.fn() };
        }),
    },
}));

jest.mock('../../utils/db', () => ({
    prisma: {
        userDiscoverConfig: { findMany: jest.fn() },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../queues', () => ({
    discoverQueue: {
        getJob: jest.fn(),
        add: jest.fn(),
    },
}));

// The lock is the contract under test: by default it passes through (runs the
// callback). A race/failure test overrides it to reject for a specific user.
jest.mock('../../utils/distributedLock', () => ({
    distributedLock: {
        withLock: jest.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    },
}));

import { startDiscoverWeeklyCron } from '../discoverCron';
import { prisma } from '../../utils/db';
import { discoverQueue } from '../queues';
import { distributedLock } from '../../utils/distributedLock';

function fakeJob(state: string) {
    return {
        id: `job-${state}`,
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn().mockResolvedValue(undefined),
    };
}

/** Register the cron and return the captured tick callback. */
function tickCron(): () => Promise<void> {
    scheduledCallback = null;
    startDiscoverWeeklyCron();
    const cb = scheduledCallback;
    if (!cb) {
        throw new Error('cron.schedule callback was not captured');
    }
    return cb;
}

describe('discoverCron enqueue -- lock + stale-hash guard (Task 9)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (distributedLock.withLock as jest.Mock).mockImplementation(
            async (_k: string, _t: number, fn: () => Promise<unknown>) => fn()
        );
        (discoverQueue.add as jest.Mock).mockResolvedValue({ id: 'new-job' });
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(null);
    });

    // RACE PATH (the TOCTOU this task exists for): the per-user enqueue MUST run
    // under distributedLock with the SAME key the manual /generate handler uses
    // (`discover:generate:<userId>`). Without the lock, the cron's
    // getJob->remove->add interleaves a concurrent manual generate. Discriminator:
    // withLock called with exactly that key, and the enqueue happens INSIDE the
    // locked callback (add not called before withLock).
    it('RACE PATH: takes distributedLock with the discover:generate:<userId> key around the enqueue', async () => {
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
        ]);

        await tickCron()();

        expect(distributedLock.withLock).toHaveBeenCalledTimes(1);
        const [key, ttl] = (distributedLock.withLock as jest.Mock).mock.calls[0];
        expect(key).toBe('discover:generate:user-a');
        expect(typeof ttl).toBe('number');

        // The enqueue must happen inside the lock: withLock is invoked before add.
        const lockOrder = (distributedLock.withLock as jest.Mock).mock.invocationCallOrder[0];
        const addOrder = (discoverQueue.add as jest.Mock).mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(addOrder);
    });

    // FAILURE PATH (silent drop): a retained COMPLETED hash for this user's
    // current week must be removed before re-adding, otherwise add() is a no-op
    // and the cron silently skips the user. Discriminator: remove() called, then
    // add() called -- and both happen inside the lock callback.
    it('FAILURE PATH: removes a stale COMPLETED job hash before re-enqueuing (inside the lock)', async () => {
        const stale = fakeJob('completed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
        ]);

        await tickCron()();

        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        const removeOrder = stale.remove.mock.invocationCallOrder[0];
        const addOrder = (discoverQueue.add as jest.Mock).mock.invocationCallOrder[0];
        expect(removeOrder).toBeLessThan(addOrder);
    });

    // EDGE / SAFETY: a non-terminal (active) hash means a generation is already
    // running for this user/week. The cron must NOT remove it (that would orphan
    // a live run). Terminal-only removal, same as the /generate side.
    it('EDGE: does NOT remove a non-terminal (active) job hash', async () => {
        const live = fakeJob('active');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(live);
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
        ]);

        await tickCron()();

        expect(live.remove).not.toHaveBeenCalled();
    });

    // FAILURE ISOLATION: when the lock cannot be acquired for one user (a
    // concurrent generate holds it), that user's enqueue is skipped WITHOUT
    // aborting the whole cron tick -- the next user must still be enqueued.
    // Discriminator: user-a's lock rejects, user-a never enqueues, user-b does.
    // A missing per-user .catch would let the rejection bubble and skip user-b.
    it('FAILURE ISOLATION: a lock failure for one user does not block the others', async () => {
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
            { userId: 'user-b', playlistSize: 25 },
        ]);
        (distributedLock.withLock as jest.Mock).mockImplementation(
            async (key: string, _t: number, fn: () => Promise<unknown>) => {
                if (key === 'discover:generate:user-a') {
                    throw new Error('Failed to acquire lock: discover:generate:user-a');
                }
                return fn();
            }
        );

        await tickCron()();

        const addedUserIds = (discoverQueue.add as jest.Mock).mock.calls.map(
            (c) => c[1]?.userId
        );
        expect(addedUserIds).not.toContain('user-a');
        expect(addedUserIds).toContain('user-b');
    });

    // CRITIC GAP B (the TOCTOU this task exists for, fully pinned): the existing
    // RACE test proves withLock fires before add, and the COMPLETED test proves
    // remove fires before add -- but NEITHER proves getJob/remove run INSIDE the
    // lock. A broken impl that does getJob->remove OUTSIDE the lock and only
    // wraps add() in withLock reintroduces the exact getJob->remove->add race the
    // task closes (a concurrent /generate can interleave between the unlocked
    // remove and the locked add), yet passes both existing tests. Pin it: the
    // lock is acquired BEFORE getJob and BEFORE remove.
    it('CRITIC GAP B: getJob and remove happen INSIDE the lock (not before it)', async () => {
        const stale = fakeJob('completed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
        ]);

        await tickCron()();

        const lockOrder = (distributedLock.withLock as jest.Mock).mock.invocationCallOrder[0];
        const getJobOrder = (discoverQueue.getJob as jest.Mock).mock.invocationCallOrder[0];
        const removeOrder = stale.remove.mock.invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(getJobOrder);
        expect(lockOrder).toBeLessThan(removeOrder);
    });

    // CRITIC GAP C: the COMPLETED test pins terminal removal, but a FAILED hash
    // is the other terminal state and is just as silent a drop (a prior run that
    // errored leaves a failed hash; re-adding the same id no-ops). A broken impl
    // that removes only on 'completed' silently skips every user whose last run
    // FAILED -- forever -- and passes the COMPLETED-only suite. Mirror the
    // /generate side, which DOES test both terminal states.
    it('CRITIC GAP C: removes a stale FAILED job hash before re-enqueuing (inside the lock)', async () => {
        const stale = fakeJob('failed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
        ]);

        await tickCron()();

        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(discoverQueue.add).toHaveBeenCalledTimes(1);
        const removeOrder = stale.remove.mock.invocationCallOrder[0];
        const addOrder = (discoverQueue.add as jest.Mock).mock.invocationCallOrder[0];
        expect(removeOrder).toBeLessThan(addOrder);
    });

    // CRITIC GAP D: the removal only fixes the no-op if it looks up the SAME id
    // it adds. getJob is mocked to return the stale job for ANY arg, so an impl
    // that checks/removes the wrong id and adds the real week-keyed id removes a
    // bystander hash, re-adds the still-present real one, and the silent drop
    // survives -- yet remove/add/order all pass. Pin: getJob's id == add's id.
    it('CRITIC GAP D: getJob is looked up with the SAME jobId that add() enqueues', async () => {
        const stale = fakeJob('completed');
        (discoverQueue.getJob as jest.Mock).mockResolvedValue(stale);
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
        ]);

        await tickCron()();

        const lookedUpId = (discoverQueue.getJob as jest.Mock).mock.calls[0][0];
        const enqueuedId = (discoverQueue.add as jest.Mock).mock.calls[0][2].jobId;
        expect(lookedUpId).toBe(enqueuedId);
        expect(lookedUpId).toMatch(/^discover-weekly-user-a-\d{4}-\d{2}-\d{2}$/);
    });

    // HAPPY PATH (last): two enabled users, no stale hashes -> each gets exactly
    // one locked enqueue with a week-keyed jobId.
    it('HAPPY PATH: enqueues one locked job per enabled user with a week-keyed jobId', async () => {
        (prisma.userDiscoverConfig.findMany as jest.Mock).mockResolvedValue([
            { userId: 'user-a', playlistSize: 25 },
            { userId: 'user-b', playlistSize: 30 },
        ]);

        await tickCron()();

        expect(distributedLock.withLock).toHaveBeenCalledTimes(2);
        expect(discoverQueue.add).toHaveBeenCalledTimes(2);
        for (const call of (discoverQueue.add as jest.Mock).mock.calls) {
            expect(call[2].jobId).toMatch(/^discover-weekly-user-[ab]-\d{4}-\d{2}-\d{2}$/);
        }
    });
});
