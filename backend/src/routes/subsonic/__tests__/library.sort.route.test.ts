/**
 * Subsonic getArtists buckets and orders artists on `sortName`, so the two always
 * agree ("The Beatles" sorts within B). getAlbumList's alphabetical, genre and
 * starred lists order albums on `sortName` too. Real router, real database; the
 * answers are narrowed to this file's rows by id.
 */

import express from 'express';
import request from 'supertest';
import { libraryRouter } from '../library';
import { prisma } from '../../../utils/db';

const P = 'zz-sub-sort';
const USER = `${P}-user`;
const GENRE = `${P}-genre`;

function makeApp() {
    const app = express();
    app.use(express.json());
    // Subsonic auth is applied by the parent router in `subsonic/index.ts`, not
    // by `libraryRouter` itself, so handlers here read `req.user` as already
    // populated. Inject one rather than mounting the whole auth chain.
    app.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: 'user' };
        next();
    });
    app.use('/', libraryRouter);
    return app;
}

const ask = (path: string, query: Record<string, string> = {}) =>
    request(makeApp()).get(path).query({ f: 'json', ...query }).expect(200).then((r) => r.body['subsonic-response']);

const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const mine = <T extends { id: string }>(rows: T[]) => rows.filter((r) => r.id.startsWith(P));

// "The Beatles" buckets under B. "La Roux" buckets under R only with the multi-language article list.
// Album sort names are picked so the album order differs from the title order and from the artist order.
const SEED = [
    { key: '1', name: 'Bon Iver', displayName: null, sortName: 'bon iver', album: 'Alpha Title', albumSort: 'aaa', albumsCount: 2 },
    { key: '2', name: 'The Beatles', displayName: null, sortName: 'beatles', album: 'Beta Title', albumSort: 'zzz', albumsCount: 5 },
    { key: '3', name: 'La Roux', displayName: null, sortName: 'roux', album: 'Gamma Title', albumSort: 'ccc', albumsCount: 1 },
    // sortName follows displayName at write time (enrichmentSortName.route.test.ts), so this endpoint trusts the stored column.
    {
        key: '4', name: 'Prince', displayName: 'The Artist Formerly Known As Prince',
        // artistSortName('The Artist Formerly Known As Prince')
        sortName: 'artist formerly known as prince', album: 'Delta Title', albumSort: 'mmm', albumsCount: 3,
    },
];
const artistId = (key: string) => `${P}-ar${key}`;
const albumId = (key: string) => `${P}-al${key}`;

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
    for (const s of SEED) {
        await prisma.artist.create({
            data: {
                id: artistId(s.key), name: s.name, displayName: s.displayName, identityKey: `${P}-ik${s.key}`,
                sortName: s.sortName, libraryAlbumCount: s.albumsCount, genres: [GENRE],
            },
        });
        await prisma.album.create({
            data: {
                id: albumId(s.key), rgMbid: `${P}-rg${s.key}`, artistId: artistId(s.key), identityKey: albumId(s.key),
                title: s.album, sortName: s.albumSort, primaryType: 'Album', location: 'LIBRARY',
            },
        });
        const track = await prisma.track.create({
            data: { id: `${P}-t${s.key}`, albumId: albumId(s.key), title: s.album, trackNo: 1, duration: 100, filePath: `${P}-${s.key}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: track.id } });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

describe('subsonic getArtists / getIndexes ordering', () => {
    const indexes = async (path = '/getArtists.view') => {
        const res = await ask(path);
        const root = res.artists ?? res.indexes;
        return { root, indexes: list<{ name: string; artist: { id: string; name: string }[] }>(root.index) };
    };
    const bucketOf = (idx: { name: string; artist: { id: string }[] }[], id: string) =>
        idx.find((i) => list(i.artist).some((a: { id: string }) => a.id === id))?.name;

    it('orders artists by sortName, not the raw name', async () => {
        const { indexes: idx } = await indexes();
        const ordered = mine(idx.flatMap((i) => list(i.artist)));
        // By sortName: prince ("artist formerly..."), beatles, bon iver, roux. By raw name it would be Bon Iver first.
        expect(ordered.map((a) => a.id)).toEqual([artistId('4'), artistId('2'), artistId('1'), artistId('3')]);
    });

    it('files "The Beatles" under B and "La Roux" under R, not T and L', async () => {
        const { indexes: idx } = await indexes();
        expect(bucketOf(idx, artistId('2'))).toBe('B');
        expect(bucketOf(idx, artistId('3'))).toBe('R');
    });

    // Express routes a call whatever its letter case, so the key follows the route that answered, not the path's text.
    it('answers getArtists under artists and getIndexes under indexes, however the name is cased', async () => {
        const artists = await ask('/getartists.view');
        expect(artists.artists).toBeDefined();
        expect(artists.indexes).toBeUndefined();
        const legacy = await ask('/getINDEXES.view');
        expect(legacy.indexes).toBeDefined();
        expect(legacy.artists).toBeUndefined();
    });

    it('answers getIndexes the same way', async () => {
        const { root, indexes: idx } = await indexes('/getIndexes.view');
        expect(root).toBeDefined();
        expect(bucketOf(idx, artistId('2'))).toBe('B');
    });

    it('buckets and displays an artist under its displayName override, not its canonical name', async () => {
        const { indexes: idx } = await indexes();
        expect(bucketOf(idx, artistId('4'))).toBe('A');
        const shown = idx.flatMap((i) => list(i.artist)).find((a) => a.id === artistId('4'));
        expect(shown?.name).toBe('The Artist Formerly Known As Prince');
    });

    it('advertises ignoredArticles covering every article it actually strips', async () => {
        const res = await ask('/getArtists.view');

        // Clients use this list to render and sort locally. Advertising only
        // "The A An" while the server also strips Spanish/French/German
        // articles makes the client disagree with the server for those names.
        const advertised = String(res.artists.ignoredArticles).toLowerCase().split(/\s+/);
        for (const article of ['the', 'a', 'an', 'la', 'los', 'las', 'le', 'les', 'der', 'die', 'das']) {
            expect(advertised).toContain(article);
        }
    });
});

describe('subsonic getMusicDirectory (root) ordering', () => {
    it('orders the artist listing by sortName', async () => {
        const res = await ask('/getMusicDirectory.view', { id: '1' });
        const ids = mine(list<{ id: string }>(res.directory.child)).map((c) => c.id);
        expect(ids).toEqual([artistId('4'), artistId('2'), artistId('1'), artistId('3')]);
    });
});

describe('subsonic getAlbumList ordering', () => {
    const albums = async (query: Record<string, string>) => {
        const res = await ask('/getAlbumList.view', { size: '500', ...query });
        return mine(list<{ id: string }>(res.albumList.album)).map((a) => a.id);
    };

    it('alphabeticalByArtist orders through the artist relation by sortName', async () => {
        expect(await albums({ type: 'alphabeticalByArtist' })).toEqual([albumId('4'), albumId('2'), albumId('1'), albumId('3')]);
    });

    it("alphabeticalByName orders on the album's own sortName, not title", async () => {
        expect(await albums({ type: 'alphabeticalByName' })).toEqual([albumId('1'), albumId('3'), albumId('4'), albumId('2')]);
    });

    it('starred orders starred albums on sortName, not title', async () => {
        expect(await albums({ type: 'starred' })).toEqual([albumId('1'), albumId('3'), albumId('4'), albumId('2')]);
    });

    it('byGenre orders the genre query by sortName, not title', async () => {
        expect(await albums({ type: 'byGenre', genre: GENRE })).toEqual([albumId('1'), albumId('3'), albumId('4'), albumId('2')]);
    });
});

describe('subsonic getAlbumList paging over albums that share a sort name', () => {
    const TIES = ['c', 'a', 'b'].map((k) => `${P}-tie-${k}`);

    beforeAll(async () => {
        for (const id of TIES) {
            await prisma.album.create({
                data: { id, rgMbid: `${id}-rg`, artistId: artistId('1'), identityKey: id, title: 'Same', sortName: 'zzzz same', primaryType: 'Album', location: 'LIBRARY' },
            });
            const track = await prisma.track.create({
                data: { id: `${id}-t`, albumId: id, title: 'Same', trackNo: 1, duration: 100, filePath: `${id}.flac`, fileModified: new Date(), fileSize: 1 },
            });
            await prisma.likedTrack.create({ data: { userId: USER, trackId: track.id } });
        }
    });

    afterAll(async () => {
        await prisma.likedTrack.deleteMany({ where: { trackId: { in: TIES.map((id) => `${id}-t`) } } });
        await prisma.track.deleteMany({ where: { id: { in: TIES.map((id) => `${id}-t`) } } });
        await prisma.album.deleteMany({ where: { id: { in: TIES } } });
    });

    it.each([
        ['alphabeticalByName', {}],
        ['starred', {}],
        ['byGenre', { genre: GENRE }],
    ])('%s keeps tied albums in id order, one page at a time', async (type, extra) => {
        // The tied albums sort after every other of this file's albums, so the first of them (id order) is where their pages start.
        const all = await ask('/getAlbumList.view', { type, size: '500', ...extra });
        const ids = list<{ id: string }>(all.albumList.album).map((a) => a.id);
        const first = ids.indexOf([...TIES].sort()[0]);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(ids.slice(first, first + 3)).toEqual([...TIES].sort());
        const pages: string[] = [];
        for (let i = 0; i < 3; i++) {
            const page = await ask('/getAlbumList.view', { type, size: '1', offset: String(first + i), ...extra });
            pages.push(...list<{ id: string }>(page.albumList.album).map((a) => a.id));
        }
        expect(pages).toEqual([...TIES].sort());
    });
});
