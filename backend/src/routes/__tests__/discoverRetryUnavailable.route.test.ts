/**
 * POST /discover/retry-unavailable downloads the albums, saves the counts, then
 * hands the batch to checkBatchCompletion, which waits for Lidarr imports. It
 * never marks the batch completed itself, and any crash in the background work
 * marks it failed ("Retry processing crashed").
 */

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

// Modules discover.ts imports at load time that this test does not exercise.
jest.mock('../../workers/queues', () => require('./helpers/discoverMocks').discoverQueuesMock());
jest.mock('../../utils/systemSettings', () => require('./helpers/discoverMocks').systemSettingsMock());
jest.mock('../../services/lidarr', () => require('./helpers/discoverMocks').emptyLidarrMock());
jest.mock('../../utils/distributedLock', () => require('./helpers/discoverMocks').distributedLockMock());
jest.mock('../../config', () => require('./helpers/discoverMocks').musicConfigMock());

// The two services the background job imports: acquireAlbum drives the loop,
// checkBatchCompletion is where the batch is handed off.
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
 * flushing microtasks between checks (timers are not advanced). Throws when it never does.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return;
        await Promise.resolve();
        await Promise.resolve();
    }
    throw new Error(`waitFor timed out: ${label}`);
}

const SECOND_ALBUM = { ...UNAVAILABLE_ALBUM, id: 'unavail-2', albumMbid: 'mbid-bbb', albumTitle: 'Windowlicker' };
const SECOND_JOB = { ...RETRY_JOB, id: 'job-2', targetMbid: 'mbid-bbb' };

/** Wire every query the handler runs BEFORE its res.json, plus the transaction. */
function primeHandlerPreResponse({ twoAlbums = false } = {}) {
    (prisma.discoveryBatch.findFirst as jest.Mock)
        // the latest completed batch, tagged the prior week
        .mockResolvedValueOnce({ weekStart: new Date('2026-05-18T00:00:00.000Z') })
        // the active-batch guard: none in progress
        .mockResolvedValueOnce(null);

    (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue(
        twoAlbums ? [UNAVAILABLE_ALBUM, SECOND_ALBUM] : [UNAVAILABLE_ALBUM],
    );
    // No discovery or library matches, so the album survives filtering.
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

    it('catches a rejected checkBatchCompletion and marks the batch failed', async () => {
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockRejectedValue(new Error('reconcile exploded'));

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200); // response already sent before background work

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

    it('never sets the batch completed itself, since checkBatchCompletion owns that', async () => {
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked',
        );

        const completedSelfWrites = (prisma.discoveryBatch.update as jest.Mock).mock.calls.filter(
            (c) => c[0]?.data?.status === 'completed',
        );
        expect(completedSelfWrites).toHaveLength(0);
    });

    it('never enqueues a scan with the discover-retry-unavailable source', async () => {
        // The scan processor only builds the playlist for the discover-weekly-completion source,
        // which checkBatchCompletion queues itself.
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked',
        );

        const retrySourceScans = (scanQueue.add as jest.Mock).mock.calls.filter(
            (c) => c[1]?.source === 'discover-retry-unavailable',
        );
        expect(retrySourceScans).toHaveLength(0);
    });

    it('still hands off to checkBatchCompletion when one album fails to acquire', async () => {
        // A failed acquire must not short-circuit into a self-completed batch.
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

        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
        const completedSelfWrites = (prisma.discoveryBatch.update as jest.Mock).mock.calls.filter(
            (c) => c[0]?.data?.status === 'completed',
        );
        expect(completedSelfWrites).toHaveLength(0);
    });

    it('hands the batch to checkBatchCompletion after the acquisitions', async () => {
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

        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
        expect(mockAcquireAlbum).toHaveBeenCalledTimes(1);
    });

    it('writes the completed and failed tally to the batch before handing off', async () => {
        // One success and one failure: completedAlbums 1, failedAlbums 1.
        primeHandlerPreResponse({ twoAlbums: true });

        // Record the order of every batch update and the handoff.
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

        const persistedFinalTally = (prisma.discoveryBatch.update as jest.Mock).mock.calls.some(
            (c) => c[0]?.data?.completedAlbums === 1 && c[0]?.data?.failedAlbums === 1,
        );
        expect(persistedFinalTally).toBe(true);

        // checkBatchCompletion would read stale counts if the tally landed after it.
        const handoffIdx = events.indexOf('handoff');
        const finalTallyIdx = events.indexOf('count:1/1');
        expect(finalTallyIdx).toBeGreaterThanOrEqual(0);
        expect(finalTallyIdx).toBeLessThanOrEqual(handoffIdx);
    });

    it('acquires the albums before handing the batch off', async () => {
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

        expect(order[0]).toBe('acquire');
        expect(order.indexOf('acquire')).toBeLessThan(order.indexOf('handoff'));
    });

    it('marks the batch failed when a failure comes before the handoff', async () => {
        primeHandlerPreResponse();
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        // The per-job count update swallows its errors; the count update after the loop (no status
        // field) is awaited unguarded. Reject that one and let the status "failed" write succeed.
        (prisma.discoveryBatch.update as jest.Mock).mockImplementation(async (arg: any) => {
            const d = arg?.data ?? {};
            if (d.status === undefined && (d.completedAlbums !== undefined || d.failedAlbums !== undefined)) {
                throw new Error('count persist exploded');
            }
            return {};
        });

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        // The outer catch writes the failed shape, and the handoff never runs.
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

    it('hands the batch off once, not once per album', async () => {
        primeHandlerPreResponse({ twoAlbums: true });
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await request(app).post('/discover/retry-unavailable');
        expect(res.status).toBe(200);

        await waitFor(
            () => mockCheckBatchCompletion.mock.calls.length > 0,
            'checkBatchCompletion invoked',
        );
        // Give an extra handoff a chance to fire before asserting there was one.
        await waitFor(() => mockAcquireAlbum.mock.calls.length === 2, 'both albums acquired');
        await Promise.resolve();
        await Promise.resolve();

        expect(mockCheckBatchCompletion).toHaveBeenCalledTimes(1);
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(RETRY_BATCH_ID);
    });

    it('does not queue again an album a download is already working on', async () => {
        primeHandlerPreResponse();
        (prisma.downloadJob.findMany as jest.Mock).mockReset().mockResolvedValueOnce([{ targetMbid: UNAVAILABLE_ALBUM.albumMbid }]);

        const res = await request(app).post('/discover/retry-unavailable');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, queued: 0, message: 'The unavailable albums are already downloading' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(mockAcquireAlbum).not.toHaveBeenCalled();
    });
});
