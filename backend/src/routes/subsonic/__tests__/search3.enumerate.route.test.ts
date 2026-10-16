/**
 * OpenSubsonic clients sync by paginating search3 over an empty query
 * (query=, a missing query, or the literal "" some clients send). The
 * endpoint must enumerate the library in a stable order so pages tile
 * without overlap, and keep DISCOVER content out. Real database, real
 * router; only Subsonic auth is injected, as the parent router would.
 */

import express from 'express';
import request from 'supertest';
import { prisma } from '../../../utils/db';
import { searchRouter } from '../search';

const MARK = 'zz-enumerate';

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: 'test-user', username: 'tester', role: 'user' };
        next();
    });
    app.use('/', searchRouter);
    return app;
}

let artistId: string;
let libraryAlbumId: string;

beforeAll(async () => {
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });

    const artist = await prisma.artist.create({
        data: {
            name: `${MARK} Artist`,
            identityKey: `${MARK}-artist`,
            libraryAlbumCount: 2,
        },
    });
    artistId = artist.id;

    const album = await prisma.album.create({
        data: {
            rgMbid: `${MARK}-lib-rgmbid`,
            identityKey: `${MARK}-lib`,
            primaryType: 'Album',
            title: `${MARK} Library`,
            artistId,
            location: 'LIBRARY',
            year: 2020,
        },
    });
    libraryAlbumId = album.id;
    await prisma.album.create({
        data: {
            rgMbid: `${MARK}-disc-rgmbid`,
            identityKey: `${MARK}-disc`,
            primaryType: 'Album',
            title: `${MARK} Discovery`,
            artistId,
            location: 'DISCOVER',
            year: 2021,
        },
    });

    const titles = [`${MARK} Beta`, `${MARK} alpha`, `${MARK} CHARLIE`];
    await prisma.track.createMany({
        data: [
            ...titles.map((title, i) => ({
                title,
                albumId: libraryAlbumId,
                trackNo: i + 1,
                duration: 100,
                filePath: `/${MARK}/${i}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            })),
            // Persisted shapes the enumeration query must exclude.
            {
                title: `${MARK} Delta`,
                albumId: libraryAlbumId,
                trackNo: 4,
                duration: 100,
                filePath: `/${MARK}/4.flac`,
                fileModified: new Date(),
                fileSize: 1000,
                corrupt: true,
            },
            {
                title: `${MARK} Echo`,
                albumId: libraryAlbumId,
                trackNo: 5,
                duration: 100,
                filePath: `/${MARK}/5.flac`,
                fileModified: new Date(),
                fileSize: 1000,
                missingSince: new Date(),
            },
        ],
    });
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
});

function songs(body: any): { id: string; title: string }[] {
    return body['subsonic-response'].searchResult3.song ?? [];
}

describe('search3 empty-query library enumeration', () => {
    it('answers an empty query with the library in case-insensitive title order', async () => {
        const res = await request(makeApp())
            .get('/search3.view')
            .query({ u: 'tester', query: '', songCount: 10, f: 'json' })
            .expect(200);

        const list = songs(res.body);
        expect(list.map((s) => s.title)).toEqual([
            `${MARK} alpha`,
            `${MARK} Beta`,
            `${MARK} CHARLIE`,
        ]);
    });

    it('keeps corrupt and missing tracks out of the enumeration', async () => {
        const res = await request(makeApp())
            .get('/search3.view')
            .query({ u: 'tester', query: '', songCount: 50, f: 'json' })
            .expect(200);

        const titles = songs(res.body).map((s) => s.title);
        expect(titles).not.toContain(`${MARK} Delta`);
        expect(titles).not.toContain(`${MARK} Echo`);
    });

    it('tiles pages without overlap', async () => {
        const page1 = songs(
            (
                await request(makeApp())
                    .get('/search3.view')
                    .query({ query: '', songCount: 2, songOffset: 0, f: 'json' })
                    .expect(200)
            ).body
        );
        const page2 = songs(
            (
                await request(makeApp())
                    .get('/search3.view')
                    .query({ query: '', songCount: 2, songOffset: 2, f: 'json' })
                    .expect(200)
            ).body
        );

        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(1);
        const ids = new Set([...page1, ...page2].map((s) => s.id));
        expect(ids.size).toBe(3);
    });

    it('treats the literal two-quote query as empty', async () => {
        const res = await request(makeApp())
            .get('/search3.view')
            .query({ query: '""', songCount: 10, f: 'json' })
            .expect(200);

        expect(songs(res.body)).toHaveLength(3);
    });

    it('lists library artists and albums, keeping DISCOVER out', async () => {
        const res = await request(makeApp())
            .get('/search3.view')
            .query({ query: '', artistCount: 5, albumCount: 5, songCount: 0, f: 'json' })
            .expect(200);

        const result = res.body['subsonic-response'].searchResult3;
        expect(result.artist.map((a: any) => a.id)).toEqual([artistId]);
        expect(result.album.map((al: any) => al.id)).toEqual([libraryAlbumId]);
    });

    it('keeps ranked search for a real query', async () => {
        const res = await request(makeApp())
            .get('/search3.view')
            .query({ query: `${MARK} alpha`, songCount: 10, f: 'json' })
            .expect(200);

        const list = songs(res.body);
        expect(list).toHaveLength(1);
        expect(list[0].title).toBe(`${MARK} alpha`);
    });
});

describe('each search endpoint answers under its own key', () => {
    it.each([
        ['/search3.view', 'searchResult3'],
        ['/search2.view', 'searchResult2'],
        ['/search.view', 'searchResult'],
    ])('%s answers under %s', async (path, key) => {
        const res = await request(makeApp())
            .get(path)
            .query({ u: 'tester', query: '', songCount: 10, f: 'json' })
            .expect(200);
        const answer = res.body['subsonic-response'];
        expect(Object.keys(answer)).toContain(key);
        for (const other of ['searchResult3', 'searchResult2', 'searchResult'].filter((k) => k !== key)) {
            expect(answer[other]).toBeUndefined();
        }
    });
});
