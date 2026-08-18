/**
 * GET /podcasts/:id must not return a show's entire back catalogue.
 *
 * The detail query had an orderBy and no take, while the subscription list
 * beside it was already bounded. Measured upstream against a real feed: The
 * Daily returned 2,944 episodes and 6.27 MB in one response, every time the
 * screen opened, because the payload grew with the show's AGE rather than with
 * what anyone reads.
 *
 * `episodes` keeps its name and stays newest-first so a client that predates
 * paging still renders; these tests pin that, the cap, and the companion
 * endpoint that serves the rest.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        podcastSubscription: { findUnique: jest.fn() },
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
jest.mock('../../services/podcastCache', () => ({ podcastCacheService: {} }));
jest.mock('../../services/deezer', () => ({ deezerService: {}, mergeAndDedupePodcasts: jest.fn() }));
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
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValue({ id: 'sub-1' });
        (prisma.podcastEpisode.count as jest.Mock).mockResolvedValue(BACK_CATALOGUE);
    });

    it('asks the database for a bounded page, not every episode', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'The Daily', author: 'NYT', description: '',
            imageUrl: null, feedUrl: 'https://x/rss', episodes: episodes(50),
        });

        await request(app).get('/podcasts/p1');

        // The defect was an orderBy with no take. `take` is the whole fix.
        const args = (prisma.podcast.findUnique as jest.Mock).mock.calls[0][0];
        expect(args.include.episodes.take).toBe(50);
        expect(args.include.episodes.skip).toBe(0);
    });

    it('reports the true total so a client knows there is more', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'The Daily', author: 'NYT', description: '',
            imageUrl: null, feedUrl: 'https://x/rss', episodes: episodes(50),
        });

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
            imageUrl: null, feedUrl: '', episodes: episodes(200),
        });

        const res = await request(app).get('/podcasts/p1?limit=99999');

        expect(res.status).toBe(200);
        const args = (prisma.podcast.findUnique as jest.Mock).mock.calls[0][0];
        expect(args.include.episodes.take).toBe(200);
    });

    it('falls back to the default for a nonsense limit', async () => {
        (prisma.podcast.findUnique as jest.Mock).mockResolvedValue({
            id: 'p1', title: 'x', author: '', description: '',
            imageUrl: null, feedUrl: '', episodes: episodes(50),
        });

        await request(app).get('/podcasts/p1?limit=banana&offset=-5');

        const args = (prisma.podcast.findUnique as jest.Mock).mock.calls[0][0];
        expect(args.include.episodes.take).toBe(50);
        expect(args.include.episodes.skip).toBe(0);
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

    it('refuses episodes for a podcast the user is not subscribed to', async () => {
        (prisma.podcastSubscription.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/podcasts/p1/episodes');

        expect(res.status).toBe(404);
        expect(prisma.podcastEpisode.findMany).not.toHaveBeenCalled();
    });
});
