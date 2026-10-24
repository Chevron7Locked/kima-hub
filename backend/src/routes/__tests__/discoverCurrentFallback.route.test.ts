/**
 * GET /discover/current shows the latest completed batch's week, with a `stale`
 * flag when it is older than this week. GET /discover/batch-status reports the
 * latest finished batch (lastBatchId, lastBatchStatus) for a client that missed
 * the SSE. Failure and edge paths first.
 */

// All mocks before imports.

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

// Module-load-time imports in discover.ts that we do not exercise here.
jest.mock('../../workers/queues', () => ({
    discoverQueue: { getJob: jest.fn(), add: jest.fn() },
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

describe('GET /discover/current -- bounded latest-completed-batch fallback', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.discoveryBatch.findFirst as jest.Mock).mockReset();
        // Default benign returns for the secondary queries the handler runs.
        (prisma.unavailableAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([LIBRARY_TRACK]);
    });

    it('DATA-LOSS PATH: queries DiscoveryAlbum at the older batch week, not the empty calendar week', async () => {
        // ACTIVE albums are tagged 05-18 and the calendar week is 05-25. The
        // latest completed batch is also tagged 05-18, so the display week must
        // resolve to 05-18 and surface the orphaned rows.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([ACTIVE_ALBUM]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);

        // The DiscoveryAlbum query uses the batch's week (05-18), not the
        // calendar Monday (05-25), which would return zero rows.
        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        const queriedWeek: Date = albumQuery.where.weekStartDate;
        expect(queriedWeek.toISOString().slice(0, 10)).toBe('2026-05-18');
        expect(queriedWeek.toISOString().slice(0, 10)).not.toBe(CALENDAR_MONDAY);

        // And the orphaned album's track is now actually served.
        expect(res.body.tracks.length).toBeGreaterThan(0);
        expect(res.body.weekStart).toBe(BATCH_MONDAY_ISO);
    });

    it('STALE FLAG: an older completed batch is served with stale=true', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([ACTIVE_ALBUM]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        // `stale` is true for a week older than the current calendar week.
        expect(res.body.stale).toBe(true);
    });

    it('NULL PATH: no completed batch -> falls back to the calendar week, not stale', async () => {
        // resolveViewWeek(calendar, null) must return the calendar week, fresh.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        const queriedWeek: Date = albumQuery.where.weekStartDate;
        // With no batch, the display week is the current calendar Monday.
        expect(queriedWeek.toISOString().slice(0, 10)).toBe(CALENDAR_MONDAY);
        expect(res.body.stale).toBe(false);
    });

    it('CONCURRENT-WRITER SCOPE: the batch lookup is restricted to status=completed', async () => {
        // A scanning/failed batch must never drive the /current display week --
        // only a completed one. Assert the findFirst where-clause is so scoped,
        // so an in-flight batch cannot leak its (possibly future) week here.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

        await request(app).get('/discover/current');

        // Assert the lookup ran before indexing its call args, so a missing
        // lookup fails as that rather than as an undefined-index TypeError.
        expect((prisma.discoveryBatch.findFirst as jest.Mock).mock.calls.length).toBeGreaterThan(0);
        const batchQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[0][0];
        expect(batchQuery.where).toEqual(
            expect.objectContaining({ userId: 'user-123', status: 'completed' }),
        );
    });

    it('LATEST-BATCH ORDERING: the completed-batch lookup is ordered newest-first (createdAt desc)', async () => {
        // The latest completed batch wins, not an older one.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

        await request(app).get('/discover/current');

        // Guard before indexing so a missing fallback lookup reads as "lookup
        // absent" rather than an undefined-index TypeError.
        expect((prisma.discoveryBatch.findFirst as jest.Mock).mock.calls.length).toBeGreaterThan(0);
        const batchQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[0][0];
        // orderBy may be an object or an array; normalize then assert desc on createdAt.
        const orderBy = Array.isArray(batchQuery.orderBy)
            ? batchQuery.orderBy
            : [batchQuery.orderBy];
        expect(orderBy).toContainEqual(
            expect.objectContaining({ createdAt: 'desc' }),
        );
    });

    it('WEEK COHERENCE: weekEnd and the unavailable-albums query use the RESOLVED week, not the calendar week', async () => {
        // weekEnd and the unavailable-albums lookup follow the resolved week too.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([ACTIVE_ALBUM]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);
        // weekEnd must be the Sunday of the RESOLVED week (05-18 -> 05-24),
        // never the calendar week's Sunday (05-25 -> 05-31).
        expect(new Date(res.body.weekEnd).toISOString().slice(0, 10)).toBe('2026-05-24');
        // The unavailable-albums lookup must be scoped to the resolved Monday.
        const unavailQuery = (prisma.unavailableAlbum.findMany as jest.Mock).mock.calls[0][0];
        const unavailWeek: Date = unavailQuery.where.weekStartDate;
        expect(unavailWeek.toISOString().slice(0, 10)).toBe('2026-05-18');
        expect(unavailWeek.toISOString().slice(0, 10)).not.toBe(CALENDAR_MONDAY);
    });

    it('FUTURE-BATCH FRESH: an early-generated upcoming-week batch is served NOT stale', async () => {
        // A batch for the upcoming week is fresh, not stale.
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
        // And the display week is the future batch week, echoed back.
        expect(res.body.weekStart).toBe(futureMondayIso);
        const albumQuery = (prisma.discoveryAlbum.findMany as jest.Mock).mock.calls[0][0];
        expect(albumQuery.where.weekStartDate.toISOString().slice(0, 10)).toBe('2026-06-01');
    });

    // The server's time zone changed since the batch was made: its stored week
    // start is midnight Monday in Tokyo, 15:00 on Sunday here (UTC). It is still
    // this week's batch, shown as this week, and its albums are still found by
    // the instant they were stored under.
    it('ZONE CHANGE: a batch made at another zone\'s midnight counts as its own week, keyed by its stored instant', async () => {
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

    it('HAPPY PATH: batch matches the calendar week -> served, not stale', async () => {
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

describe('GET /discover/batch-status -- latest terminal batch on the no-active branch', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        // mockReset (not clearAllMocks) so any unconsumed mockResolvedValueOnce
        // from a prior test does not bleed into this one's call ordering.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockReset();
    });

    it('NO-ACTIVE + TERMINAL EXISTS: returns lastBatchId/lastBatchStatus from a terminal-only lookup', async () => {
        // First findFirst -> active batch lookup (none). Second findFirst ->
        // the terminal lookup.
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'batch-done-1', status: 'completed' });

        const res = await request(app).get('/discover/batch-status');

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        // The no-active branch also reports the latest finished batch.
        expect(res.body.lastBatchId).toBe('batch-done-1');
        expect(res.body.lastBatchStatus).toBe('completed');

        // BOUNDARY: the terminal lookup must be scoped to {completed,failed}
        // (a cancelled/scanning batch must not count as a finished week).
        const terminalQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[1][0];
        expect(terminalQuery.where.status).toEqual({ in: ['completed', 'failed'] });
    });

    it('NO-ACTIVE + NO TERMINAL: lastBatchId/lastBatchStatus are null, not undefined/missing', async () => {
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        const res = await request(app).get('/discover/batch-status');

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        // Must be present-and-null (a missed-completion client distinguishes
        // "no terminal yet" from "field absent / old server").
        expect(res.body).toHaveProperty('lastBatchId', null);
        expect(res.body).toHaveProperty('lastBatchStatus', null);
    });

    it('TERMINAL LOOKUP SCOPE+ORDER: scoped to this user and ordered most-recently-completed first', async () => {
        // The finished-batch lookup is scoped to the user and takes the newest.
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

    it('ACTIVE-SCOPE: the active-batch lookup only counts in-flight statuses, never a terminal one', async () => {
        // The active lookup matches only in-flight statuses.
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        await request(app).get('/discover/batch-status');

        const activeQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[0][0];
        const inClause = activeQuery.where.status?.in ?? [];
        expect(inClause).not.toContain('completed');
        expect(inClause).not.toContain('failed');
        // And it must actually constrain to in-flight work (non-empty filter).
        expect(inClause.length).toBeGreaterThan(0);
    });

    it('HAPPY PATH (active batch): terminal lookup is not consulted, progress reported', async () => {
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
        // Only the active lookup ran; the terminal lookup must be skipped.
        expect((prisma.discoveryBatch.findFirst as jest.Mock).mock.calls.length).toBe(1);
    });
});
