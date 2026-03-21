/**
 * Share Routes Integration Tests
 *
 * Tests the public (unauthenticated) GET /share/:token resolve endpoint
 * and the authenticated POST /share create endpoint using supertest.
 * Streaming and cover-art routes require real files on disk and are
 * excluded -- their path-traversal guard is tested directly.
 */

// All mocks must be before imports
jest.mock('../../utils/db', () => ({
    prisma: {
        shareLink: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            count: jest.fn(),
        },
        playlist: { findUnique: jest.fn() },
        track: { findUnique: jest.fn(), findFirst: jest.fn() },
        album: { findUnique: jest.fn() },
        playlistItem: { findFirst: jest.fn() },
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
    // Share routes mount at /share; also mock requireAuth by injecting user
    app.use('/share', shareRoutes);
    return app;
}

function userToken(userId = 'user-1', role = 'user') {
    return jwt.sign({ userId, username: 'testuser', role, tokenVersion: 1 }, JWT_SECRET, { expiresIn: '24h' });
}

// Seed prisma.user.findUnique for requireAuth middleware used in POST / DELETE
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
        playlist: { findUnique: jest.fn() },
        track: { findUnique: jest.fn(), findFirst: jest.fn() },
        album: { findUnique: jest.fn() },
        playlistItem: { findFirst: jest.fn() },
        $transaction: jest.fn(),
        $executeRaw: jest.fn(),
    },
}));

const BASE_USER = {
    id: 'user-1',
    username: 'testuser',
    role: 'user',
    tokenVersion: 1,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    onboardingComplete: true,
    enrichmentSettings: null,
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

describe('GET /share/:token -- resolve share link', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 404 when token does not exist', async () => {
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/share/nonexistent-token');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Share link not found');
    });

    it('returns 410 when share link is expired', async () => {
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_SHARE_LINK,
            expiresAt: new Date(Date.now() - 1000), // 1 second in the past
        });

        const res = await request(app).get('/share/valid-token-abc');
        expect(res.status).toBe(410);
        expect(res.body.error).toBe('Share link has expired');
    });

    it('returns 410 when play limit has been reached', async () => {
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_SHARE_LINK,
            maxPlays: 5,
            playCount: 5,
        });

        const res = await request(app).get('/share/valid-token-abc');
        expect(res.status).toBe(410);
        expect(res.body.error).toBe('Share link play limit reached');
    });

    it('returns 404 when the referenced track no longer exists', async () => {
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(BASE_SHARE_LINK);
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/share/valid-token-abc');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Shared content no longer exists');
    });

    it('returns 200 with entity data for a valid track share', async () => {
        const mockTrack = {
            id: 'track-id-1',
            title: 'Karma Police',
            duration: 261,
            album: {
                title: 'OK Computer',
                artist: { id: 'artist-1', name: 'Radiohead' },
            },
        };
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(BASE_SHARE_LINK);
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(mockTrack);

        const res = await request(app).get('/share/valid-token-abc');
        expect(res.status).toBe(200);
        expect(res.body.entityType).toBe('track');
        expect(res.body.entity).toBeDefined();
        expect(res.body.entity.title).toBe('Karma Police');
        expect(res.body.createdAt).toBeDefined();
    });

    it('returns 200 with playlist entity for playlist share', async () => {
        const playlistLink = { ...BASE_SHARE_LINK, entityType: 'playlist', entityId: 'playlist-1' };
        const mockPlaylist = {
            id: 'playlist-1',
            title: 'My Mix',
            items: [],
            user: { username: 'testuser' },
        };
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(playlistLink);
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(mockPlaylist);

        const res = await request(app).get('/share/valid-token-abc');
        expect(res.status).toBe(200);
        expect(res.body.entityType).toBe('playlist');
        expect(res.body.entity.title).toBe('My Mix');
    });

    it('returns 200 for album share', async () => {
        const albumLink = { ...BASE_SHARE_LINK, entityType: 'album', entityId: 'album-1' };
        const mockAlbum = {
            id: 'album-1',
            title: 'OK Computer',
            artist: { id: 'artist-1', name: 'Radiohead' },
            tracks: [{ id: 'track-1', title: 'Airbag', trackNo: 1, duration: 231 }],
        };
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(albumLink);
        (prisma.album.findUnique as jest.Mock).mockResolvedValue(mockAlbum);

        const res = await request(app).get('/share/valid-token-abc');
        expect(res.status).toBe(200);
        expect(res.body.entity.title).toBe('OK Computer');
    });

    it('does not require authentication (no Authorization header needed)', async () => {
        (prisma.shareLink.findUnique as jest.Mock).mockResolvedValue(BASE_SHARE_LINK);
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({
            id: 'track-id-1',
            title: 'Karma Police',
            duration: 261,
            album: { title: 'OK Computer', artist: { id: 'a1', name: 'Radiohead' } },
        });

        // Deliberately no Authorization header
        const res = await request(app).get('/share/valid-token-abc');
        expect(res.status).toBe(200);
    });
});

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
