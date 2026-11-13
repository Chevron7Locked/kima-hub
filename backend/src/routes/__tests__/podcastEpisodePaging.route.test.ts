/**
 * GET /podcasts/:id caps `episodes`, newest first, so old clients still render;
 * the paging endpoint serves the rest. Both read one page through the same query.
 * Real router and database.
 */
jest.mock('../../middleware/auth', () => require('./helpers/podcastRoute').podcastAuthMock('u_podpaging'));

jest.mock('../../services/rss-parser', () => ({ rssParserService: {} }));
jest.mock('../../utils/ssrf', () => ({ validateUrlForFetch: jest.fn() }));
jest.mock('axios', () => ({ default: { get: jest.fn() }, get: jest.fn() }));

import express from 'express';
import request from 'supertest';
import podcastRoutes from '../podcasts';
import { prisma } from '../../utils/db';
import { mountAsServer } from "./helpers/serverMount";

const USER = 'u_podpaging';
const SHOW = 'pod_paging_show';
const STRANGER = 'pod_paging_unsubscribed';
// More than the largest page (200), so a page cap shows.
const TOTAL = 250;
// Episode n is the n-th oldest: pg_000 is the oldest, pg_249 the newest.
const id = (n: number) => `pg_${String(n).padStart(3, '0')}`;
const ids = (episodes: Array<{ id: string }>) => episodes.map((e) => e.id);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: [SHOW, STRANGER] } } });
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: 'x' }, update: {} });
    await prisma.podcast.create({ data: { id: SHOW, feedUrl: 'https://f.invalid/paging', title: 'The Daily', author: 'NYT' } });
    await prisma.podcast.create({ data: { id: STRANGER, feedUrl: 'https://f.invalid/paging-other', title: 'Not Followed' } });
    await prisma.podcastEpisode.createMany({
        data: [
            ...range(0, TOTAL - 1).map((n) => ({
                id: id(n), podcastId: SHOW, guid: id(n), title: `Episode ${n}`, audioUrl: `https://a.invalid/${id(n)}.mp3`,
                duration: 1800, publishedAt: new Date(Date.UTC(2020, 0, 1 + n)),
            })),
            { id: 'pg_stranger', podcastId: STRANGER, guid: 'g', title: 'x', audioUrl: 'https://a.invalid/s.mp3', publishedAt: new Date() },
        ],
    });
    await prisma.podcastSubscription.create({ data: { userId: USER, podcastId: SHOW } });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: [SHOW, STRANGER] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

const app = express();
app.use(express.json());
mountAsServer(app, '/podcasts', podcastRoutes, "/api/podcasts");

describe('podcast episode paging', () => {
    it('serves a bounded page, not every episode', async () => {
        const res = await request(app).get(`/podcasts/${SHOW}`);

        expect(res.status).toBe(200);
        expect(res.body.episodes).toHaveLength(50);
        expect(res.body.episodeOffset).toBe(0);
    });

    it('reports the true total so a client knows there is more', async () => {
        const res = await request(app).get(`/podcasts/${SHOW}`);

        expect(res.status).toBe(200);
        expect(res.body.episodes).toHaveLength(50);
        expect(res.body.episodeTotal).toBe(TOTAL);
        expect(res.body.episodeLimit).toBe(50);
        expect(res.body.episodeOffset).toBe(0);
    });

    it('clamps an oversized limit instead of rejecting it', async () => {
        const res = await request(app).get(`/podcasts/${SHOW}?limit=99999`);

        expect(res.status).toBe(200);
        expect(res.body.episodes).toHaveLength(200);
        expect(res.body.episodeLimit).toBe(200);
    });

    it('falls back to the default for a nonsense limit', async () => {
        const res = await request(app).get(`/podcasts/${SHOW}?limit=banana&offset=-5`);

        expect(res.status).toBe(200);
        expect(res.body.episodes).toHaveLength(50);
        expect(res.body.episodeOffset).toBe(0);
        expect(ids(res.body.episodes)[0]).toBe(id(TOTAL - 1));
    });

    it('serves the rest through GET /:id/episodes', async () => {
        const res = await request(app).get(`/podcasts/${SHOW}/episodes?limit=50&offset=100`);

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(TOTAL);
        expect(res.body.offset).toBe(100);
        expect(res.body.limit).toBe(50);
        // Newest first: the page after 100 episodes starts at the 101st newest.
        expect(ids(res.body.episodes)).toEqual(range(TOTAL - 150, TOTAL - 101).reverse().map(id));
    });

    it('pages from the oldest end when asked, on both endpoints', async () => {
        const detail = await request(app).get(`/podcasts/${SHOW}?order=oldest`);
        expect(ids(detail.body.episodes)).toEqual(range(0, 49).map(id));

        const page = await request(app).get(`/podcasts/${SHOW}/episodes?order=oldest&limit=10&offset=5`);
        expect(ids(page.body.episodes)).toEqual(range(5, 14).map(id));
    });

    it('keeps newest-first as the default order', async () => {
        const res = await request(app).get(`/podcasts/${SHOW}`);

        expect(ids(res.body.episodes)).toEqual(range(TOTAL - 50, TOTAL - 1).reverse().map(id));
    });

    it('refuses episodes for a podcast the user is not subscribed to', async () => {
        const page = await request(app).get(`/podcasts/${STRANGER}/episodes`);
        expect(page.status).toBe(404);
        expect(page.body.episodes).toBeUndefined();

        expect((await request(app).get(`/podcasts/${STRANGER}`)).status).toBe(404);
    });
});
