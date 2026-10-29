/**
 * GET /discover/current shows the latest completed batch's week, with a `stale`
 * flag when it is older than this week. GET /discover/batch-status reports the
 * latest finished batch (lastBatchId, lastBatchStatus) for a client that missed
 * the SSE.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        discoveryBatch: {
            findFirst: jest.fn(),
        },
        discoveryAlbum: {
            findMany: jest.fn(),
        },
        unavailableAlbum: {
            findMany: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
        },
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

import express from 'express';
import request from 'supertest';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';
import { redisClient } from '../../utils/redis';
import { closeClient } from '../../utils/closeRedisClient';

// /current computes its week from the clock, so pin it to noon on the fixture
// Monday.
beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
});
afterAll(async () => {
    jest.useRealTimers();
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

// "Today" is in the week of Mon 2026-05-25, but the active albums and latest
// completed batch belong to the prior week (Mon 2026-05-18).
const CALENDAR_MONDAY = '2026-05-25';
const BATCH_MONDAY_ISO = '2026-05-18T00:00:00.000Z';

const ACTIVE_ALBUM = {
    id: 'da-1',
    rgMbid: 'rg-mbid-1',
    artistName: 'Boards of Canada',
    albumTitle: 'Geogaddi',
    status: 'ACTIVE',
    likedAt: null,
    similarity: 0.9,
    tier: 'core',
    downloadedAt: new Date(BATCH_MONDAY_ISO),
    weekStartDate: new Date(BATCH_MONDAY_ISO),
    tracks: [{ trackId: 'track-1' }],
};

const LIBRARY_TRACK = {
    id: 'track-1',
    title: 'Music Is Math',
    duration: 320,
    album: { id: 'alb-1', coverUrl: '/c/geo.jpg', artist: { name: 'Boards of Canada' } },
};

describe('GET /discover/current -- shows the latest completed batch', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.discoveryBatch.findFirst as jest.Mock).mockReset();
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([LIBRARY_TRACK]);
    });

    it('queries the albums at the older batch week, not the empty calendar week', async () => {
        // The active albums and the latest completed batch are tagged 05-18; the calendar week is 05-25.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([ACTIVE_ALBUM]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);

        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        const queriedWeek: Date = albumQuery.where.weekStartDate;
        expect(queriedWeek.toISOString().slice(0, 10)).toBe('2026-05-18');
        expect(queriedWeek.toISOString().slice(0, 10)).not.toBe(CALENDAR_MONDAY);

        expect(res.body.tracks.length).toBeGreaterThan(0);
        expect(res.body.weekStart).toBe(BATCH_MONDAY_ISO);
    });

    it('serves an older completed batch with stale set', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([ACTIVE_ALBUM]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(true);
    });

    it('falls back to the calendar week, not stale, when no batch has completed', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        const queriedWeek: Date = albumQuery.where.weekStartDate;
        expect(queriedWeek.toISOString().slice(0, 10)).toBe(CALENDAR_MONDAY);
        expect(res.body.stale).toBe(false);
    });

    it('looks up only completed batches', async () => {
        // An in-flight or failed batch must not decide the week /current shows.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

        await request(app).get('/discover/current');

        expect((prisma.discoveryBatch.findFirst as jest.Mock).mock.calls.length).toBeGreaterThan(0);
        const batchQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[0][0];
        expect(batchQuery.where).toEqual(
            expect.objectContaining({ userId: 'user-123', status: 'completed' }),
        );
    });

    it('orders the completed-batch lookup newest first', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

        await request(app).get('/discover/current');

        expect((prisma.discoveryBatch.findFirst as jest.Mock).mock.calls.length).toBeGreaterThan(0);
        const batchQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[0][0];
        const orderBy = Array.isArray(batchQuery.orderBy)
            ? batchQuery.orderBy
            : [batchQuery.orderBy];
        expect(orderBy).toContainEqual(
            expect.objectContaining({ createdAt: 'desc' }),
        );
    });

    it('ends the week and scopes the unavailable albums to the resolved week, not the calendar week', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([ACTIVE_ALBUM]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        // The Sunday of the resolved week (05-18 -> 05-24), not the calendar week's (05-31).
        expect(new Date(res.body.weekEnd).toISOString().slice(0, 10)).toBe('2026-05-24');
        const unavailQuery = (prisma.unavailableAlbum.findMany as jest.Mock).mock.calls[0][0];
        const unavailWeek: Date = unavailQuery.where.weekStartDate;
        expect(unavailWeek.toISOString().slice(0, 10)).toBe('2026-05-18');
        expect(unavailWeek.toISOString().slice(0, 10)).not.toBe(CALENDAR_MONDAY);
    });

    it('serves a batch generated early for the upcoming week as not stale', async () => {
        const futureMondayIso = '2026-06-01T00:00:00.000Z'; // next week
        const futureMonday = new Date(futureMondayIso);
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: futureMonday,
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
            { ...ACTIVE_ALBUM, weekStartDate: futureMonday, downloadedAt: futureMonday },
        ]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(false);
        expect(res.body.weekStart).toBe(futureMondayIso);
        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        expect(albumQuery.where.weekStartDate.toISOString().slice(0, 10)).toBe('2026-06-01');
    });

    // The batch's stored week start is midnight Monday in Tokyo, 15:00 on Sunday in UTC. It is
    // still this week's batch, and its albums are found by the instant they were stored under.
    it('counts a batch made at another time zone\'s midnight as its own week, keyed by its stored instant', async () => {
        const tokyoMonday = new Date('2026-05-24T15:00:00.000Z');
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({ weekStart: tokyoMonday });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
            { ...ACTIVE_ALBUM, weekStartDate: tokyoMonday, downloadedAt: tokyoMonday },
        ]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(false);
        expect(res.body.weekStart).toBe(`${CALENDAR_MONDAY}T00:00:00.000Z`);
        expect(res.body.weekEnd).toBe('2026-05-31T23:59:59.999Z');
        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        expect(albumQuery.where.weekStartDate.getTime()).toBe(tokyoMonday.getTime());
        const unavailQuery = (prisma.unavailableAlbum.findMany as jest.Mock).mock.calls[0][0];
        expect(unavailQuery.where.weekStartDate.getTime()).toBe(tokyoMonday.getTime());
    });

    it('serves a batch that matches the calendar week as not stale', async () => {
        const sameWeek = new Date(`${CALENDAR_MONDAY}T00:00:00.000Z`);
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({ weekStart: sameWeek });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
            { ...ACTIVE_ALBUM, weekStartDate: sameWeek, downloadedAt: sameWeek },
        ]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(false);
        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        expect(albumQuery.where.weekStartDate.toISOString().slice(0, 10)).toBe(CALENDAR_MONDAY);
        expect(res.body.tracks.length).toBeGreaterThan(0);
    });
});

describe('GET /discover/batch-status -- reports the latest finished batch when none is active', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        // mockReset drops queued once-values, so one test's leftovers cannot shift the next one's calls.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockReset();
    });

    it('returns lastBatchId and lastBatchStatus from a finished-batch lookup', async () => {
        // The first findFirst is the active-batch lookup (none), the second the finished-batch lookup.
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'batch-done-1', status: 'completed' });

        const res = await request(app).get('/discover/batch-status');

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        expect(res.body.lastBatchId).toBe('batch-done-1');
        expect(res.body.lastBatchStatus).toBe('completed');

        // A scanning batch does not count as finished.
        const terminalQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[1][0];
        expect(terminalQuery.where.status).toEqual({ in: ['completed', 'failed'] });
    });

    it('returns null, not a missing field, for lastBatchId and lastBatchStatus when nothing has finished', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        const res = await request(app).get('/discover/batch-status');

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        // A client tells "nothing finished yet" from "field absent" by null versus missing.
        expect(res.body).toHaveProperty('lastBatchId', null);
        expect(res.body).toHaveProperty('lastBatchStatus', null);
    });

    it('scopes the finished-batch lookup to the user and takes the most recently completed', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'batch-done-2', status: 'failed' });

        const res = await request(app).get('/discover/batch-status');

        expect(res.status).toBe(200);
        expect(res.body.lastBatchId).toBe('batch-done-2');

        const terminalQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[1][0];
        expect(terminalQuery.where).toEqual(
            expect.objectContaining({ userId: 'user-123' }),
        );
        const orderBy = Array.isArray(terminalQuery.orderBy)
            ? terminalQuery.orderBy
            : [terminalQuery.orderBy];
        expect(orderBy).toContainEqual(
            expect.objectContaining({ completedAt: 'desc' }),
        );
    });

    it('counts only in-flight statuses in the active-batch lookup', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        await request(app).get('/discover/batch-status');

        const activeQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[0][0];
        const inClause = activeQuery.where.status?.in ?? [];
        expect(inClause).not.toContain('completed');
        expect(inClause).not.toContain('failed');
        expect(inClause.length).toBeGreaterThan(0);
    });

    it('reports progress without consulting the finished-batch lookup when a batch is active', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValueOnce({
            id: 'batch-active-1',
            status: 'scanning',
            jobs: [
                { status: 'completed' },
                { status: 'completed' },
                { status: 'pending' },
                { status: 'failed' },
            ],
        });

        const res = await request(app).get('/discover/batch-status');

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(true);
        expect(res.body.batchId).toBe('batch-active-1');
        // 2 completed + 1 failed of 4 -> 75%.
        expect(res.body.progress).toBe(75);
        expect((prisma.discoveryBatch.findFirst as jest.Mock).mock.calls.length).toBe(1);
    });
});
