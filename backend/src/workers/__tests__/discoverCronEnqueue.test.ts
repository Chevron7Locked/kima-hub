/**
 * The weekly cron enqueues each user's discover job under the same lock as the
 * manual /generate path (`discover:generate:<userId>`), and removes a finished
 * job with the same id first, since BullMQ silently ignores a re-add. The cron
 * callback is captured from a node-cron mock and fired directly. Real database
 * for the users whose Discover is enabled; the calls of other files' users are ignored.
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
        withLock: jest.fn(async (_key: string, _ttl: number, fn: (signal: AbortSignal) => Promise<unknown>) =>
            fn(new AbortController().signal),
        ),
    },
}));

import { startDiscoverWeeklyCron } from '../discoverCron';
import { prisma } from '../../utils/db';
import { discoverQueue } from '../queues';
import { distributedLock } from '../../utils/distributedLock';
import { LockHeldError, LockLostError, LockUnavailableError } from '../../utils/lockErrors';
import { logger } from '../../utils/logger';

const P = 'zz-discoverCron-';
const USER_A = `${P}a`;
const USER_B = `${P}b`;

async function wipe() {
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } }); // their Discover settings go too
}

/** Users with Discover enabled (or not) and their playlist size. */
async function seedUsers(users: Array<{ id: string; playlistSize: number; enabled?: boolean }>) {
    for (const u of users) {
        await prisma.user.create({
            data: {
                id: u.id, username: u.id, passwordHash: 'x',
                discoverConfig: { create: { playlistSize: u.playlistSize, enabled: u.enabled ?? true } },
            },
        });
    }
}

const withLock = distributedLock.withLock as jest.Mock;
const getJob = discoverQueue.getJob as jest.Mock;
const add = discoverQueue.add as jest.Mock;

/** The calls this file's users caused; the cron reads every enabled user in the database. */
const lockCalls = () => withLock.mock.calls.filter((c) => String(c[0]).startsWith(`discover:generate:${P}`));
const addCalls = () => add.mock.calls.filter((c) => String(c[1]?.userId).startsWith(P));
/** When the first call matching `matches` happened, among all calls of every mock. */
const firstOrder = (mock: jest.Mock, matches: (call: any[]) => boolean) =>
    mock.mock.invocationCallOrder[mock.mock.calls.findIndex(matches)];
const lockOrder = () => firstOrder(withLock, (c) => c[0] === `discover:generate:${USER_A}`);
const addOrder = () => firstOrder(add, (c) => c[1]?.userId === USER_A);
const getJobOrder = () => firstOrder(getJob, (c) => String(c[0]).includes(USER_A));

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

/** Tick the cron for one user whose job hash sits in `state`; return that job. */
async function tickWithStaleJob(state: string) {
    const stale = fakeJob(state);
    getJob.mockResolvedValue(stale);
    await seedUsers([{ id: USER_A, playlistSize: 25 }]);
    await tickCron()();
    return stale;
}

/** remove() must beat add(): a re-add on a live hash is a silent no-op. */
function expectRemoveBeforeAdd(stale: { remove: jest.Mock }) {
    const removeOrder = stale.remove.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(addOrder());
}

describe('discoverCron enqueue -- lock + stale-hash guard', () => {
    beforeAll(wipe);
    afterAll(wipe);
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        withLock.mockImplementation(
            async (_k: string, _t: number, fn: (signal: AbortSignal) => Promise<unknown>) => fn(new AbortController().signal)
        );
        add.mockResolvedValue({ id: 'new-job' });
        getJob.mockResolvedValue(null);
    });

    // The enqueue runs inside withLock under the manual path's key.
    it('takes distributedLock with the discover:generate:<userId> key around the enqueue', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }]);

        await tickCron()();

        expect(lockCalls()).toHaveLength(1);
        const [key, ttl] = lockCalls()[0];
        expect(key).toBe(`discover:generate:${USER_A}`);
        expect(typeof ttl).toBe('number');

        // The enqueue must happen inside the lock: withLock is invoked before add.
        expect(lockOrder()).toBeLessThan(addOrder());
    });

    // A retained COMPLETED hash for this user's current week must be removed
    // before re-adding, otherwise add() is a no-op and the cron silently
    // skips the user.
    it('removes a stale completed job hash inside the lock before re-enqueuing', async () => {
        const stale = await tickWithStaleJob('completed');

        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(addCalls()).toHaveLength(1);
        expectRemoveBeforeAdd(stale);
    });

    // A non-terminal (active) hash means a generation is already running for
    // this user/week. The cron must NOT remove it (that would orphan a live
    // run). Terminal-only removal, same as the /generate side.
    it('does not remove a non-terminal (active) job hash', async () => {
        const live = await tickWithStaleJob('active');

        expect(live.remove).not.toHaveBeenCalled();
    });

    // A lock failure for one user skips only that user; the next is enqueued.
    it('a lock failure for one user does not block the others', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }, { id: USER_B, playlistSize: 25 }]);
        withLock.mockImplementation(
            async (key: string, _t: number, fn: (signal: AbortSignal) => Promise<unknown>) => {
                if (key === `discover:generate:${USER_A}`) {
                    throw new LockHeldError(`discover:generate:${USER_A}`);
                }
                return fn(new AbortController().signal);
            }
        );

        await tickCron()();

        const addedUserIds = addCalls().map((c) => c[1]?.userId);
        expect(addedUserIds).not.toContain(USER_A);
        expect(addedUserIds).toContain(USER_B);
    });

    it('enqueues nothing for a user whose lock was lost before the enqueue, and goes on to the next', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }, { id: USER_B, playlistSize: 25 }]);
        withLock.mockImplementation(
            async (key: string, _t: number, fn: (signal: AbortSignal) => Promise<unknown>) => {
                const lost = new AbortController();
                if (key === `discover:generate:${USER_A}`) lost.abort(new LockLostError(key));
                return fn(lost.signal);
            }
        );

        await tickCron()();

        const addedUserIds = addCalls().map((c) => c[1]?.userId);
        expect(addedUserIds).not.toContain(USER_A);
        expect(addedUserIds).toContain(USER_B);
    });

    // With Redis unreachable the lock cannot say who holds it, and the job id is the same for a user and week, so a second
    // enqueue is ignored by the queue: the user is queued, not skipped.
    it('enqueues without the lock when Redis cannot be asked, under the same job id', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }]);
        withLock.mockImplementation(async (key: string) => {
            throw new LockUnavailableError(key);
        });

        await tickCron()();

        expect(addCalls()).toHaveLength(1);
        expect(addCalls()[0][2].jobId).toMatch(new RegExp(`^discover-weekly-${P}a-\\d{4}-\\d{2}-\\d{2}$`));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`${USER_A}`));
    });

    it('skips a user whose lock is held, and also when the unlocked enqueue itself fails', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }, { id: USER_B, playlistSize: 25 }]);
        withLock.mockImplementation(async (key: string) => {
            throw key.endsWith(USER_A) ? new LockHeldError(key) : new LockUnavailableError(key);
        });
        add.mockRejectedValue(new Error('queue down'));

        await tickCron()();

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`enqueue skipped for ${USER_A}`));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`enqueue skipped for ${USER_B}`));
    });

    it('logs how many jobs were queued, not how many users were found', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }, { id: USER_B, playlistSize: 25 }]);
        withLock.mockImplementation(
            async (key: string, _t: number, fn: (signal: AbortSignal) => Promise<unknown>) => {
                if (key === `discover:generate:${USER_A}`) throw new LockHeldError(key);
                return fn(new AbortController().signal);
            }
        );

        await tickCron()();

        const queued = (logger.debug as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Queued'));
        // Other files' users are in the database too, so the count is at least the one this file's user B made, and below the users found.
        expect(queued).toHaveLength(1);
        const [, queuedCount, foundCount] = queued[0].match(/Queued (\d+) of (\d+)/) ?? [];
        expect(Number(queuedCount)).toBeGreaterThanOrEqual(1);
        expect(Number(queuedCount)).toBeLessThan(Number(foundCount));
    });

    // The lock is taken before getJob and remove, not only around add.
    it('looks up and removes the old job inside the lock, not before it', async () => {
        const stale = await tickWithStaleJob('completed');

        const removeOrder = stale.remove.mock.invocationCallOrder[0];
        expect(lockOrder()).toBeLessThan(getJobOrder());
        expect(lockOrder()).toBeLessThan(removeOrder);
    });

    // A failed job blocks a re-add just as a completed one does.
    it('removes a stale failed job before enqueuing again, inside the lock', async () => {
        const stale = await tickWithStaleJob('failed');

        expect(stale.remove).toHaveBeenCalledTimes(1);
        expect(addCalls()).toHaveLength(1);
        expectRemoveBeforeAdd(stale);
    });

    // getJob looks up the same id add() enqueues.
    it('looks the job up by the same id that add() enqueues', async () => {
        await tickWithStaleJob('completed');

        const lookedUpId = getJob.mock.calls.find((c) => String(c[0]).includes(USER_A))![0];
        const enqueuedId = addCalls()[0][2].jobId;
        expect(lookedUpId).toBe(enqueuedId);
        expect(lookedUpId).toMatch(new RegExp(`^discover-weekly-${P}a-\\d{4}-\\d{2}-\\d{2}$`));
    });

    // Two enabled users, no stale hashes: each gets exactly one locked
    // enqueue with a week-keyed jobId.
    it('enqueues one locked job per enabled user with a week-keyed jobId', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }, { id: USER_B, playlistSize: 30 }]);

        await tickCron()();

        expect(lockCalls()).toHaveLength(2);
        expect(addCalls()).toHaveLength(2);
        for (const call of addCalls()) {
            expect(call[2].jobId).toMatch(new RegExp(`^discover-weekly-${P}[ab]-\\d{4}-\\d{2}-\\d{2}$`));
        }
    });

    it('leaves out a user who has turned Discover off', async () => {
        await seedUsers([{ id: USER_A, playlistSize: 25 }, { id: USER_B, playlistSize: 25, enabled: false }]);

        await tickCron()();

        expect(addCalls().map((c) => c[1]?.userId)).toEqual([USER_A]);
    });
});
