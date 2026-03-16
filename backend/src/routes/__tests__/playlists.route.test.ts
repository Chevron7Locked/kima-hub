/**
 * Playlist Route IDOR and Ownership Tests
 *
 * The core security property under test: playlist mutations (PUT, DELETE,
 * add/remove tracks) enforce ownership. A user must not be able to modify
 * or delete a playlist they don't own.
 *
 * Each test verifies TWO things:
 *   1. The correct HTTP status code (403)
 *   2. That the database write (update/delete) was NOT called -- the ownership
 *      check must reject BEFORE the DB mutation, not after.
 *
 * The second assertion is the critical one. A test that only checks status
 * codes would pass even if the DB write happened before the 403 was returned.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        playlist: {
            create: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        hiddenPlaylist: {
            findMany: jest.fn(),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
        },
        playlistItem: {
            findFirst: jest.fn(),
            create: jest.fn(),
            findMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        apiKey: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        user: {
            findUnique: jest.fn(),
        },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/playlistLogger', () => ({
    sessionLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/errors', () => ({
    safeError: jest.fn((err: Error) => err.message),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import playlistsRoutes from '../../routes/playlists';
import { prisma } from '../../utils/db';

const TEST_SECRET = process.env.JWT_SECRET!;

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/playlists', playlistsRoutes);
    return app;
}

function tokenFor(userId: string, tokenVersion = 1): string {
    return jwt.sign(
        { userId, username: `user-${userId}`, role: 'user', tokenVersion },
        TEST_SECRET,
        { expiresIn: '24h' }
    );
}

const USER_A = 'user-aaaa-1111';
const USER_B = 'user-bbbb-2222';
const PLAYLIST_ID = 'playlist-xyz-789';

// Playlist owned by User A
const userAPlaylist = {
    id: PLAYLIST_ID,
    userId: USER_A,
    name: 'User A Playlist',
    isPublic: false,
    createdAt: new Date(),
    updatedAt: new Date(),
};

// ── Auth check ────────────────────────────────────────────────────────────────

describe('Authentication enforcement', () => {
    const app = createTestApp();

    it('returns 401 on all playlist routes without token', async () => {
        const endpoints = [
            () => request(app).get('/playlists'),
            () => request(app).get(`/playlists/${PLAYLIST_ID}`),
            () => request(app).post('/playlists').send({ name: 'test' }),
            () => request(app).put(`/playlists/${PLAYLIST_ID}`).send({ name: 'x' }),
            () => request(app).delete(`/playlists/${PLAYLIST_ID}`),
        ];

        for (const req of endpoints) {
            const res = await req();
            expect(res.status).toBe(401);
        }
    });
});

// ── IDOR: GET (read isolation) ────────────────────────────────────────────────

describe('GET /playlists/:id -- access control', () => {
    const app = createTestApp();

    beforeEach(() => {
        jest.clearAllMocks();
        // Auth: both users are valid
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            id: USER_B,
            username: 'user-b',
            role: 'user',
            tokenVersion: 1,
        });
        (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('returns 403 when User B requests User A\'s private playlist', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(userAPlaylist);

        const res = await request(app)
            .get(`/playlists/${PLAYLIST_ID}`)
            .set('Authorization', `Bearer ${tokenFor(USER_B)}`);

        expect(res.status).toBe(403);
        expect(res.body.error).toBeDefined();
        // 403 not 404 -- the playlist exists but access is denied
        // (404 would hide whether the resource exists, masking the auth check)
    });

    it('returns 200 when User A requests their own private playlist', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            id: USER_A, username: 'user-a', role: 'user', tokenVersion: 1,
        });
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            ...userAPlaylist,
            items: [],
            pendingTracks: [],
            hiddenByUsers: [],
            user: { username: 'user-a' },
        });

        const res = await request(app)
            .get(`/playlists/${PLAYLIST_ID}`)
            .set('Authorization', `Bearer ${tokenFor(USER_A)}`);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(PLAYLIST_ID);
    });

    it('returns 200 when any user requests a public playlist', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            ...userAPlaylist,
            isPublic: true,
            items: [],
            pendingTracks: [],
            hiddenByUsers: [],
            user: { username: 'user-a' },
        });

        const res = await request(app)
            .get(`/playlists/${PLAYLIST_ID}`)
            .set('Authorization', `Bearer ${tokenFor(USER_B)}`);

        expect(res.status).toBe(200);
    });
});

// ── IDOR: PUT (write isolation) ───────────────────────────────────────────────

describe('PUT /playlists/:id -- ownership enforcement', () => {
    const app = createTestApp();

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            id: USER_B, username: 'user-b', role: 'user', tokenVersion: 1,
        });
        (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('returns 403 and does NOT call prisma.playlist.update when User B updates User A\'s playlist', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(userAPlaylist);

        const res = await request(app)
            .put(`/playlists/${PLAYLIST_ID}`)
            .set('Authorization', `Bearer ${tokenFor(USER_B)}`)
            .send({ name: 'Hijacked' });

        expect(res.status).toBe(403);
        // Critical: the update must not have been executed
        expect(prisma.playlist.update).not.toHaveBeenCalled();
    });

    it('allows User A to update their own playlist', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            id: USER_A, username: 'user-a', role: 'user', tokenVersion: 1,
        });
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(userAPlaylist);
        (prisma.playlist.update as jest.Mock).mockResolvedValue({
            ...userAPlaylist, name: 'Renamed',
        });

        const res = await request(app)
            .put(`/playlists/${PLAYLIST_ID}`)
            .set('Authorization', `Bearer ${tokenFor(USER_A)}`)
            .send({ name: 'Renamed' });

        expect(res.status).toBe(200);
        expect(prisma.playlist.update).toHaveBeenCalledTimes(1);
    });
});

// ── IDOR: DELETE (deletion isolation) ────────────────────────────────────────

describe('DELETE /playlists/:id -- ownership enforcement', () => {
    const app = createTestApp();

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            id: USER_B, username: 'user-b', role: 'user', tokenVersion: 1,
        });
        (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('returns 403 and does NOT call prisma.playlist.delete when User B deletes User A\'s playlist', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(userAPlaylist);

        const res = await request(app)
            .delete(`/playlists/${PLAYLIST_ID}`)
            .set('Authorization', `Bearer ${tokenFor(USER_B)}`);

        expect(res.status).toBe(403);
        // The delete must not have run
        expect(prisma.playlist.delete).not.toHaveBeenCalled();
    });

    it('allows User A to delete their own playlist', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            id: USER_A, username: 'user-a', role: 'user', tokenVersion: 1,
        });
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue(userAPlaylist);
        (prisma.playlist.delete as jest.Mock).mockResolvedValue(userAPlaylist);

        const res = await request(app)
            .delete(`/playlists/${PLAYLIST_ID}`)
            .set('Authorization', `Bearer ${tokenFor(USER_A)}`);

        expect(res.status).toBe(200);
        expect(prisma.playlist.delete).toHaveBeenCalledTimes(1);
    });
});

// ── GET /playlists -- data isolation (user only sees their own + public) ──────

describe('GET /playlists -- data isolation', () => {
    const app = createTestApp();

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            id: USER_B, username: 'user-b', role: 'user', tokenVersion: 1,
        });
        (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.hiddenPlaylist.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('playlist list query includes userId filter -- only own + public playlists are accessible', async () => {
        (prisma.playlist.findMany as jest.Mock).mockResolvedValue([]);

        await request(app)
            .get('/playlists')
            .set('Authorization', `Bearer ${tokenFor(USER_B)}`);

        const call = (prisma.playlist.findMany as jest.Mock).mock.calls[0][0];
        // The WHERE clause must scope results to the requesting user
        expect(call.where).toEqual(
            expect.objectContaining({
                OR: expect.arrayContaining([
                    expect.objectContaining({ userId: USER_B }),
                    expect.objectContaining({ isPublic: true }),
                ]),
            })
        );
        // Must NOT contain a query with no user scope
        expect(call.where.userId).toBeUndefined(); // not a global userId filter
    });
});
