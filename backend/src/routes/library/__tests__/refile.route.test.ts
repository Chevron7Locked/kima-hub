/**
 * POST /library/refile: an admin queues the re-file (albumRefile.ts) on the scan queue and is answered at once; a
 * second request while one is waiting or running is refused with the reason. The queue is stood in for.
 */
jest.mock('../../../middleware/auth', () => ({
    requireAdmin: jest.fn((req: any, _res: any, next: any) => {
        req.user = { id: 'refile-admin', username: 'admin', role: 'admin' };
        next();
    }),
}));
jest.mock('../../../workers/queues', () => ({ scanQueue: {} }));
const mockRequestRefile = jest.fn();
jest.mock('../../../workers/scanRequest', () => ({ requestScan: jest.fn(), requestRefile: (...a: unknown[]) => mockRequestRefile(...a) }));
jest.mock('../../../workers/organizeSingles', () => ({ organizeSingles: jest.fn() }));

import express from 'express';
import request from 'supertest';
import router from '../scan';
import { expectLog } from '../../../__tests__/helpers/expectedLogs';
import { mountAsServer } from "../../__tests__/helpers/serverMount";

function makeApp() {
    const app = express();
    mountAsServer(app, '/library', router, "/api/library", { standIn: true });
    return app;
}

beforeEach(() => mockRequestRefile.mockReset());

it('queues the re-file for the admin who asked and answers at once', async () => {
    mockRequestRefile.mockResolvedValue({ queued: true, jobId: 'refile-albums' });
    const res = await request(makeApp()).post('/library/refile');
    expect(res.status).toBe(202);
    expect(mockRequestRefile).toHaveBeenCalledWith('refile-admin');
});

it('refuses a second re-file while one is waiting or running, and says why', async () => {
    mockRequestRefile.mockResolvedValue({ queued: false, jobId: 'refile-albums', reason: 'a re-file is already active' });
    const res = await request(makeApp()).post('/library/refile');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Albums are already being re-filed (a re-file is already active)');
});

it('answers 500 when the queue cannot be reached', async () => {
    expectLog('error');
    mockRequestRefile.mockRejectedValue(new Error('redis down'));
    expect((await request(makeApp()).post('/library/refile')).status).toBe(500);
});
