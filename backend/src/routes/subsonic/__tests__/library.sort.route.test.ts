/**
 * Subsonic artist ordering + index bucketing.
 *
 * These endpoints had no coverage at all. Written to pin the ordering
 * behaviour BEFORE it changed, including the defect: `getArtists` bucketed
 * artists into A-Z indexes using an article-stripped key but ordered the
 * underlying query by the raw `name`, so "The Beatles" landed in the "B"
 * bucket and then sorted to the BOTTOM of it, after every genuine B artist.
 *
 * `Artist.sortName` is the canonical article-stripped value -- populated on
 * write by `artistSortName`, backfilled by the `artist_identity` migration,
 * NOT NULL, and indexed. It is what both the ordering and the bucketing now
 * use, so the two cannot disagree again.
 */

jest.mock('../../../utils/db', () => ({
    prisma: {
        artist: { findMany: jest.fn() },
        album: { findMany: jest.fn() },
    },
}));

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { libraryRouter } from '../library';
import { prisma } from '../../../utils/db';

function makeApp() {
    const app = express();
    app.use(express.json());
    // Subsonic auth is applied by the parent router in `subsonic/index.ts`, not
    // by `libraryRouter` itself, so handlers here read `req.user` as already
    // populated. Inject one rather than mounting the whole auth chain.
    app.use((req: any, _res, next) => {
        req.user = { id: 'test-user', username: 'tester', role: 'user' };
        next();
    });
    app.use('/', libraryRouter);
    return app;
}

// Deliberately includes an artist whose article-stripped name sorts into a
// different bucket than its raw name would ("The Beatles" -> B, not T).
// "La Roux" is the load-bearing fixture: the English-only stripper leaves it
// as "La Roux" and files it under L, while the canonical multi-language one
// yields "roux" and files it under R. "Los Lobos" would NOT prove this -- it
// buckets to L either way, since "Lobos" also starts with L.
const ARTISTS = [
    { id: 'a1', name: 'Bon Iver', displayName: null, heroUrl: null, libraryAlbumCount: 2, sortName: 'bon iver' },
    { id: 'a2', name: 'The Beatles', displayName: null, heroUrl: null, libraryAlbumCount: 5, sortName: 'beatles' },
    { id: 'a3', name: 'La Roux', displayName: null, heroUrl: null, libraryAlbumCount: 1, sortName: 'roux' },
];

beforeEach(() => {
    jest.clearAllMocks();
});

describe('subsonic getArtists / getIndexes ordering', () => {
    it('orders the underlying query by sortName, not the raw name', async () => {
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);

        await request(makeApp()).get('/getArtists.view').expect(200);

        // The ordering and the bucketing must come from the same value. Asking
        // Postgres for `name` order and then bucketing on a stripped key is
        // exactly the defect this pins.
        expect(prisma.artist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: 'asc' } }),
        );
    });

    it('selects sortName, since the bucket is derived from it', async () => {
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);

        await request(makeApp()).get('/getArtists.view').expect(200);

        const arg = (prisma.artist.findMany as jest.Mock).mock.calls[0][0];
        expect(arg.select).toEqual(expect.objectContaining({ sortName: true }));
    });

    it('files "The Beatles" under B and "La Roux" under R, not T and L', async () => {
        (prisma.artist.findMany as jest.Mock).mockResolvedValue(ARTISTS);

        // Subsonic answers XML unless a client asks for JSON, so assert on the
        // wire format these clients actually receive.
        const res = await request(makeApp()).get('/getArtists.view').expect(200);

        expect(res.text).toContain('<index name="B">');
        expect(res.text).toContain('<index name="R">');
        expect(res.text).not.toContain('<index name="T">');
        expect(res.text).not.toContain('<index name="L">');
    });

    it('advertises ignoredArticles covering every article it actually strips', async () => {
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);

        const res = await request(makeApp()).get('/getArtists.view').expect(200);

        // Clients use this list to render and sort locally. Advertising only
        // "The A An" while the server also strips Spanish/French/German
        // articles makes the client disagree with the server for those names.
        const match = res.text.match(/ignoredArticles="([^"]*)"/);
        expect(match).not.toBeNull();
        const advertised = match![1].toLowerCase().split(/\s+/);
        for (const article of ['the', 'a', 'an', 'la', 'los', 'las', 'le', 'les', 'der', 'die', 'das']) {
            expect(advertised).toContain(article);
        }
    });
});

describe('subsonic getMusicDirectory (root) ordering', () => {
    it('orders the artist listing by sortName', async () => {
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);

        await request(makeApp()).get('/getMusicDirectory.view?id=1').expect(200);

        expect(prisma.artist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: 'asc' } }),
        );
    });
});

describe('subsonic getAlbumList alphabeticalByArtist', () => {
    it('orders through the artist relation by sortName', async () => {
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);

        await request(makeApp())
            .get('/getAlbumList.view?type=alphabeticalByArtist')
            .expect(200);

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { artist: { sortName: 'asc' } } }),
        );
    });
});
