/**
 * POST /share and DELETE /share/:token (authenticated); the cover route. GET /share/:token is in publicShare.route.test.ts. Streaming and cover
 * routes need real files and are left out; their path guard is tested directly.
 */

// All mocks must be before imports
jest.mock('../../utils/db', () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
        },
        shareLink: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            count: jest.fn(),
        },
        track: { findUnique: jest.fn(), findFirst: jest.fn() },
        $transaction: jest.fn(),
        $executeRaw: jest.fn(),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/imageStorage', () => ({
    getLocalImagePath: jest.fn(),
    getResizedImagePath: jest.fn(),
}));

jest.mock('../../services/audioStreaming', () => ({
    getAudioStreamingService: jest.fn(() => ({
        streamFileWithRangeSupport: jest.fn(),
    })),
}));

jest.mock('../../config', () => ({
    config: {
        music: {
            musicPath: '/music',
            transcodeCachePath: '/tmp/transcode',
            transcodeCacheMaxGb: 10,
        },
    },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import shareRoutes from '../../routes/share';
import { prisma } from '../../utils/db';

const JWT_SECRET = process.env.JWT_SECRET!;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/share', shareRoutes);
    return app;
}

function userToken(userId = 'user-1', role = 'user') {
    return jwt.sign({ userId, username: 'testuser', role, tokenVersion: 1 }, JWT_SECRET, { expiresIn: '24h' });
}

const BASE_USER = {
    id: 'user-1',
    username: 'testuser',
    role: 'user',
    tokenVersion: 1,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    onboardingComplete: true,
    createdAt: new Date(),
};

const BASE_SHARE_LINK = {
    id: 'share-id-1',
    token: 'valid-token-abc',
    entityType: 'track',
    entityId: 'track-id-1',
    createdBy: 'user-1',
    expiresAt: null,
    maxPlays: null,
    playCount: 0,
    createdAt: new Date(),
};

describe('POST /share -- create share link', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app)
            .post('/share')
            .send({ entityType: 'track', entityId: 'track-1' });
        expect(res.status).toBe(401);
    });

    it('returns 400 when entityType is missing', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken()}`)
            .send({ entityId: 'track-1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it('returns 400 for invalid entityType', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken()}`)
            .send({ entityType: 'podcast', entityId: 'ep-1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('entityType must be playlist, track, or album');
    });

    it('returns 404 when track does not exist', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken()}`)
            .send({ entityType: 'track', entityId: 'missing-track' });
        expect(res.status).toBe(404);
    });

    it('creates and returns a share token for a valid track', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({ id: 'track-1' });
        (prisma.$transaction as jest.Mock).mockResolvedValue({
            token: 'new-share-token-xyz',
            url: '/share/new-share-token-xyz',
        });

        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken()}`)
            .send({ entityType: 'track', entityId: 'track-1' });
        expect(res.status).toBe(200);
        expect(res.body.token).toBe('new-share-token-xyz');
        expect(res.body.url).toBe('/share/new-share-token-xyz');
    });
});

describe('DELETE /share/:token -- revoke share link', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).delete('/share/some-token');
        expect(res.status).toBe(401);
    });

    it('returns 404 when token does not exist', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app)
            .delete('/share/ghost-token')
            .set('Authorization', `Bearer ${userToken()}`);
        expect(res.status).toBe(404);
    });

    it('returns 403 when authenticated user is not the link owner', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_SHARE_LINK,
            createdBy: 'other-user-id',
        });

        const res = await request(app)
            .delete('/share/valid-token-abc')
            .set('Authorization', `Bearer ${userToken('user-1')}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Not the link owner');
    });

    it('revokes successfully when owner deletes their link', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(BASE_SHARE_LINK);
        (prisma.shareLink.delete as jest.Mock).mockResolvedValue(BASE_SHARE_LINK);

        const res = await request(app)
            .delete('/share/valid-token-abc')
            .set('Authorization', `Bearer ${userToken('user-1')}`);
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Share link revoked');
        expect(prisma.shareLink.delete).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'share-id-1' } }),
        );
    });
});

describe('GET /share/:token/cover-art/:coverArtId', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('answers a cover id holding a lone percent sign with 404, not a server error', async () => {
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(BASE_SHARE_LINK);

        const res = await request(app).get(`/share/valid-token-abc/cover-art/${encodeURIComponent('50%off')}`);
        expect(res.status).toBe(404);
    });
});
