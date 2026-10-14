/**
 * GET /library/removals — admin-only paginated view of what the reconcile sweep
 * retired, so demo ops never needs psql to answer "what vanished".
 */

jest.mock('../../../middleware/auth', () => ({
    requireAdmin: jest.fn((req: any, _res: any, next: any) => {
        req.user = { id: 'admin', username: 'admin', role: 'admin' };
        next();
    }),
}));

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config', () => ({ config: { music: { transcodeCachePath: '/tmp/cache' } } }));
jest.mock('../../../workers/queues', () => ({ scanQueue: {} }));
jest.mock('../../../workers/scanRequest', () => ({ requestScan: jest.fn() }));
jest.mock('../../../workers/organizeSingles', () => ({ organizeSingles: jest.fn() }));

const mockFindMany = jest.fn();
const mockCount = jest.fn();
jest.mock('../../../utils/db', () => ({
    prisma: {
        removalLog: { findMany: mockFindMany, count: mockCount },
    },
}));

import express from 'express';
import request from 'supertest';
import router from '../scan';
import { requireAdmin } from '../../../middleware/auth';

function makeApp() {
    const app = express();
    app.use('/library', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    (requireAdmin as jest.Mock).mockImplementation((req: any, _res: any, next: any) => {
        req.user = { id: 'admin', username: 'admin', role: 'admin' };
        next();
    });
});

const row = {
    id: 'rl1', filePath: '/music/a/b.flac', title: 'B', artistName: 'A',
    albumTitle: 'Alb', reason: 'file-missing-confirmed',
    artifacts: [{ table: 'TranscodedFile', path: '/tmp/cache/x.mp3' }],
    removedAt: new Date('2026-10-14T00:00:00Z'),
};

it('returns paginated removal rows with a count', async () => {
    mockCount.mockResolvedValue(1);
    mockFindMany.mockResolvedValue([row]);
    const res = await request(makeApp()).get('/library/removals?limit=1&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.removals[0]).toMatchObject({
        filePath: '/music/a/b.flac', artistName: 'A', reason: 'file-missing-confirmed',
    });
    expect(res.body.removals[0].artifacts).toEqual([{ table: 'TranscodedFile', path: '/tmp/cache/x.mp3' }]);
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 1 });
});

it('clamps a bogus limit to the default', async () => {
    mockCount.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/library/removals?limit=abc');
    expect(res.status).toBe(200);
    expect(mockFindMany.mock.calls[0][0].take).toBeGreaterThan(0);
});

it('is admin-gated', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((_req: any, res: any) => res.status(403).json({ error: 'forbidden' }));
    const res = await request(makeApp()).get('/library/removals');
    expect(res.status).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
});
