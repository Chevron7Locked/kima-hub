/**
 * GET /library/removals: an admin-only page of what the reconcile sweep retired, newest first, so demo ops never
 * needs psql to answer "what vanished". Real database; only the admin check is stood in for.
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
jest.mock('../../../workers/queues', () => ({ scanQueue: {} }));
jest.mock('../../../workers/scanRequest', () => ({ requestScan: jest.fn() }));
jest.mock('../../../workers/organizeSingles', () => ({ organizeSingles: jest.fn() }));

import express from 'express';
import request from 'supertest';
import router from '../scan';
import { requireAdmin } from '../../../middleware/auth';
import { prisma } from '../../../utils/db';

function makeApp() {
    const app = express();
    app.use('/library', router);
    return app;
}

const removed = (n: number) => ({
    filePath: `/music/rl/${n}.flac`, title: `Song ${n}`, artistName: 'A', albumTitle: 'Alb',
    reason: 'file-missing-confirmed', artifacts: [{ table: 'TranscodedFile', path: `/tmp/cache/${n}.mp3` }],
    removedAt: new Date(`2026-10-0${n}T00:00:00Z`),
});
const titles = (body: { removals: Array<{ title: string }> }) => body.removals.map((r) => r.title);

beforeAll(async () => {
    await prisma.removalLog.deleteMany({});
    await prisma.removalLog.createMany({ data: [removed(1), removed(3), removed(2)] });
});

afterAll(async () => {
    await prisma.removalLog.deleteMany({});
    await prisma.$disconnect();
});

beforeEach(() => {
    (requireAdmin as jest.Mock).mockImplementation((req: any, _res: any, next: any) => {
        req.user = { id: 'admin', username: 'admin', role: 'admin' };
        next();
    });
});

it('lists every removal newest first, with the count and what was cleaned up', async () => {
    const res = await request(makeApp()).get('/library/removals');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(titles(res.body)).toEqual(['Song 3', 'Song 2', 'Song 1']);
    expect(res.body.removals[0]).toMatchObject({ filePath: '/music/rl/3.flac', artistName: 'A', reason: 'file-missing-confirmed' });
    expect(res.body.removals[0].artifacts).toEqual([{ table: 'TranscodedFile', path: '/tmp/cache/3.mp3' }]);
});

it('pages with limit and offset', async () => {
    const res = await request(makeApp()).get('/library/removals?limit=2&offset=2');
    expect(titles(res.body)).toEqual(['Song 1']);
    expect(res.body.count).toBe(3);
});

it('reads a limit that is not a number as the default, and a negative offset as the start', async () => {
    const spy = jest.spyOn(prisma.removalLog, 'findMany');
    const bogus = await request(makeApp()).get('/library/removals?limit=abc&offset=-5');
    expect(bogus.status).toBe(200);
    expect(spy.mock.calls[0][0]).toMatchObject({ skip: 0, take: 100 });
    expect(titles(bogus.body)).toEqual(['Song 3', 'Song 2', 'Song 1']);
    spy.mockRestore();
});

it('is admin-gated', async () => {
    (requireAdmin as jest.Mock).mockImplementationOnce((_req: any, res: any) => res.status(403).json({ error: 'forbidden' }));
    const res = await request(makeApp()).get('/library/removals');
    expect(res.status).toBe(403);
});
