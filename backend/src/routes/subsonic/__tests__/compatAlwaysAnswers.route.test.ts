/**
 * The compat router must ANSWER every request, including when a dependency
 * rejects.
 *
 * In Express 4 a rejected handler promise produces no response and never
 * reaches an error handler -- the socket just stays open until the client gives
 * up. createShare.view had a bare `throw` for non-ShareError failures, and both
 * async handlers in this file ran their awaits with no wrapper, so a Prisma or
 * Redis failure meant a Subsonic client hung.
 *
 * These tests fail by TIMING OUT when the fix is absent, which is exactly the
 * production symptom.
 */

jest.mock('../../../utils/db', () => ({
    prisma: {
        track: { findUnique: jest.fn() },
        album: { findUnique: jest.fn() },
        playlist: { findUnique: jest.fn() },
        user: { findUnique: jest.fn() },
    },
}));

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../services/shareService', () => {
    class ShareError extends Error {
        code: string;
        constructor(message: string, code: string) {
            super(message);
            this.code = code;
        }
    }
    return { createShareLink: jest.fn(), ShareError };
});

import express from 'express';
import request from 'supertest';
import { compatRouter } from '../compat';
import { prisma } from '../../../utils/db';
import { createShareLink } from '../../../services/shareService';

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: 'user-1', username: 'tester', role: 'user' };
        next();
    });
    app.use('/rest', compatRouter);
    return app;
}

describe('compat router answers even when a dependency fails', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({ id: 'tr-1' });
        (prisma.album.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('createShare answers when the share service throws something unexpected', async () => {
        // Not a ShareError -- the class the handler used to rethrow.
        (createShareLink as jest.Mock).mockRejectedValue(
            new Error('P2034: transaction conflict on ShareLink'),
        );

        const res = await request(app).get('/rest/createShare.view?id=tr-1');

        expect(res.status).toBe(200); // Subsonic reports errors inside a 200 envelope
        expect(res.text).toContain('error');
        // The raw driver message names tables and columns; it must not be the
        // text handed to the client.
        expect(res.text).not.toContain('P2034');
        expect(res.text).not.toContain('ShareLink');
    });

    it('createShare answers when a lookup BEFORE the try block rejects', async () => {
        // These three lookups sit outside the handler's try, so only the
        // wrapper can answer for them.
        (prisma.track.findUnique as jest.Mock).mockRejectedValue(
            new Error('connection terminated unexpectedly'),
        );

        const res = await request(app).get('/rest/createShare.view?id=tr-1');

        expect(res.status).toBe(200);
        expect(res.text).toContain('error');
    });

    it('getAvatar answers when the user lookup rejects', async () => {
        (prisma.user.findUnique as jest.Mock).mockRejectedValue(
            new Error('pool timeout'),
        );

        const res = await request(app).get('/rest/getAvatar.view?username=tester');

        expect(res.status).toBe(200);
        expect(res.text).toContain('error');
    });

    it('still returns a real share on the happy path', async () => {
        (createShareLink as jest.Mock).mockResolvedValue({
            token: 'tok-123',
            url: '/share/tok-123',
        });

        const res = await request(app).get('/rest/createShare.view?id=tr-1');

        expect(res.status).toBe(200);
        expect(res.text).toContain('tok-123');
        expect(res.text).not.toContain('error');
    });
});
