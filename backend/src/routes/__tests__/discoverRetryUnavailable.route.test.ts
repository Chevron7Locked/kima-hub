/**
 * Task 6 adversarial route tests -- POST /discover/retry-unavailable must route
 * its background processing through the PROVEN completion flow
 * (discoverWeeklyService.checkBatchCompletion), NOT the broken force-complete
 * subset it currently reimplements.
 *
 * Doctrine: failure / edge / boundary paths FIRST, happy path LAST.
 *
 * The confirmed production defect (plan Task 6):
 *   The retry IIFE downloads albums, then (a) queues a scan with
 *   source:"discover-retry-unavailable" -- but scanProcessor only builds the
 *   playlist for source==="discover-weekly-completion" -- and (b) force-sets the
 *   batch status to "completed" itself. buildFinalPlaylist reads
 *   downloadJob.findMany({status:"completed"}); Lidarr jobs finish ASYNC after
 *   the scan, so a bare force-complete ships an EMPTY playlist and marks the
 *   batch done while imports are still in flight. checkBatchCompletion is the one
 *   path that owns the Lidarr wait + the completion-source scan + reconcile.
 *
 * The fix also adds a top-level `.catch` to the previously unguarded
 * fire-and-forget IIFE so a crash in background processing marks the batch
 * `failed` ("Retry processing crashed") instead of leaving it stuck.
 *
 * Each assertion targets a SPECIFIC discriminator that can ONLY be produced by
 * the Task-6 code path, so the test cannot pass against the unmodified handler:
 *   - checkBatchCompletion(batch.id) MUST be invoked (the unmodified handler
 *     never imports discoverWeeklyService at all).
 *   - The handler MUST NOT force-set status:"completed" itself, and MUST NOT
 *     enqueue the dead-end "discover-retry-unavailable" scan.
 *   - On a background crash, the IIFE's .catch MUST write
 *     status:"failed" + errorMessage:"Retry processing crashed".
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
jest.mock('../../services/lastfm', () => ({ lastFmService: {} }));
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
 * The IIFE runs fire-and-forget AFTER res.json(); supertest resolves on response
 * end, before the background work settles. Poll until a `predicate` observes the
 * mock state the IIFE produces, advancing timers so any internal awaits flush.
 * Throws (rather than hanging) if the predicate never holds, so a regression
 * reads as an explicit timeout, not a silent pass.
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

/** Wire every query the handler runs BEFORE its res.json, plus the transaction. */
function primeHandlerPreResponse() {
    // resolveViewWeek source: latest completed batch (tagged the prior week).
    (prisma.discoveryBatch.findFirst as jest.Mock)
        // 1st findFirst -> resolveViewWeek's completed-batch lookup
        .mockResolvedValueOnce({ weekStart: new Date('2026-05-18T00:00:00.000Z') })
        // 2nd findFirst -> active-batch guard (none in progress)
        .mockResolvedValueOnce(null);

    (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([UNAVAILABLE_ALBUM]);
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

    // The IIFE's job list.
    (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([RETRY_JOB]);
    (prisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});
    (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});
}

describe('POST /discover/retry-unavailable -- routes through checkBatchCompletion (Task 6)', () => {
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
        // The IIFE was previously unguarded fire-and-forget. The Task-6 top-level
        // .catch must convert ANY background crash into status:"failed" with the
        // distinguishing errorMessage "Retry processing crashed". We force the
        // handoff itself to reject (the deepest background await) to prove the
        // catch wraps the WHOLE IIFE, not just the acquire loop.
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockRejectedValue(new Error('reconcile exploded'));

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200); // response already sent before background work

        // DISCRIMINATOR: the unmodified handler has NO top-level catch, so a
        // rejected handoff would surface as an unhandled rejection and the batch
        // would never be marked failed. The fix must write this exact shape.
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
        // The core defect: the old IIFE force-set the batch to "completed" itself,
        // shipping an empty playlist before async Lidarr imports landed. After the
        // fix, the handler must hand off and let checkBatchCompletion own the
        // terminal transition -- so NO discoveryBatch.update with
        // status:"completed" may originate from this handler.
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked',
        );

        // DISCRIMINATOR: zero self-driven "completed" transitions. The unmodified
        // handler writes status:"completed" at discover.ts:1073 -- this assertion
        // fails against it.
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

        // DISCRIMINATOR: the unmodified handler calls scanQueue.add('scan', {
        // ..., source:'discover-retry-unavailable' }). The fix removes it.
        const retrySourceScans = (scanQueue.add as jest.Mock).mock.calls.filter(
            (c) => c[1]?.source === 'discover-retry-unavailable',
        );
        expect(retrySourceScans).toHaveLength(0);
    });

    it('PARTIAL-FAILURE BOUNDARY: counts still reach the batch update, then hand off (no early force-complete)', async () => {
        // One album acquires, the next fails its acquire result. The handler must
        // record completed/failed counts AND still hand off to checkBatchCompletion
        // -- failures alone must not short-circuit into a self-completed batch.
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce({ weekStart: new Date('2026-05-18T00:00:00.000Z') })
            .mockResolvedValueOnce(null);
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([
            UNAVAILABLE_ALBUM,
            { ...UNAVAILABLE_ALBUM, id: 'unavail-2', albumMbid: 'mbid-bbb', albumTitle: 'Windowlicker' },
        ]);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
            cb({
                discoveryBatch: { create: jest.fn().mockResolvedValue({ id: RETRY_BATCH_ID }) },
                downloadJob: { create: jest.fn().mockResolvedValue({}) },
                unavailableAlbum: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
            }),
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            RETRY_JOB,
            { ...RETRY_JOB, id: 'job-2', targetMbid: 'mbid-bbb' },
        ]);
        (prisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});

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

        // DISCRIMINATOR: the proven flow is invoked with the retry batch id.
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
        // And the album was actually acquired first.
        expect(mockAcquireAlbum).toHaveBeenCalledTimes(1);
    });

    // ---------------------------------------------------------------------
    // CRITIC ADDITIONS (gap closure). The five tests above pin the handoff,
    // the no-self-complete, the no-dead-end-scan, and one crash shape. They do
    // NOT pin: (a) that the completed/failed COUNTS are actually persisted to
    // the batch before the handoff -- Step 1's update at plan lines 559-563 --
    // so a handoff that ships uncounted progress still passes; (b) that the
    // acquire loop runs BEFORE the handoff -- a broken impl calling
    // checkBatchCompletion first (empty batch) still passes the happy path;
    // (c) that the Step-2 .catch wraps the WHOLE IIFE -- the crash test only
    // rejects checkBatchCompletion (the deepest await), so a narrow local
    // try/catch around just that call would pass while a PRE-handoff crash
    // (downloadJob.findMany / the count update) leaks unhandled and never
    // marks the batch failed; (d) that the handoff happens exactly once.
    // ---------------------------------------------------------------------

    it('COUNTS PERSISTED: the completed/failed tally is written to the batch BEFORE handing off', async () => {
        // Plan Step 1: the fix must
        //   prisma.discoveryBatch.update({ data:{ completedAlbums, failedAlbums }})
        // and THEN call checkBatchCompletion. A broken impl that hands off without
        // persisting the tally would ship a batch whose progress is wrong/zero.
        // One success + one failure => completedAlbums:1, failedAlbums:1.
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce({ weekStart: new Date('2026-05-18T00:00:00.000Z') })
            .mockResolvedValueOnce(null);
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([
            UNAVAILABLE_ALBUM,
            { ...UNAVAILABLE_ALBUM, id: 'unavail-2', albumMbid: 'mbid-bbb', albumTitle: 'Windowlicker' },
        ]);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
            cb({
                discoveryBatch: { create: jest.fn().mockResolvedValue({ id: RETRY_BATCH_ID }) },
                downloadJob: { create: jest.fn().mockResolvedValue({}) },
                unavailableAlbum: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
            }),
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            RETRY_JOB,
            { ...RETRY_JOB, id: 'job-2', targetMbid: 'mbid-bbb' },
        ]);
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});

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

        // DISCRIMINATOR 1: a final tally of 1 completed / 1 failed is persisted.
        const persistedFinalTally = (prisma.discoveryBatch.update as jest.Mock).mock.calls.some(
            (c) => c[0]?.data?.completedAlbums === 1 && c[0]?.data?.failedAlbums === 1,
        );
        expect(persistedFinalTally).toBe(true);

        // DISCRIMINATOR 2: the final 1/1 tally is written at or before the handoff,
        // never only after -- otherwise checkBatchCompletion sees stale counts.
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

        // DISCRIMINATOR: the first recorded event is the acquire, not the handoff.
        expect(order[0]).toBe('acquire');
        expect(order.indexOf('acquire')).toBeLessThan(order.indexOf('handoff'));
    });

    it('PRE-HANDOFF CRASH: a failure BEFORE the handoff still marks the batch failed (catch wraps the whole IIFE)', async () => {
        // The existing crash test rejects checkBatchCompletion -- effectively the
        // LAST await in the IIFE. That passes even if the .catch only wraps the
        // handoff call. Step 2 requires the .catch to wrap the ENTIRE IIFE. Force
        // a crash in an await that runs INSIDE the IIFE but BEFORE the handoff:
        // the post-loop count update (Step 1's
        //   discoveryBatch.update({ data:{ completedAlbums, failedAlbums }})).
        // We make THAT update reject while the later failed-status update (driven
        // by the .catch) resolves. A narrow local catch around only
        // checkBatchCompletion leaves this crash unhandled and the test times out
        // -- the correct failure signal. The whole-IIFE .catch must still write
        // status:"failed" / "Retry processing crashed".
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

        // DISCRIMINATOR: even though the crash happens BEFORE the handoff, the
        // whole-IIFE .catch must still write the failed shape, and the handoff
        // must NEVER run because the crash precedes it.
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
        // Removing the force-complete must not be "compensated" by calling the
        // proven flow per-job or twice. Two albums, both succeed -> exactly ONE
        // handoff after the loop.
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce({ weekStart: new Date('2026-05-18T00:00:00.000Z') })
            .mockResolvedValueOnce(null);
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([
            UNAVAILABLE_ALBUM,
            { ...UNAVAILABLE_ALBUM, id: 'unavail-2', albumMbid: 'mbid-bbb', albumTitle: 'Windowlicker' },
        ]);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
            cb({
                discoveryBatch: { create: jest.fn().mockResolvedValue({ id: RETRY_BATCH_ID }) },
                downloadJob: { create: jest.fn().mockResolvedValue({}) },
                unavailableAlbum: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
            }),
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
            RETRY_JOB,
            { ...RETRY_JOB, id: 'job-2', targetMbid: 'mbid-bbb' },
        ]);
        (prisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});
        (prisma.downloadJob.update as jest.Mock).mockResolvedValue({});
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

        // DISCRIMINATOR: exactly one handoff, despite two acquired albums.
        expect(mockCheckBatchCompletion).toHaveBeenCalledTimes(1);
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
    });
});
