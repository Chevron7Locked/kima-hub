/**
 * POST /discover/retry-unavailable downloads the albums, saves the counts, then
 * hands the batch to checkBatchCompletion, which waits for Lidarr imports. It
 * never marks the batch completed itself, and any crash in the background work
 * marks it failed ("Retry processing crashed"). Failure and edge paths first.
 */

// All mocks before imports.

jest.mock('../../utils/db', () => ({
    prisma: {
        discoveryBatch: {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        discoveryAlbum: {
            findMany: jest.fn(),
        },
        unavailableAlbum: {
            findMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
        },
        downloadJob: {
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Inject an authenticated user; the real middleware would 401 without a session.
jest.mock('../../middleware/auth', () => ({
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123', role: 'admin' };
        next();
    },
}));

// Module-load-time imports in discover.ts that we do not exercise here.
jest.mock('../../workers/queues', () => ({
    discoverQueue: { getJob: jest.fn(), add: jest.fn() },
    scanQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ musicPath: '/music' }),
}));
jest.mock('../../services/lidarr', () => ({ lidarrService: {} }));
jest.mock('../../utils/distributedLock', () => ({
    distributedLock: { withLock: jest.fn(async (_k: string, _t: number, fn: any) => fn()) },
}));
jest.mock('../../config', () => ({ config: { music: { musicPath: '/music' } } }));

// The two services the IIFE dynamically imports. acquireAlbum drives the loop;
// checkBatchCompletion is the proven flow the fix MUST hand off to.
const mockAcquireAlbum = jest.fn();
const mockCheckBatchCompletion = jest.fn();
jest.mock('../../services/acquisitionService', () => ({
    acquisitionService: { acquireAlbum: mockAcquireAlbum },
}));
jest.mock('../../services/discoverWeekly', () => ({
    discoverWeeklyService: { checkBatchCompletion: mockCheckBatchCompletion },
}));

import express from 'express';
import request from 'supertest';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';
import { scanQueue } from '../../workers/queues';

// Pin the wall clock so the resolved retry week is deterministic across CI.
beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
});
afterAll(() => {
    jest.useRealTimers();
});

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/discover', discoverRoutes);
    return app;
}

const RETRY_BATCH_ID = 'retry-batch-1';

const UNAVAILABLE_ALBUM = {
    id: 'unavail-1',
    userId: 'user-123',
    albumMbid: 'mbid-aaa',
    artistMbid: 'art-mbid-1',
    artistName: 'Aphex Twin',
    albumTitle: 'Drukqs',
    similarity: 0.88,
    tier: 'core',
    weekStartDate: new Date('2026-05-18T00:00:00.000Z'),
};

const RETRY_JOB = {
    id: 'job-1',
    userId: 'user-123',
    discoveryBatchId: RETRY_BATCH_ID,
    status: 'pending',
    targetMbid: 'mbid-aaa',
    metadata: {
        downloadType: 'discovery',
        artistName: 'Aphex Twin',
        albumTitle: 'Drukqs',
        albumMbid: 'mbid-aaa',
    },
};

/**
 * The background work runs after the response, so poll until `predicate` holds,
 * advancing timers. Throws when it never does.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return;
        // Flush microtasks (the IIFE's awaited mocks resolve as microtasks).
        await Promise.resolve();
        await Promise.resolve();
    }
    throw new Error(`waitFor timed out: ${label}`);
}

const SECOND_ALBUM = { ...UNAVAILABLE_ALBUM, id: 'unavail-2', albumMbid: 'mbid-bbb', albumTitle: 'Windowlicker' };
const SECOND_JOB = { ...RETRY_JOB, id: 'job-2', targetMbid: 'mbid-bbb' };

/** Wire every query the handler runs BEFORE its res.json, plus the transaction. */
function primeHandlerPreResponse({ twoAlbums = false } = {}) {
    // resolveViewWeek source: latest completed batch (tagged the prior week).
    (prisma.discoveryBatch.findFirst as jest.Mock)
        // 1st findFirst -> resolveViewWeek's completed-batch lookup
        .mockResolvedValueOnce({ weekStart: new Date('2026-05-18T00:00:00.000Z') })
        // 2nd findFirst -> active-batch guard (none in progress)
        .mockResolvedValueOnce(null);

    (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue(
        twoAlbums ? [UNAVAILABLE_ALBUM, SECOND_ALBUM] : [UNAVAILABLE_ALBUM],
    );
    // No successful discovery / library matches -> the album survives filtering.
    (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    // The create-batch transaction returns the new batch.
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb({
            discoveryBatch: { create: jest.fn().mockResolvedValue({ id: RETRY_BATCH_ID }) },
            downloadJob: { create: jest.fn().mockResolvedValue({}) },
            unavailableAlbum: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        }),
    );

    // No download is already working on the album; then the IIFE's job list.
    (prisma.downloadJob.findMany as jest.Mock)
        .mockResolvedValueOnce([])
        .mockResolvedValue(twoAlbums ? [RETRY_JOB, SECOND_JOB] : [RETRY_JOB]);
    (prisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});
    (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});
}

describe('POST /discover/retry-unavailable -- routes through checkBatchCompletion', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.discoveryBatch.findFirst as jest.Mock).mockReset();
        mockAcquireAlbum.mockReset();
        mockCheckBatchCompletion.mockReset();
        (scanQueue.add as jest.Mock).mockClear();
    });

    it('CRASH PATH: a rejected checkBatchCompletion is caught and marks the batch failed', async () => {
        // The handoff rejects, the last await, and the batch is marked failed.
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockRejectedValue(new Error('reconcile exploded'));

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200); // response already sent before background work

        // A rejected handoff must not surface as an unhandled rejection: the
        // batch is marked failed with this exact shape.
        await waitFor(
            () =>
                (prisma.discoveryBatch.update as jest.Mock).mock.calls.some(
                    (c) =>
                        c[0]?.data?.status === 'failed' &&
                        c[0]?.data?.errorMessage === 'Retry processing crashed',
                ),
            'batch marked failed with "Retry processing crashed"',
        );

        const failedCall = (prisma.discoveryBatch.update as jest.Mock).mock.calls.find(
            (c) => c[0]?.data?.status === 'failed',
        );
        expect(failedCall[0].where).toEqual({ id: RETRY_BATCH_ID });
        expect(failedCall[0].data.errorMessage).toBe('Retry processing crashed');
    });

    it('NO FORCE-COMPLETE: the handler never self-sets status:"completed" (that is checkBatchCompletion\'s job)', async () => {
        // checkBatchCompletion owns the terminal transition; this handler never
        // writes status "completed".
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked',
        );

        // The handler never marks the batch "completed" itself; checkBatchCompletion does.
        const completedSelfWrites = (prisma.discoveryBatch.update as jest.Mock).mock.calls.filter(
            (c) => c[0]?.data?.status === 'completed',
        );
        expect(completedSelfWrites).toHaveLength(0);
    });

    it('NO DEAD-END SCAN: the handler never enqueues the source:"discover-retry-unavailable" scan', async () => {
        // scanProcessor only builds the playlist for
        // source==="discover-weekly-completion". The retry-source scan is a
        // dead end -- checkBatchCompletion queues the correct completion-source
        // scan itself. The handler must NOT enqueue the retry-source scan.
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked',
        );

        // The handler enqueues no library scan of its own.
        const retrySourceScans = (scanQueue.add as jest.Mock).mock.calls.filter(
            (c) => c[1]?.source === 'discover-retry-unavailable',
        );
        expect(retrySourceScans).toHaveLength(0);
    });

    it('PARTIAL-FAILURE BOUNDARY: counts still reach the batch update, then hand off (no early force-complete)', async () => {
        // One album acquires, the next fails its acquire result. The handler must
        // record completed/failed counts AND still hand off to checkBatchCompletion
        // -- failures alone must not short-circuit into a self-completed batch.
        primeHandlerPreResponse({ twoAlbums: true });

        mockAcquireAlbum
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked after partial failure',
        );

        // The handoff carries the SAME batch id, and no self-completion happened.
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
        const completedSelfWrites = (prisma.discoveryBatch.update as jest.Mock).mock.calls.filter(
            (c) => c[0]?.data?.status === 'completed',
        );
        expect(completedSelfWrites).toHaveLength(0);
    });

    it('HAPPY PATH: after acquisitions, hands the batch to checkBatchCompletion', async () => {
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.queued).toBe(1);
        expect(res.body.batchId).toBe(RETRY_BATCH_ID);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked on happy path',
        );

        // The batch is handed to checkBatchCompletion by its id.
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
        // And the album was actually acquired first.
        expect(mockAcquireAlbum).toHaveBeenCalledTimes(1);
    });

    // Counts are saved before the handoff, the downloads run before it, the
    // crash handler covers the whole background job, and the handoff runs once.

    it('COUNTS PERSISTED: the completed/failed tally is written to the batch BEFORE handing off', async () => {
        // One success and one failure: completedAlbums 1, failedAlbums 1, saved
        // before checkBatchCompletion.
        primeHandlerPreResponse({ twoAlbums: true });

        // Record the order of (a) every batch update and (b) the handoff so we can
        // assert the final tally is persisted and that it lands at-or-before handoff.
        const events: string[] = [];
        (prisma.discoveryBatch.update as jest.Mock).mockImplementation(async (arg: any) => {
            const d = arg?.data ?? {};
            if (d.completedAlbums !== undefined || d.failedAlbums !== undefined) {
                events.push(`count:${d.completedAlbums ?? 'x'}/${d.failedAlbums ?? 'x'}`);
            } else {
                events.push(`update:${JSON.stringify(d)}`);
            }
            return {};
        });
        mockAcquireAlbum
            .mockResolvedValueOnce({ success: true })
            .mockResolvedValueOnce({ success: false });
        mockCheckBatchCompletion.mockImplementation(async () => {
            events.push('handoff');
        });

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(() => events.includes('handoff'), 'handoff recorded');

        // A final tally of 1 completed / 1 failed is persisted.
        const persistedFinalTally = (prisma.discoveryBatch.update as jest.Mock).mock.calls.some(
            (c) => c[0]?.data?.completedAlbums === 1 && c[0]?.data?.failedAlbums === 1,
        );
        expect(persistedFinalTally).toBe(true);

        // The final 1/1 tally is written at or before the handoff, or
        // checkBatchCompletion would see stale counts.
        const handoffIdx = events.indexOf('handoff');
        const finalTallyIdx = events.indexOf('count:1/1');
        expect(finalTallyIdx).toBeGreaterThanOrEqual(0);
        expect(finalTallyIdx).toBeLessThanOrEqual(handoffIdx);
    });

    it('ORDERING: acquireAlbum runs BEFORE checkBatchCompletion (no empty-batch handoff)', async () => {
        // A broken impl could hand off first and acquire never/after -- shipping an
        // empty batch. Pin the causal order: at least one acquire MUST resolve
        // before the handoff fires.
        primeHandlerPreResponse();
        const order: string[] = [];
        mockAcquireAlbum.mockImplementation(async () => {
            order.push('acquire');
            return { success: true };
        });
        mockCheckBatchCompletion.mockImplementation(async () => {
            order.push('handoff');
        });

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(() => order.includes('handoff'), 'handoff after acquire');

        // The acquire comes first, then the handoff.
        expect(order[0]).toBe('acquire');
        expect(order.indexOf('acquire')).toBeLessThan(order.indexOf('handoff'));
    });

    it('PRE-HANDOFF CRASH: a failure BEFORE the handoff still marks the batch failed (catch wraps the whole IIFE)', async () => {
        // The count update, before the handoff, rejects; the batch is still
        // marked failed.
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        // The per-job in-loop count update has .catch(()=>{}) and is swallowed; the
        // POST-loop count update (no status field) is awaited unguarded. Reject the
        // first un-suffixed count update (the post-loop Step-1 write), but let the
        // .catch's status:"failed" write succeed.
        (prisma.discoveryBatch.update as jest.Mock).mockImplementation(async (arg: any) => {
            const d = arg?.data ?? {};
            // The Step-1 post-loop write carries ONLY counts (no status). Crash it.
            if (d.status === undefined && (d.completedAlbums !== undefined || d.failedAlbums !== undefined)) {
                throw new Error('count persist exploded');
            }
            return {};
        });

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        // A crash before the handoff still writes the failed shape from the
        // outer catch, and the handoff never runs.
        await waitFor(
            () =>
                (prisma.discoveryBatch.update as jest.Mock).mock.calls.some(
                    (c) =>
                        c[0]?.data?.status === 'failed' &&
                        c[0]?.data?.errorMessage === 'Retry processing crashed',
                ),
            'pre-handoff crash marks batch failed',
        );
        expect(mockCheckBatchCompletion).not.toHaveBeenCalled();
    });

    it('SINGLE HANDOFF: checkBatchCompletion is invoked exactly once for the batch', async () => {
        // Two albums, both succeed: exactly one handoff after the loop, not one
        // per job.
        primeHandlerPreResponse({ twoAlbums: true });
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked',
        );
        // Give any erroneous extra handoff a chance to fire before asserting once.
        await waitFor(() => mockAcquireAlbum.mock.calls.length === 2, 'both albums acquired');
        await Promise.resolve();
        await Promise.resolve();

        // One handoff, despite two acquired albums.
        expect(mockCheckBatchCompletion).toHaveBeenCalledTimes(1);
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
    });
    it('IN FLIGHT: an album a download is already working on is not queued again', async () => {
        primeHandlerPreResponse();
        (prisma.downloadJob.findMany as jest.Mock).mockReset().mockResolvedValueOnce([{ targetMbid: UNAVAILABLE_ALBUM.albumMbid }]);

        const res = await request(app).post('/discover/retry-unavailable');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, queued: 0, message: 'The unavailable albums are already downloading' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(mockAcquireAlbum).not.toHaveBeenCalled();
    });
});
