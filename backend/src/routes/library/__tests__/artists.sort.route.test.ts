/**
 * Artist list ordering.
 *
 * `GET /artists` had no coverage, which is how the defect this pins survived:
 * `sortBy=name` and `name-desc` -- the alphabetical path, and the default --
 * do NOT use `ARTIST_SORT_MAP`. They take a raw-SQL branch that computed its
 * own order with `REGEXP_REPLACE(TRIM(a.name), '^the\s+', ...)`, stripping one
 * English article where the rest of the system strips eleven across four
 * languages, and skipping the unaccent that `sortName` carries. Changing the
 * Prisma sort map alone left that path untouched.
 *
 * These assert the SQL TEXT, which is what they can honestly prove: that the
 * query orders on the canonical stored column rather than recomputing a weaker
 * key inline. That the column then sorts correctly in Postgres is a separate
 * fact, verified directly against the database rather than here.
 */

jest.mock('p-limit', () => () => (fn: (...args: any[]) => any) => fn());

jest.mock('../../../middleware/auth', () => ({
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'admin', username: 'admin', role: 'admin' };
        next();
    },
}));

const mockQueryRaw = jest.fn();

jest.mock('../../../utils/db', () => {
    const actualPrisma = {
        artist: { findMany: jest.fn(), count: jest.fn() },
        $queryRaw: (...args: any[]) => mockQueryRaw(...args),
        $transaction: (fn: any) => fn(actualPrisma),
    };
    return {
        prisma: actualPrisma,
        Prisma: {
            SortOrder: { asc: 'asc', desc: 'desc' },
            sql: (strings: TemplateStringsArray, ...vals: any[]) => ({ strings, vals }),
            empty: { strings: [''], vals: [] },
            join: (parts: any[]) => ({ parts }),
        },
    };
});

jest.mock('../../../utils/redis', () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn(), del: jest.fn() },
}));

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../services/lastfm', () => ({ lastFmService: {} }));
jest.mock('../../../services/deezer', () => ({ deezerService: {} }));
jest.mock('../../../services/musicbrainz', () => ({ musicBrainzService: {} }));
jest.mock('../../../services/dataCache', () => ({
    dataCacheService: {
        get: jest.fn(),
        set: jest.fn(),
        getArtistImagesBatch: jest.fn().mockResolvedValue(new Map()),
    },
}));
jest.mock('../../../services/artistCountsService', () => ({
    backfillAllArtistCounts: jest.fn(),
    isBackfillNeeded: jest.fn().mockResolvedValue(false),
    getBackfillProgress: jest.fn(),
    isBackfillInProgress: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../utils/metadataOverrides', () => ({
    getMergedGenres: jest.fn(() => []),
    getArtistDisplaySummary: jest.fn(() => null),
}));
jest.mock('../../../utils/errors', () => ({
    safeError: jest.fn((res: any) => res.status(500).json({ error: 'Internal server error' })),
}));

import express from 'express';
import request from 'supertest';
import artistRoutes from '../artists';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', artistRoutes);
    return app;
}

function sqlOf(call: any[]): string {
    const strings = call?.[0];
    return Array.isArray(strings) ? strings.join(' ? ') : String(strings ?? '');
}

/**
 * The SELECT that fetches the rows, not the COUNT that paginates them. The
 * handler issues both inside one transaction, and only the first carries an
 * ORDER BY, so "the last call" would assert against the wrong statement.
 */
function orderingSql(): string {
    const call = mockQueryRaw.mock.calls.find((c) => sqlOf(c).includes('ORDER BY'));
    return call ? sqlOf(call) : '';
}

/**
 * Just the ORDER BY clause. Asserting that `"sortName"` appears ANYWHERE in
 * the statement would also pass if the column were merely selected while the
 * ordering used something else entirely -- a weaker claim than the one being
 * made.
 */
function orderByClause(): string {
    const sql = orderingSql();
    const from = sql.indexOf('ORDER BY');
    if (from === -1) return '';
    const rest = sql.slice(from);
    const limit = rest.indexOf('LIMIT');
    return limit === -1 ? rest : rest.slice(0, limit);
}

/**
 * The sort direction is an interpolated `Prisma.sql` value, not literal
 * template text, so it lands in the call's VALUES rather than its strings and
 * is invisible to `orderingSql()`.
 */
function interpolatedText(): string {
    const call = mockQueryRaw.mock.calls.find((c) => sqlOf(c).includes('ORDER BY')) ?? [];
    return call
        .slice(1)
        .map((v: any) => (Array.isArray(v?.strings) ? v.strings.join('') : String(v ?? '')))
        .join(' ');
}

beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRaw.mockImplementation((...args: any[]) => {
        const sql = sqlOf(args);
        // The count query's caller reads `rows[0].total`, so an empty array
        // throws before any assertion runs.
        if (/COUNT\(/i.test(sql)) return Promise.resolve([{ total: BigInt(0) }]);
        return Promise.resolve([]);
    });
});

describe('GET /artists alphabetical ordering', () => {
    it.each(['name', 'name-desc'])('orders %s on the stored sortName column', async (sortBy) => {
        await request(makeApp()).get(`/artists?sortBy=${sortBy}`).expect(200);

        expect(orderByClause()).toContain('"sortName"');
    });

    // Direction and column are separate claims: pinning only the column would
    // pass even if `name-desc` silently ordered ascending.
    it('sends DESC for name-desc', async () => {
        await request(makeApp()).get('/artists?sortBy=name-desc').expect(200);
        expect(interpolatedText()).toContain('DESC');
    });

    it('sends ASC, and only ASC, for name', async () => {
        await request(makeApp()).get('/artists?sortBy=name').expect(200);
        const asc = interpolatedText();
        expect(asc).toContain('ASC');
        expect(asc).not.toContain('DESC');
    });

    it('does not recompute an article-stripped key inline', async () => {
        await request(makeApp()).get("/artists?sortBy=name").expect(200);

        const sql = orderingSql();
        // The specific shape that made this path disagree with every other
        // sort in the system.
        expect(sql).not.toContain('REGEXP_REPLACE');
        expect(sql.toLowerCase()).not.toContain("'^the");
    });
});
