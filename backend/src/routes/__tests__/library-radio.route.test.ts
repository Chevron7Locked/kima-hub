/**
 * Library Radio Route Integration Tests
 *
 * Focused regression coverage for GET /radio with type=all:
 * ensures track IDs are sourced from randomized full-library selection,
 * not a deterministic first-page findMany/take pattern.
 */

jest.mock('../../utils/db', () => ({
    Prisma: {
        SortOrder: { asc: 'asc', desc: 'desc' },
    },
    prisma: {
        track: {
            count: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
            count: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
        play: {
            findMany: jest.fn(),
        },
        audiobookProgress: {
            findMany: jest.fn(),
        },
        podcastProgress: {
            findMany: jest.fn(),
        },
        ownedAlbum: {
            findMany: jest.fn(),
            groupBy: jest.fn(),
        },
        trackLyrics: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
        },
        artist: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        $queryRaw: jest.fn(),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/lrclib', () => ({
    lrclibService: {
        fetchAndStoreLyrics: jest.fn(),
    },
}));

jest.mock('../../services/rateLimiter', () => ({
    rateLimiter: {
        checkLimit: jest.fn().mockResolvedValue({ allowed: true }),
    },
}));

jest.mock('../../utils/metadataOverrides', () => ({
    getMergedGenres: jest.fn().mockReturnValue([]),
}));

jest.mock('../../utils/dateFilters', () => ({
    getEffectiveYear: jest.fn(),
    getDecadeWhereClause: jest.fn().mockReturnValue({}),
    getDecadeFromYear: jest.fn(),
}));

jest.mock('../../config', () => ({
    config: {
        music: {
            musicPath: '/music',
        },
    },
}));

import express from 'express';
import request from 'supertest';
import tracksRoutes from '../../routes/library/tracks';
import { prisma } from '../../utils/db';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', tracksRoutes);
    return app;
}

function makeTrack(id: string) {
    return {
        id,
        title: `Track ${id}`,
        duration: 180,
        trackNo: 1,
        filePath: `/music/${id}.mp3`,
        bpm: null,
        energy: null,
        valence: null,
        arousal: null,
        danceability: null,
        keyScale: null,
        instrumentalness: null,
        analysisMode: null,
        moodHappy: null,
        moodSad: null,
        moodRelaxed: null,
        moodAggressive: null,
        moodParty: null,
        moodAcoustic: null,
        moodElectronic: null,
        album: {
            id: `album-${id}`,
            title: `Album ${id}`,
            coverUrl: null,
            artist: {
                id: `artist-${id}`,
                name: `Artist ${id}`,
            },
        },
        trackGenres: [],
    };
}

describe('GET /radio -- type=all', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses randomized id selection and returns only sampled tracks', async () => {
        const sampledIds = [{ id: 'late-901' }, { id: 'late-902' }, { id: 'late-903' }];

        (prisma.$queryRaw as jest.Mock).mockResolvedValue(sampledIds);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(sampledIds.map((t) => makeTrack(t.id)));

        const res = await request(app).get('/radio?type=all&limit=3');

        expect(res.status).toBe(200);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
        expect(prisma.track.findMany).toHaveBeenCalledTimes(1);

        const findManyArgs = (prisma.track.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs.where.id.in).toEqual(expect.arrayContaining(sampledIds.map((t) => t.id)));

        const returnedIds = res.body.tracks.map((t: { id: string }) => t.id);
        expect(returnedIds).toHaveLength(3);
        expect(returnedIds).toEqual(expect.arrayContaining(sampledIds.map((t) => t.id)));
    });

    it('does not use deterministic first-page findMany id prefetch for type=all', async () => {
        const sampledIds = [{ id: 'library-77' }, { id: 'library-88' }];

        (prisma.$queryRaw as jest.Mock).mockResolvedValue(sampledIds);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(sampledIds.map((t) => makeTrack(t.id)));

        const res = await request(app).get('/radio?type=all&limit=2');

        expect(res.status).toBe(200);

        const anyLegacyPrefetchCall = (prisma.track.findMany as jest.Mock).mock.calls.some((call) => {
            const arg = call[0] || {};
            return arg.select?.id === true && arg.take === 300 && arg.where === undefined;
        });

        expect(anyLegacyPrefetchCall).toBe(false);
    });
});

describe('GET /radio -- type=genre', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses randomized SQL candidate selection and returns sampled genre tracks', async () => {
        const genreIds = [{ id: 'genre-1' }, { id: 'genre-2' }];

        (prisma.$queryRaw as jest.Mock).mockResolvedValue(genreIds);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(genreIds.map((t) => makeTrack(t.id)));

        const res = await request(app).get('/radio?type=genre&value=rock&limit=2');

        expect(res.status).toBe(200);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
        expect(prisma.track.findMany).toHaveBeenCalledTimes(1);

        const queryCallArgs = (prisma.$queryRaw as jest.Mock).mock.calls[0];
        const queryTemplate = String(queryCallArgs[0]);
        expect(queryTemplate).toContain('ORDER BY RANDOM()');
        expect(queryCallArgs).toEqual(expect.arrayContaining(['%rock%', 4]));

        const findManyArgs = (prisma.track.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyArgs.where.id.in).toEqual(expect.arrayContaining(genreIds.map((t) => t.id)));

        const returnedIds = res.body.tracks.map((t: { id: string }) => t.id);
        expect(returnedIds).toEqual(expect.arrayContaining(genreIds.map((t) => t.id)));
    });
});

describe('GET /radio -- type=decade', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses randomized SQL candidate selection and returns sampled decade tracks', async () => {
        const decadeIds = [{ id: 'decade-1' }, { id: 'decade-2' }, { id: 'decade-3' }];

        (prisma.$queryRaw as jest.Mock).mockResolvedValue(decadeIds);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(decadeIds.map((t) => makeTrack(t.id)));

        const res = await request(app).get('/radio?type=decade&value=1990&limit=3');

        expect(res.status).toBe(200);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
        expect(prisma.track.findMany).toHaveBeenCalledTimes(1);

        const queryCallArgs = (prisma.$queryRaw as jest.Mock).mock.calls[0];
        const queryTemplate = String(queryCallArgs[0]);
        expect(queryTemplate).toContain('ORDER BY RANDOM()');

        const hydrateCallArgs = (prisma.track.findMany as jest.Mock).mock.calls[0][0];
        expect(hydrateCallArgs.where.id.in).toEqual(expect.arrayContaining(decadeIds.map((t) => t.id)));

        const returnedIds = res.body.tracks.map((t: { id: string }) => t.id);
        expect(returnedIds).toEqual(expect.arrayContaining(decadeIds.map((t) => t.id)));
    });
});
