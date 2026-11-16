/**
 * getAlbumList and getAlbumList2 `newest` (and an unknown type, which answers the same list) order albums by when
 * they first arrived, newest first, with the album id breaking a tie so pages never repeat or skip an album. A
 * later sync of an old album does not move it. Real router, real database; answers are narrowed to this file's rows.
 */

import express from 'express';
import request from 'supertest';
import { libraryRouter } from '../library';
import { prisma } from '../../../utils/db';

const P = 'zz-sub-newest';
const USER = `${P}-user`;

const app = express()
    .use(express.json())
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: 'user' }; next(); })
    .use('/', libraryRouter);

const ask = (path: string, query: Record<string, string>) =>
    request(app).get(path).query({ f: 'json', ...query }).expect(200).then((r) => r.body['subsonic-response']);

const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

const at = (minutesAgo: number) => new Date(Date.UTC(2031, 0, 1) - minutesAgo * 60_000);
// Arrival order, newest first: c, then the tied a and b (id order), then d. d's sync time is the latest of all.
const SEED = [
    { key: 'a', arrived: 5, synced: 5 },
    { key: 'b', arrived: 5, synced: 5 },
    { key: 'c', arrived: 1, synced: 1 },
    { key: 'd', arrived: 90, synced: -50 },
];
const id = (key: string) => `${P}-al-${key}`;
const EXPECTED = [id('c'), id('a'), id('b'), id('d')];

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    for (const s of SEED) {
        await prisma.album.create({
            data: {
                id: id(s.key), rgMbid: `${id(s.key)}-rg`, artistId: `${P}-ar`, identityKey: id(s.key), title: id(s.key),
                primaryType: 'Album', location: 'LIBRARY', createdAt: at(s.arrived), lastSynced: at(s.synced),
            },
        });
        await prisma.track.create({
            data: { id: `${id(s.key)}-t`, albumId: id(s.key), title: s.key, trackNo: 1, duration: 100, filePath: `${P}-${s.key}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

// Other tests' rows share the table, so pages are asked for in full and then narrowed to this file's albums.
const mine = async (path: string, query: Record<string, string>) => {
    const body = await ask(path, { size: '500', ...query });
    const albums = list<{ id: string }>(body.albumList2?.album ?? body.albumList?.album);
    return albums.map((a) => a.id).filter((x) => x.startsWith(P));
};

describe.each(['/getAlbumList2.view', '/getAlbumList.view'])('%s', (path) => {
    it.each([{ type: 'newest' }, { type: 'nonsense' }])('lists $type albums by arrival, an id breaking the tie', async (query) => {
        expect(await mine(path, query)).toEqual(EXPECTED);
    });
});

/**
 * The two calls answer two shapes: getAlbumList2 lists AlbumID3 (`name`, `songCount`, `duration`), and the legacy
 * getAlbumList lists albums as Child folders (`title`, `parent`, `isDir`) under their artist, as getMusicDirectory does.
 */
describe('the shape of an album in the list', () => {
    const entry = async (path: string, key: 'albumList' | 'albumList2') => {
        const body = await ask(path, { size: '500' });
        return list<Record<string, unknown>>(body[key].album).find((a) => a.id === id('c'))!;
    };

    it('is an AlbumID3 in getAlbumList2', async () => {
        expect(await entry('/getAlbumList2.view', 'albumList2')).toMatchObject({ name: id('c'), artistId: `${P}-ar`, songCount: 1 });
    });

    // Express routes a call whatever its letter case, so the shape follows the route that answered, not the path's text.
    it('is an AlbumID3 for getAlbumList2 however its name is cased', async () => {
        expect(await entry('/getalbumlist2.view', 'albumList2')).toMatchObject({ name: id('c'), songCount: 1 });
    });

    it('is a Child folder in the legacy getAlbumList', async () => {
        const album = await entry('/getAlbumList.view', 'albumList');

        expect(album).toMatchObject({ title: id('c'), album: id('c'), parent: `${P}-ar`, isDir: true, artist: P, artistId: `${P}-ar` });
        expect(album).not.toHaveProperty('songCount');
        expect(album).not.toHaveProperty('name');
    });
});

it('pages newest albums without repeating or skipping one across pages', async () => {
    // A page at a time from the top, until this file's albums have all appeared (their dates sort them first):
    // each comes out once, in order.
    const seen: string[] = [];
    for (let offset = 0; seen.filter((x) => x.startsWith(P)).length < EXPECTED.length; offset += 3) {
        const body = await ask('/getAlbumList2.view', { type: 'newest', size: '3', offset: String(offset) });
        const page = list<{ id: string }>(body.albumList2?.album).map((a) => a.id);
        seen.push(...page);
        if (page.length < 3) break;
    }
    expect(seen.filter((x) => x.startsWith(P))).toEqual(EXPECTED);
    expect(new Set(seen).size).toBe(seen.length);
});
