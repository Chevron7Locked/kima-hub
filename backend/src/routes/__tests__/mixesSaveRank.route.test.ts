/**
 * POST /mixes/:id/save -- every PlaylistItem it writes must carry a distinct
 * `rank`.
 *
 * `rank` is UNIQUE per playlist with an empty-string default. An insert that
 * omits it leaves every row at "" and the unique index rejects all but the
 * first -- silently, because createMany's skipDuplicates behaviour swallows the
 * rejection. Saving a 12-track mix would answer `trackCount: 12` while storing
 * one track.
 *
 * The upstream rebuild never hit this because it deleted this endpoint. This
 * line keeps it, so the endpoint has to assign ranks itself.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        playlist: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
        },
        playlistItem: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redis', () => ({
    redisClient: { get: jest.fn(), setex: jest.fn().mockResolvedValue('OK') },
}));

jest.mock('../../services/programmaticPlaylists', () => ({
    programmaticPlaylistService: { generateAllMixes: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../services/moodBucketService', () => ({
    moodBucketService: {},
    VALID_MOODS: [],
    MoodType: {},
}));

jest.mock('../../middleware/auth', () => ({
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import mixRoutes from '../mixes';
import { prisma } from '../../utils/db';
import { redisClient } from '../../utils/redis';

const TRACK_IDS = ['t1', 't2', 't3', 't4', 't5'];

function makeApp() {
    const app = express();
    app.use(express.json());
    // The route reads req.user directly rather than going through middleware.
    app.use((req: any, _res, next) => {
        req.user = { id: 'user-1', username: 'tester', role: 'user' };
        next();
    });
    app.use('/mixes', mixRoutes);
    return app;
}

describe('POST /mixes/:id/save assigns ranks', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (redisClient.get as jest.Mock).mockResolvedValue(
            JSON.stringify([{ id: 'mix-1', name: 'Late Night', trackIds: TRACK_IDS }]),
        );
        (prisma.playlist.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.playlist.create as jest.Mock).mockResolvedValue({
            id: 'pl-1',
            name: 'Late Night',
        });
    });

    it('gives every track a distinct, non-empty rank', async () => {
        const res = await request(app).post('/mixes/mix-1/save').send({});

        expect(res.status).toBe(200);
        expect(prisma.playlistItem.createMany).toHaveBeenCalledTimes(1);

        const data = (prisma.playlistItem.createMany as jest.Mock).mock.calls[0][0].data;
        expect(data).toHaveLength(TRACK_IDS.length);

        const ranks = data.map((d: any) => d.rank);
        // Non-empty: "" is the default that collides.
        for (const r of ranks) {
            expect(typeof r).toBe('string');
            expect(r).not.toBe('');
        }
        // Distinct: the unique index is per (playlistId, rank).
        expect(new Set(ranks).size).toBe(TRACK_IDS.length);
    });

    it('orders the ranks the same way it orders the tracks', async () => {
        await request(app).post('/mixes/mix-1/save').send({});

        const data = (prisma.playlistItem.createMany as jest.Mock).mock.calls[0][0].data;
        const ranks = data.map((d: any) => d.rank);
        const sorted = [...ranks].sort();

        // Lexicographic order of the rank keys must match insertion order,
        // otherwise the saved playlist plays in a different order than the mix.
        expect(ranks).toEqual(sorted);
        expect(data.map((d: any) => d.trackId)).toEqual(TRACK_IDS);
    });
});
