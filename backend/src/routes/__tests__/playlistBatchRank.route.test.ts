/**
 * POST /playlists/:id/items/batch must insert through the shared rank
 * allocator, not with its own createMany.
 *
 * `rank` is UNIQUE per playlist with an empty-string default. This endpoint
 * used to write only `sort`, so every row landed on the single "" slot and
 * createMany({ skipDuplicates: true }) silently dropped all but the first: a
 * 50-track request answered `added: 1` while storing one track, and every later
 * batch into the same playlist stored nothing.
 *
 * The regression this pins is someone reintroducing a local insert here. The
 * allocator's own correctness lives in playlistService + lexoRank tests.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        playlist: { findUnique: jest.fn() },
        playlistItem: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
        track: { findMany: jest.fn().mockResolvedValue([]) },
        playlistPendingTrack: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn(async (fn: any) => (typeof fn === 'function' ? fn({}) : [])),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/playlistService', () => ({
    addTracks: jest.fn(),
    removeTracks: jest.fn(),
    moveItem: jest.fn(),
    maxRank: jest.fn(),
    nextRankAfter: jest.fn(),
    lockPlaylist: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-1', username: 'tester', role: 'user' };
        next();
    },
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-1', username: 'tester', role: 'user' };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../middleware/playlistOwner', () => ({
    requirePlaylistOwner: (_req: any, _res: any, next: any) => next(),
    requirePlaylistReader: (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import playlistRoutes from '../playlists';
import { prisma } from '../../utils/db';
import * as playlistService from '../../services/playlistService';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = { id: 'user-1', username: 'tester', role: 'user' };
        next();
    });
    app.use('/playlists', playlistRoutes);
    return app;
}

describe('POST /playlists/:id/items/batch', () => {
    let app: express.Application;
    const trackIds = ['t1', 't2', 't3'];

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            userId: 'user-1',
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValue([]);
        (playlistService.addTracks as jest.Mock).mockResolvedValue({
            added: 3,
            duplicates: 0,
            rejected: [],
        });
    });

    it('delegates the insert to the allocator instead of writing rows itself', async () => {
        const res = await request(app)
            .post('/playlists/pl-1/items/batch')
            .send({ trackIds });

        expect(res.status).toBe(200);
        expect(playlistService.addTracks).toHaveBeenCalledWith('pl-1', trackIds);
        // A local insert here is exactly the bug: it cannot know the current
        // max rank and has no lock.
        expect(prisma.playlistItem.createMany).not.toHaveBeenCalled();
    });

    it('reports the allocator counts, including rejects as skippedInvalid', async () => {
        (playlistService.addTracks as jest.Mock).mockResolvedValue({
            added: 1,
            duplicates: 1,
            rejected: ['t3'],
        });

        const res = await request(app)
            .post('/playlists/pl-1/items/batch')
            .send({ trackIds });

        expect(res.body.added).toBe(1);
        expect(res.body.skippedExisting).toBe(1);
        expect(res.body.skippedInvalid).toBe(1);
    });

    it('still refuses someone else\'s playlist', async () => {
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            userId: 'someone-else',
        });

        const res = await request(app)
            .post('/playlists/pl-1/items/batch')
            .send({ trackIds });

        expect(res.status).toBe(403);
        expect(playlistService.addTracks).not.toHaveBeenCalled();
    });
});
