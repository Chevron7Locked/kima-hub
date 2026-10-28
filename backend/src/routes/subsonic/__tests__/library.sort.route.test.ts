/**
 * Subsonic getArtists buckets and orders artists on `sortName`, so the two always
 * agree ("The Beatles" sorts within B). getAlbumList's alphabetical, genre and
 * starred lists order albums on `sortName` too.
 */

jest.mock('../../../utils/db', () => ({
    prisma: {
        artist: { findMany: jest.fn() },
        album: { findMany: jest.fn() },
        $queryRaw: jest.fn(),
    },
    Prisma: jest.requireActual('@prisma/client').Prisma,
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

// "The Beatles" buckets under B. "La Roux" buckets under R only with the
// multi-language article list.
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

        // Ordering and bucketing must come from the same value, `sortName`.
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

    // sortName follows displayName at write time (enrichmentSortName.route.test.ts),
    // so this endpoint trusts the stored column.
    it('buckets and displays an artist under its displayName override, not its canonical name', async () => {
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([
            {
                id: 'a4', name: 'Prince', displayName: 'The Artist Formerly Known As Prince',
                heroUrl: null, libraryAlbumCount: 3,
                // artistSortName('The Artist Formerly Known As Prince')
                sortName: 'artist formerly known as prince',
            },
        ]);

        const res = await request(makeApp()).get('/getArtists.view').expect(200);

        expect(res.text).toContain('<index name="A">');
        expect(res.text).not.toContain('<index name="P">');
        expect(res.text).toContain('name="The Artist Formerly Known As Prince"');
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

describe('subsonic getAlbumList alphabeticalByName', () => {
    it('orders on the album\'s own sortName, not title', async () => {
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);

        await request(makeApp())
            .get('/getAlbumList.view?type=alphabeticalByName')
            .expect(200);

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: 'asc' } }),
        );
    });
});

describe('subsonic getAlbumList starred', () => {
    it('orders starred albums on sortName, not title', async () => {
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);

        await request(makeApp())
            .get('/getAlbumList.view?type=starred')
            .expect(200);

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: 'asc' } }),
        );
    });
});

describe('subsonic getAlbumList byGenre', () => {
    it('orders the raw-SQL genre query by sortName, not title', async () => {
        (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

        await request(makeApp())
            .get('/getAlbumList.view?type=byGenre&genre=rock')
            .expect(200);

        // The request runs two queries: the artists carrying the genre, then the album list they
        // answer for. The sort order under test is the album list's — the last raw query.
        const calls = (prisma.$queryRaw as jest.Mock).mock.calls;
        const sql: string = calls[calls.length - 1][0].sql;
        expect(sql).toContain('FROM "Album"');
        expect(sql).toContain('a."sortName" ASC');
        expect(sql).not.toContain('a.title ASC');
    });
});
