/**
 * GET /tracks ordering. A sort column that admits ties must be followed by a unique tail (the id), or offset paging
 * can skip or repeat rows between fetches. Real router, real database.
 */

import express from 'express';
import request from 'supertest';
import router from '../tracks';
import { prisma } from '../../../utils/db';

const P = 'tsort';
const app = express();
app.use(express.json());
app.use('/', router);

async function cleanup(): Promise<void> {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}_art`, name: `${P} artist`, identityKey: `${P}_ik` } });
    await prisma.album.create({
        data: { id: `${P}_alb`, rgMbid: `${P}_rg`, artistId: `${P}_art`, title: `${P} album`, primaryType: 'Album', location: 'LIBRARY' },
    });
    // Created out of id order, so a result that happens to follow insertion order is not mistaken for the tail.
    // Three songs share a title; three share a track number (two discs).
    for (const [id, trackNo] of [['c', 1], ['a', 1], ['b', 1], ['d', 2]] as const) {
        await prisma.track.create({
            data: { id: `${P}_${id}`, albumId: `${P}_alb`, title: `!${P} same title`, trackNo, duration: 100, filePath: `${P}/${id}.flac`, fileModified: new Date(), fileSize: 10 },
        });
    }
});

afterAll(cleanup);

describe('GET /tracks ordering', () => {
    it('breaks ties in the library title sort by id', async () => {
        const res = await request(app).get('/tracks?sortBy=name&limit=100').expect(200);

        // Other rows may share the database; only the relative order of this file's songs is checked.
        const mine = res.body.tracks.map((t: { id: string }) => t.id).filter((id: string) => id.startsWith(`${P}_`));
        expect(mine).toEqual([`${P}_a`, `${P}_b`, `${P}_c`, `${P}_d`]);
    });

    it('breaks ties in the per-album track number sort by id', async () => {
        const res = await request(app).get(`/tracks?albumId=${P}_alb`).expect(200);

        expect(res.body.tracks.map((t: { id: string }) => t.id)).toEqual([`${P}_a`, `${P}_b`, `${P}_c`, `${P}_d`]);
    });

    it('pages through tied rows without skipping or repeating one', async () => {
        const seen: string[] = [];
        for (let offset = 0; offset < 4; offset += 1) {
            const res = await request(app).get(`/tracks?albumId=${P}_alb&limit=1&offset=${offset}`).expect(200);
            seen.push(...res.body.tracks.map((t: { id: string }) => t.id));
        }
        expect(seen).toEqual([`${P}_a`, `${P}_b`, `${P}_c`, `${P}_d`]);
    });
});
