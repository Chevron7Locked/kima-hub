/**
 * POST /playlists/:id/cover and DELETE /playlists/:id/cover (issue #151).
 *
 * Runs entirely against mocks: the real Express router, the real auth
 * middleware (JWT), the real ownership guard and real multer; prisma,
 * imageStorage and eventBus are mocked, so this file needs no database and
 * can run with a no-op globalSetup override:
 *
 *   npx jest --globalSetup=./jest-global-setup.noop.cjs src/routes/__tests__/playlists.cover.route.test.ts
 */

// All mocks must be before imports
jest.mock('../../utils/db', () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
        },
        playlist: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/imageStorage', () => ({
    storePlaylistCover: jest.fn(),
    getLocalImagePath: jest.fn(),
}));

jest.mock('../../services/eventBus', () => ({
    eventBus: { emit: jest.fn() },
}));

jest.mock('../../utils/previewProxy', () => ({
    proxyPreviewStream: jest.fn(),
}));

jest.mock('../../utils/playlistLogger', () => ({
    sessionLog: jest.fn(),
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
import fs from 'fs';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import playlistsRoutes from '../../routes/playlists';
import { prisma } from '../../utils/db';
import { storePlaylistCover, getLocalImagePath } from '../../services/imageStorage';
import { eventBus } from '../../services/eventBus';

const JWT_SECRET = process.env.JWT_SECRET!;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/playlists', playlistsRoutes);
    return app;
}

function userToken(userId = 'user-1') {
    return jwt.sign(
        { userId, username: 'testuser', role: 'user', tokenVersion: 1 },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
}

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

const OWNED_PLAYLIST = {
    id: 'pl-1',
    userId: 'user-1',
    isPublic: false,
    name: 'My List',
};

const FAKE_IMAGE = Buffer.from('fake-image-bytes-for-mock');

describe('POST /playlists/:id/cover', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
    });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
    });

    it('returns 401 without a token', async () => {
        const res = await request(app).post('/playlists/pl-1/cover');
        expect(res.status).toBe(401);
    });

    it('returns 404 when the playlist does not exist', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app)
            .post('/playlists/missing/cover')
            .set('Authorization', `Bearer ${userToken()}`)
            .attach('cover', FAKE_IMAGE, { filename: 'cover.png', contentType: 'image/png' });

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Playlist not found');
    });

    it('returns 403 when the caller is not the owner', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            ...OWNED_PLAYLIST,
            userId: 'someone-else',
        });

        const res = await request(app)
            .post('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`)
            .attach('cover', FAKE_IMAGE, { filename: 'cover.png', contentType: 'image/png' });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Access denied');
        expect(storePlaylistCover).not.toHaveBeenCalled();
    });

    it('returns 400 when no file was uploaded', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(OWNED_PLAYLIST);

        const res = await request(app)
            .post('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('No image uploaded');
    });

    it('returns 400 for an unsupported mime type', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(OWNED_PLAYLIST);

        const res = await request(app)
            .post('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`)
            .attach('cover', FAKE_IMAGE, { filename: 'notes.txt', contentType: 'text/plain' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Only JPEG, PNG and WebP images are accepted');
        expect(storePlaylistCover).not.toHaveBeenCalled();
    });

    it('stores the cover, persists the native URL and emits playlist:updated', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(OWNED_PLAYLIST);
        (storePlaylistCover as jest.Mock).mockResolvedValue('native:playlists/pl-1.jpg');
        (prisma.playlist.update as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            coverUrl: 'native:playlists/pl-1.jpg',
        });

        const res = await request(app)
            .post('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`)
            .attach('cover', FAKE_IMAGE, { filename: 'cover.webp', contentType: 'image/webp' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: 'pl-1', coverUrl: 'native:playlists/pl-1.jpg' });
        expect(storePlaylistCover).toHaveBeenCalledWith(FAKE_IMAGE, 'pl-1');
        expect(prisma.playlist.update).toHaveBeenCalledWith({
            where: { id: 'pl-1' },
            data: { coverUrl: 'native:playlists/pl-1.jpg' },
            select: { id: true, coverUrl: true },
        });
        expect(eventBus.emit).toHaveBeenCalledWith({
            type: 'playlist:updated',
            userId: 'user-1',
            payload: { playlistId: 'pl-1' },
        });
    });

    it('returns 400 when the image cannot be decoded', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(OWNED_PLAYLIST);
        (storePlaylistCover as jest.Mock).mockRejectedValue(new Error('Input file is missing'));

        const res = await request(app)
            .post('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`)
            .attach('cover', FAKE_IMAGE, { filename: 'cover.jpg', contentType: 'image/jpeg' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Could not decode image');
        expect(prisma.playlist.update).not.toHaveBeenCalled();
    });
});

describe('DELETE /playlists/:id/cover', () => {
    let app: express.Application;
    let rmSpy: jest.SpyInstance;

    beforeAll(() => {
        app = makeApp();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        rmSpy.mockClear();
        rmSpy.mockResolvedValue(undefined);
    });

    it('returns 403 when the caller is not the owner', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            userId: 'someone-else',
            coverUrl: 'native:playlists/pl-1.jpg',
        });

        const res = await request(app)
            .delete('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`);

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Access denied');
    });

    it('returns 404 when the playlist has no custom cover', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            userId: 'user-1',
            coverUrl: null,
        });

        const res = await request(app)
            .delete('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`);

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('No custom cover to remove');
        expect(rmSpy).not.toHaveBeenCalled();
        expect(prisma.playlist.update).not.toHaveBeenCalled();
    });

    it('removes the stored file, clears coverUrl and emits playlist:updated', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            userId: 'user-1',
            coverUrl: 'native:playlists/pl-1.jpg',
        });
        (getLocalImagePath as jest.Mock).mockReturnValue('/tmp/covers/playlists/pl-1.jpg');
        (prisma.playlist.update as jest.Mock).mockResolvedValue({});

        const res = await request(app)
            .delete('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: 'Cover removed' });
        expect(rmSpy).toHaveBeenCalledWith('/tmp/covers/playlists/pl-1.jpg', { force: true });
        expect(prisma.playlist.update).toHaveBeenCalledWith({
            where: { id: 'pl-1' },
            data: { coverUrl: null },
        });
        expect(eventBus.emit).toHaveBeenCalledWith({
            type: 'playlist:updated',
            userId: 'user-1',
            payload: { playlistId: 'pl-1' },
        });
    });

    it('clears coverUrl without touching the file for foreign (non-native) URLs', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            userId: 'user-1',
            coverUrl: 'https://example.com/cover.jpg',
        });
        (prisma.playlist.update as jest.Mock).mockResolvedValue({});

        const res = await request(app)
            .delete('/playlists/pl-1/cover')
            .set('Authorization', `Bearer ${userToken()}`);

        expect(res.status).toBe(200);
        expect(getLocalImagePath).not.toHaveBeenCalled();
        expect(rmSpy).not.toHaveBeenCalled();
        expect(prisma.playlist.update).toHaveBeenCalledWith({
            where: { id: 'pl-1' },
            data: { coverUrl: null },
        });
    });
});

describe('GET /playlists/:id (cover display path)', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
    });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
    });

    it('includes coverUrl in the playlist payload', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            userId: 'user-1',
            isPublic: false,
            name: 'My List',
            mixId: null,
            spotifyPlaylistId: null,
            spotifyPlaylistUrl: null,
            coverUrl: 'native:playlists/pl-1.jpg',
            createdAt: new Date(),
            updatedAt: new Date(),
            user: { username: 'testuser' },
            hiddenByUsers: [],
            items: [],
            pendingTracks: [],
        });

        const res = await request(app)
            .get('/playlists/pl-1')
            .set('Authorization', `Bearer ${userToken()}`);

        expect(res.status).toBe(200);
        expect(res.body.coverUrl).toBe('native:playlists/pl-1.jpg');
        expect(res.body.isOwner).toBe(true);
    });
});
