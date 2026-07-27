/**
 * Task 3 adversarial route tests -- bounded defensive GET /discover/current and
 * GET /discover/batch-status terminal-state reporting.
 *
 * Doctrine: failure / edge / boundary paths FIRST, happy path LAST.
 *
 * The confirmed production defect: ACTIVE DiscoveryAlbum rows get tagged with a
 * PRIOR week (the Sunday off-by-one). GET /current queries
 * `weekStartDate = thisCalendarMonday` EXACTLY, so it returns zero rows and the
 * playlist is invisible. Task 3 makes /current resolve the display week against
 * the latest COMPLETED DiscoveryBatch (bounded, with a `stale` flag) so those
 * orphaned rows become visible, and makes /batch-status surface the latest
 * terminal batch (lastBatchId/lastBatchStatus) so a client that missed the SSE
 * completion can detect it.
 *
 * These tests target the SPECIFIC discriminators introduced by Task 3:
 *   - /current must query DiscoveryAlbum at the BATCH's older week, not the empty
 *     calendar week (data-loss path), and echo that week back as `weekStart`.
 *   - /current must include a `stale` boolean (true for an older batch).
 *   - /batch-status's no-active branch must return `lastBatchId` /
 *     `lastBatchStatus` sourced from a TERMINAL-only ({completed,failed}) lookup.
 *
 * Each assertion picks a value that can ONLY be produced by the Task-3 code
 * path, so the test cannot pass via the existing unmodified handler.
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

// Pin the wall clock. /current computes its calendar week from real `new Date()`
// (discover.ts:330), so without this the hardcoded CALENDAR_MONDAY='2026-05-25'
// / BATCH_MONDAY='2026-05-18' fixtures only line up on weeks where
// startOfWeek(now) === 2026-05-25. Setting the clock to noon on that Monday makes
// every same-week / older / future boundary deterministic regardless of when CI
// runs. Timestamp-based DB writes are all mocked, so freezing time is safe here.
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

// The production scenario: "today" is the calendar week of Mon 2026-05-25, but
// the only ACTIVE albums + the latest completed batch are tagged the PRIOR week
// (Mon 2026-05-18). The unmodified handler queries the 05-25 week -> 0 rows.
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

describe('GET /discover/current -- bounded latest-completed-batch fallback (Task 3)', () => {
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
        // The bug: ACTIVE albums tagged 05-18, calendar week is 05-25. The
        // latest completed batch is also tagged 05-18, so Task 3 must resolve
        // the display week to 05-18 and surface the orphaned rows.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockResolvedValue({
            weekStart: new Date(BATCH_MONDAY_ISO),
        });
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([ACTIVE_ALBUM]);

        const res = await request(app).get('/discover/current');

        expect(res.status).toBe(200);

        // DISCRIMINATOR: the DiscoveryAlbum query must use the BATCH's week
        // (05-18), never the calendar Monday (05-25). The unmodified handler
        // uses the calendar Monday and returns zero rows.
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
        // DISCRIMINATOR: `stale` is a Task-3-only field. The unmodified handler
        // never emits it (=> undefined). It must be true for a week older than
        // the current calendar week.
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

        // DISCRIMINATOR: Task 3 introduces this lookup; the unmodified handler
        // never queries discoveryBatch from /current at all. Assert it ran
        // before indexing the call args so the failure reads as "fallback
        // lookup missing" rather than an undefined-index TypeError.
        expect((prisma.discoveryBatch.findFirst as jest.Mock).mock.calls.length).toBeGreaterThan(0);
        const batchQuery = (prisma.discoveryBatch.findFirst as jest.Mock).mock.calls[0][0];
        expect(batchQuery.where).toEqual(
            expect.objectContaining({ userId: 'user-123', status: 'completed' }),
        );
    });

    it('LATEST-BATCH ORDERING: the completed-batch lookup is ordered newest-first (createdAt desc)', async () => {
        // GAP CLOSED: every other test mocks a single batch, so an impl that
        // ordered ASC (oldest) or omitted orderBy would still pass them while,
        // against a real multi-week DB, resolving the display week to an OLD
        // batch -- re-opening the exact data-loss bug Task 3 fixes (a stale
        // week wins over the genuine latest). The latest completed batch is the
        // one whose week albums still exist (cleanup protects only the newest),
        // so the lookup MUST take the most recent.
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
        // GAP CLOSED: the handler keeps two more week-derived values besides the
        // DiscoveryAlbum query -- weekEnd (in the response) and the
        // unavailableAlbum lookup. An impl that wires resolveViewWeek into only
        // the DiscoveryAlbum query leaves weekEnd at the calendar Sunday and the
        // unavailable query at the calendar Monday, producing an incoherent
        // 05-18..05-31 range and unavailables from the wrong week. Both must
        // track the resolved (05-18) week.
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
        // GAP CLOSED: the route never exercises a future-dated batch. An impl
        // using `stale = !isSameDay(batchWeek, calendarWeek)` (instead of
        // `isBefore`) passes the older (true) and same-week (false) cases but
        // wrongly flags a batch generated early for the UPCOMING week as stale.
        // Per the helper contract a future week is fresh.
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

describe('GET /discover/batch-status -- latest terminal batch on the no-active branch (Task 3)', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        // mockReset (not clearAllMocks) so any unconsumed mockResolvedValueOnce
        // from a prior test does not bleed into this one's call ordering.
        (prisma.discoveryBatch.findFirst as jest.Mock).mockReset();
    });

    it('NO-ACTIVE + TERMINAL EXISTS: returns lastBatchId/lastBatchStatus from a terminal-only lookup', async () => {
        // First findFirst -> active batch lookup (none). Second findFirst ->
        // the Task-3 terminal lookup.
        (prisma.discoveryBatch.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'batch-done-1', status: 'completed' });

        const res = await request(app).get('/discover/batch-status');

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        // DISCRIMINATOR: these two fields exist ONLY after Task 3. The
        // unmodified no-active branch returns {active,status,progress} only.
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
        // GAP CLOSED: the existing terminal test asserts only where.status. An
        // impl that (a) omits userId would surface ANOTHER user's finished batch
        // to this client, and (b) one that omitted/inverted the order would
        // report a stale (older) terminal batch as "the latest completion,"
        // defeating the missed-SSE recovery this field exists for. Both the
        // user scope and the completedAt-desc ordering must hold.
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
        // GAP CLOSED: nothing pins WHICH statuses count as "active." An impl
        // that widened the active query to include completed/failed would report
        // a finished batch as active:true forever (UI spins). The active lookup
        // must match only in-flight statuses; completed/failed belong to the
        // terminal branch. Assert the first (active) lookup excludes terminals.
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
