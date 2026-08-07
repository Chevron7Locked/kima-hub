/**
 * GET /albums ordering.
 *
 * Same defect family as artists.sort.route.test.ts, on Album this time:
 * `ALBUM_SORT_MAP`'s `name`/`name-desc` entries ordered on the raw `title`,
 * so "The Dark Side of the Moon" filed under T. Unlike
 * routes/library/artists.ts, there is no raw-SQL branch here bypassing the
 * map for the default sortBy -- checked directly against the source, not
 * assumed from the artist file's shape.
 */

jest.mock('../../../middleware/auth', () => ({
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'admin', username: 'admin', role: 'admin' };
        next();
    },
}));

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../services/deezer', () => ({ deezerService: {} }));
jest.mock('../../../services/lidarr', () => ({ lidarrService: {} }));

jest.mock('../../../utils/db', () => ({
    prisma: {
        album: { findMany: jest.fn(), count: jest.fn() },
        ownedAlbum: { findMany: jest.fn() },
    },
    Prisma: { SortOrder: { asc: 'asc', desc: 'desc' } },
}));

import express from 'express';
import request from 'supertest';
import router from '../albums';
import { prisma } from '../../../utils/db';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.album.count as jest.Mock).mockResolvedValue(0);
    (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValue([]);
});

describe('GET /albums alphabetical ordering', () => {
    it('orders sortBy=name (the default) on sortName, not title', async () => {
        await request(makeApp()).get('/albums').expect(200);

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: 'asc' } }),
        );
    });

    it('orders sortBy=name-desc on sortName descending', async () => {
        await request(makeApp()).get('/albums?sortBy=name-desc').expect(200);

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: 'desc' } }),
        );
    });

    it('falls back to sortName ascending for an unrecognised sortBy', async () => {
        await request(makeApp()).get('/albums?sortBy=nonsense').expect(200);

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: 'asc' } }),
        );
    });

    it('leaves sortBy=recent ordering on year, untouched by this fix', async () => {
        await request(makeApp()).get('/albums?sortBy=recent').expect(200);

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { year: 'desc' } }),
        );
    });
});
