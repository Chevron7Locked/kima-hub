/**
 * GET /artists orders by name on the stored `sortName`, not on an article
 * stripped inline, and every sort runs through the one list query. Real router,
 * real database; the `query` filter keeps the answer to this file's artists.
 */

import express from 'express';
import request from 'supertest';
import artistRoutes from '../artists';
import { prisma } from '../../../utils/db';
import { closeEngineConnections } from '../../../__tests__/helpers/engineConnections';

const P = 'zz-artists-sort';

// Names and stored sort names disagree on purpose, so only the stored column gives the expected order.
// `tracks` has a tie (Zebra and Dup), broken by id.
const ARTISTS = [
    { id: `${P}-1`, name: `${P} Zebra`, sortName: 'alpha', tracks: 20 },
    { id: `${P}-2`, name: `${P} The Mango`, sortName: 'mango', tracks: 30 },
    { id: `${P}-3`, name: `${P} Apple`, sortName: 'zulu', tracks: 10 },
    { id: `${P}-0`, name: `${P} Dup`, sortName: 'mango2', tracks: 20 },
];

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = { id: `${P}-user`, username: 'admin', role: 'admin' };
        next();
    });
    app.use('/', artistRoutes);
    return app;
}

beforeAll(async () => {
    for (const a of ARTISTS) {
        await prisma.artist.create({
            data: {
                id: a.id, name: a.name, normalizedName: a.name.toLowerCase(), identityKey: `${a.id}-ik`,
                sortName: a.sortName, totalTrackCount: a.tracks,
            },
        });
        // The list shows artists with a library album that has a song.
        await prisma.album.create({
            data: { id: `${a.id}-al`, rgMbid: `${a.id}-rg`, artistId: a.id, identityKey: `${a.id}-al`, title: a.name, primaryType: 'Album', location: 'LIBRARY' },
        });
        await prisma.track.create({
            data: { id: `${a.id}-t`, albumId: `${a.id}-al`, title: a.name, trackNo: 1, duration: 100, filePath: `${a.id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

const names = async (sortBy: string) => {
    const res = await request(makeApp()).get(`/artists?query=${P}&sortBy=${sortBy}`).expect(200);
    return (res.body.artists as { name: string }[]).map((a) => a.name.replace(`${P} `, ''));
};

describe('GET /artists alphabetical ordering', () => {
    // "The Mango" would sort under M by name, and "Zebra" last: only the stored column, not an article stripped
    // inline, puts Zebra first.
    it('orders name on the stored sortName column, ascending', async () => {
        expect(await names('name')).toEqual(['Zebra', 'The Mango', 'Dup', 'Apple']);
    });

    it('orders name-desc on the stored sortName column, descending', async () => {
        expect(await names('name-desc')).toEqual(['Apple', 'Dup', 'The Mango', 'Zebra']);
    });

    it('orders tracks by track count, with the id as tiebreaker, through the same query', async () => {
        expect(await names('tracks')).toEqual(['The Mango', 'Dup', 'Zebra', 'Apple']);
    });

    it('falls back to the name order for an unrecognised sortBy', async () => {
        expect(await names('nonsense')).toEqual(['Zebra', 'The Mango', 'Dup', 'Apple']);
    });
});
