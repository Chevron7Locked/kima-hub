/**
 * The loudness normalization toggle is a per-user setting the web player
 * reads on mount: saving it and reading it back must round-trip through
 * the real UserSettings row, and an unmodified user reports false.
 */

import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/db';

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: 'zz-loudness-settings-user', username: 'tester', role: 'user' };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import settingsRouter from '../settings';

const USER_ID = 'zz-loudness-settings-user';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', settingsRouter);
    return app;
}

const app = makeApp();

beforeAll(async () => {
    await prisma.userSettings.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.user.create({
        data: { id: USER_ID, username: USER_ID, passwordHash: 'x', role: 'user', tokenVersion: 0 },
    });
});

afterAll(async () => {
    await prisma.userSettings.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.$disconnect();
});

describe('loudness normalization setting', () => {
    it('stays off for a user who never touched it', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.body.loudnessNormalization).toBe(false);
    });

    it('round-trips on and back off', async () => {
        const on = await request(app).post('/').send({ loudnessNormalization: true });
        expect(on.status).toBe(200);
        expect(on.body.loudnessNormalization).toBe(true);

        const readBack = await request(app).get('/');
        expect(readBack.body.loudnessNormalization).toBe(true);

        const off = await request(app).post('/').send({ loudnessNormalization: false });
        expect(off.status).toBe(200);
        expect(off.body.loudnessNormalization).toBe(false);
    });

    it('rejects non-boolean values', async () => {
        const res = await request(app).post('/').send({ loudnessNormalization: 'loud' });
        expect(res.status).toBe(400);
    });
});
