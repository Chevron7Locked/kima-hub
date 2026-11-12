/**
 * The compat router answers every request even when a dependency rejects; in
 * Express 4 a rejected handler otherwise leaves the client hanging. A missing
 * fix shows up as a timeout. Real router, real share service, real database; a failure is
 * forced by making one call on the real client reject.
 */

import express from 'express';
import request from 'supertest';
import { compatRouter } from '../compat';
import { prisma } from '../../../utils/db';
import { logger } from '../../../utils/logger';

const P = 'zz-compat-answers';
const USER = `${P}-user`;
const TRACK = `${P}-track`;

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: 'user' };
        next();
    });
    app.use('/rest', compatRouter);
    return app;
}

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    await prisma.album.create({
        data: { id: `${P}-al`, rgMbid: `${P}-rg`, artistId: `${P}-ar`, identityKey: `${P}-al`, title: P, primaryType: 'Album', location: 'LIBRARY' },
    });
    await prisma.track.create({
        data: { id: TRACK, albumId: `${P}-al`, title: P, trackNo: 1, duration: 100, filePath: `${P}.flac`, fileModified: new Date(), fileSize: 1 },
    });
});

// The handlers log the failures these tests force; keep them out of the run's output.
beforeEach(() => {
    jest.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(async () => {
    await prisma.shareLink.deleteMany({ where: { createdBy: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

describe('compat router answers even when a dependency fails', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });

    it('createShare answers when the share service throws something unexpected', async () => {
        // Not a ShareError, so the handler's own error branch does not apply.
        jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(
            new Error('P2034: transaction conflict on ShareLink'),
        );

        const res = await request(app).get(`/rest/createShare.view?id=${TRACK}`);

        expect(res.status).toBe(200); // Subsonic reports errors inside a 200 envelope
        expect(res.text).toContain('error');
        // The raw driver message names tables and columns; it must not be the
        // text handed to the client.
        expect(res.text).not.toContain('P2034');
        expect(res.text).not.toContain('ShareLink');
        expect(await prisma.shareLink.count({ where: { createdBy: USER } })).toBe(0);
    });

    it('createShare answers when a lookup BEFORE the try block rejects', async () => {
        // These three lookups sit outside the handler's try, so only the
        // wrapper can answer for them.
        jest.spyOn(prisma.track, 'findUnique').mockRejectedValueOnce(
            new Error('connection terminated unexpectedly'),
        );

        const res = await request(app).get(`/rest/createShare.view?id=${TRACK}`);

        expect(res.status).toBe(200);
        expect(res.text).toContain('error');
    });

    it('getAvatar answers when the user lookup rejects', async () => {
        jest.spyOn(prisma.user, 'findUnique').mockRejectedValueOnce(new Error('pool timeout'));

        const res = await request(app).get(`/rest/getAvatar.view?username=${USER}`);

        expect(res.status).toBe(200);
        expect(res.text).toContain('error');
    });

    it('still returns a real share on the happy path', async () => {
        const res = await request(app).get(`/rest/createShare.view?id=${TRACK}`);

        expect(res.status).toBe(200);
        expect(res.text).not.toContain('error');
        const link = await prisma.shareLink.findFirstOrThrow({ where: { createdBy: USER, entityId: TRACK } });
        expect(link.entityType).toBe('track');
        expect(res.text).toContain(link.token);
    });
});
