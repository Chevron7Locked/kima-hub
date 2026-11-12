/**
 * GET /albums sorts by name on `sortName`, so "The Dark Side of the Moon" files
 * under D. Real router, real database; the artist filter keeps the answer to this file's rows.
 */

import express from 'express';
import request from 'supertest';
import router from '../albums';
import { prisma } from '../../../utils/db';
import { closeEngineConnections } from '../../../__tests__/helpers/engineConnections';

const P = 'zz-albums-sort';
const ARTIST = `${P}-ar`;

// Titles and sort names disagree on purpose: a sort on the title would put "The Dark Side" last.
const ALBUMS = [
    { id: `${P}-a`, title: 'The Dark Side of the Moon', sortName: 'dark side of the moon', year: 1973 },
    { id: `${P}-b`, title: 'Abbey Road', sortName: 'abbey road', year: 1969 },
    { id: `${P}-c`, title: 'Zen Arcade', sortName: 'zen arcade', year: 1984 },
];

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = { id: `${P}-user`, username: 'admin', role: 'admin' };
        next();
    });
    app.use('/', router);
    return app;
}

beforeAll(async () => {
    await prisma.artist.create({
        data: { id: ARTIST, name: P, normalizedName: P, identityKey: `${P}-ik` },
    });
    for (const a of ALBUMS) {
        await prisma.album.create({
            data: {
                id: a.id, rgMbid: `${a.id}-rg`, artistId: ARTIST, identityKey: a.id, title: a.title,
                sortName: a.sortName, year: a.year, primaryType: 'Album', location: 'LIBRARY',
            },
        });
        await prisma.track.create({
            data: { id: `${a.id}-t`, albumId: a.id, title: a.title, trackNo: 1, duration: 100, filePath: `${a.id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

const titles = async (query: string) => {
    const res = await request(makeApp()).get(`/albums?artistId=${ARTIST}${query}`).expect(200);
    return (res.body.albums as { title: string }[]).map((a) => a.title);
};

const BY_SORT_NAME = ['Abbey Road', 'The Dark Side of the Moon', 'Zen Arcade'];

describe('GET /albums alphabetical ordering', () => {
    it('orders sortBy=name (the default) on sortName, not title', async () => {
        expect(await titles('')).toEqual(BY_SORT_NAME);
        expect(await titles('&sortBy=name')).toEqual(BY_SORT_NAME);
    });

    it('orders sortBy=name-desc on sortName descending', async () => {
        expect(await titles('&sortBy=name-desc')).toEqual([...BY_SORT_NAME].reverse());
    });

    it('falls back to sortName ascending for an unrecognised sortBy', async () => {
        expect(await titles('&sortBy=nonsense')).toEqual(BY_SORT_NAME);
    });

    it('leaves sortBy=recent ordering on year, newest first', async () => {
        expect(await titles('&sortBy=recent')).toEqual(['Zen Arcade', 'The Dark Side of the Moon', 'Abbey Road']);
    });
});
