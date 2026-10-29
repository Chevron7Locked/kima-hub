/**
 * GET /podcasts/:id caps `episodes`, newest first, so old clients still render;
 * the paging endpoint serves the rest. Both read one page through the same query.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        podcastSubscription: { count: jest.fn() },
        podcast: { findUnique: jest.fn() },
        podcastEpisode: { findMany: jest.fn(), count: jest.fn() },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 't' }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 't' }; next(); },
}));

jest.mock('../../services/rss-parser', () => ({ rssParserService: {} }));
jest.mock('../../utils/ssrf', () => ({ validateUrlForFetch: jest.fn() }));
jest.mock('axios', () => ({ default: { get: jest.fn() }, get: jest.fn() }));

import express from 'express';
import request from 'supertest';
import podcastRoutes from '../podcasts';
import { prisma } from '../../utils/db';

const BACK_CATALOGUE = 2944;

function episodes(n: number, from = 0) {
    return Array.from({ length: n }, (_, i) => ({
        id: `ep-${from + i}`,
        title: `Episode ${from + i}`,
        description: '',
        duration: 1800,
        publishedAt: new Date(),
        episodeNumber: from + i,
        season: 1,
        imageUrl: null,
        progress: [],
        downloads: [],
    }));
}

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/podcasts', podcastRoutes);
    return app;
}

describe('podcast episode paging', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.podcastSubscription.count as jest.Mock).mockResolvedValue(1);
        (prisma.podcastEpisode.count as jest.Mock).mockResolvedValue(BACK_CATALOGUE);
    });

    it('asks the database for a bounded page, not every episode', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'The Daily', author: 'NYT', description: '',
            imageUrl: null, itunesId: null, categoryIds: [], feedUrl: 'https://x/rss',
        });
        (prisma.podcastEpisode.findMany as jest.Mock).mockResolvedValue(episodes(50));

        await request(app).get('/podcasts/p1');

        const args = (prisma.podcastEpisode.findMany as jest.Mock).mock.calls[0][0];
        expect(args.take).toBe(50);
        expect(args.skip).toBe(0);
    });

    it('reports the true total so a client knows there is more', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'The Daily', author: 'NYT', description: '',
            imageUrl: null, itunesId: null, categoryIds: [], feedUrl: 'https://x/rss',
        });
        (prisma.podcastEpisode.findMany as jest.Mock).mockResolvedValue(episodes(50));

        const res = await request(app).get('/podcasts/p1');

        expect(res.status).toBe(200);
        expect(res.body.episodes).toHaveLength(50);
        expect(res.body.episodeTotal).toBe(BACK_CATALOGUE);
        expect(res.body.episodeLimit).toBe(50);
        expect(res.body.episodeOffset).toBe(0);
    });

    it('clamps an oversized limit instead of rejecting it', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'x', author: '', description: '',
            imageUrl: null, itunesId: null, categoryIds: [], feedUrl: '',
        });
        (prisma.podcastEpisode.findMany as jest.Mock).mockResolvedValue(episodes(200));

        const res = await request(app).get('/podcasts/p1?limit=99999');

        expect(res.status).toBe(200);
        const args = (prisma.podcastEpisode.findMany as jest.Mock).mock.calls[0][0];
        expect(args.take).toBe(200);
    });

    it('falls back to the default for a nonsense limit', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'x', author: '', description: '',
            imageUrl: null, itunesId: null, categoryIds: [], feedUrl: '',
        });
        (prisma.podcastEpisode.findMany as jest.Mock).mockResolvedValue(episodes(50));

        await request(app).get('/podcasts/p1?limit=banana&offset=-5');

        const args = (prisma.podcastEpisode.findMany as jest.Mock).mock.calls[0][0];
        expect(args.take).toBe(50);
        expect(args.skip).toBe(0);
    });

    it('serves the rest through GET /:id/episodes', async () => {
        (prisma.podcastEpisode.findMany as jest.Mock).mockResolvedValue(episodes(50, 100));

        const res = await request(app).get('/podcasts/p1/episodes?limit=50&offset=100');

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(BACK_CATALOGUE);
        expect(res.body.offset).toBe(100);
        expect(res.body.limit).toBe(50);
        expect(res.body.episodes).toHaveLength(50);
        const args = (prisma.podcastEpisode.findMany as jest.Mock).mock.calls[0][0];
        expect(args.take).toBe(50);
        expect(args.skip).toBe(100);
    });

    it('pages from the oldest end when asked, on both endpoints', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'x', author: '', description: '',
            imageUrl: null, itunesId: null, categoryIds: [], feedUrl: '',
        });
        (prisma.podcastEpisode.findMany as jest.Mock).mockResolvedValue(episodes(50));

        await request(app).get('/podcasts/p1?order=oldest');
        const detailArgs = (prisma.podcastEpisode.findMany as jest.Mock).mock.calls[0][0];
        expect(detailArgs.orderBy).toEqual({ publishedAt: 'asc' });

        await request(app).get('/podcasts/p1/episodes?order=oldest');
        const pageArgs = (prisma.podcastEpisode.findMany as jest.Mock).mock.calls[1][0];
        expect(pageArgs.orderBy).toEqual({ publishedAt: 'asc' });
    });

    it('keeps newest-first as the default order', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'x', author: '', description: '',
            imageUrl: null, itunesId: null, categoryIds: [], feedUrl: '',
        });
        (prisma.podcastEpisode.findMany as jest.Mock).mockResolvedValue(episodes(50));

        await request(app).get('/podcasts/p1');

        const args = (prisma.podcastEpisode.findMany as jest.Mock).mock.calls[0][0];
        expect(args.orderBy).toEqual({ publishedAt: 'desc' });
    });

    it('refuses episodes for a podcast the user is not subscribed to', async () => {
        (prisma.podcastSubscription.count as jest.Mock).mockResolvedValue(0);

        const res = await request(app).get('/podcasts/p1/episodes');

        expect(res.status).toBe(404);
        expect(prisma.podcastEpisode.findMany).not.toHaveBeenCalled();
    });
});
