/**
 * POST /share and DELETE /share/:token (authenticated); the cover route. GET /share/:token is in publicShare.route.test.ts. Streaming and cover
 * routes need real files and are left out; their path guard is tested directly.
 * Real router, real auth and real database.
 */

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import shareRoutes from '../../routes/share';
import { prisma } from '../../utils/db';
import { redisClient } from '../../utils/redis';
import { coversBasePath } from '../../services/imageStorage';
import { config } from '../../config';
import { mountAsServer } from "./helpers/serverMount";

const JWT_SECRET = process.env.JWT_SECRET!;
const TAG = 'zz-share-route';
const OWNER = `${TAG}-owner`;
const OTHER = `${TAG}-other`;
const TOKEN = `${TAG}-token`;

const app = express();
app.use(express.json());
mountAsServer(app, '/share', shareRoutes, "/api/share");

/** A signed-in user's token; both users are seeded with token version 0. */
function userToken(userId: string) {
    return jwt.sign({ userId, username: userId, role: 'user', tokenVersion: 0 }, JWT_SECRET, { expiresIn: '24h' });
}

let trackId: string;

const clean = async () => {
    await prisma.shareLink.deleteMany({ where: { createdBy: { in: [OWNER, OTHER] } } });
    await prisma.user.deleteMany({ where: { id: { in: [OWNER, OTHER] } } });
    await prisma.track.deleteMany({ where: { album: { rgMbid: { startsWith: TAG } } } });
    await prisma.album.deleteMany({ where: { rgMbid: { startsWith: TAG } } });
    await prisma.artist.deleteMany({ where: { identityKey: TAG } });
};

beforeAll(async () => {
    await clean();
    for (const id of [OWNER, OTHER]) {
        await prisma.user.create({ data: { id, username: id, passwordHash: 'x' } });
    }
    const artist = await prisma.artist.create({ data: { name: 'The Artist', normalizedName: TAG, identityKey: TAG } });
    const album = await prisma.album.create({
        data: { rgMbid: TAG, artistId: artist.id, title: 'The Album', primaryType: 'Album', location: 'LIBRARY' },
    });
    trackId = (await prisma.track.create({ data: { albumId: album.id, title: 'The Track', duration: 100, trackNo: 1, filePath: `/${TAG}/1.flac`, fileModified: new Date(), fileSize: 1 } })).id;
});

afterAll(clean);

beforeEach(() => prisma.shareLink.deleteMany({ where: { createdBy: { in: [OWNER, OTHER] } } }));

const sharesBy = (userId: string) => prisma.shareLink.findMany({ where: { createdBy: userId } });

describe('POST /share -- create share link', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await request(app)
            .post('/share')
            .send({ entityType: 'track', entityId: trackId });
        expect(res.status).toBe(401);
        expect(await sharesBy(OWNER)).toHaveLength(0);
    });

    it('returns 400 when entityType is missing', async () => {
        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken(OWNER)}`)
            .send({ entityId: trackId });
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it('returns 400 for invalid entityType', async () => {
        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken(OWNER)}`)
            .send({ entityType: 'podcast', entityId: 'ep-1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('entityType must be playlist, track, or album');
        expect(await sharesBy(OWNER)).toHaveLength(0);
    });

    it('returns 404 when track does not exist', async () => {
        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken(OWNER)}`)
            .send({ entityType: 'track', entityId: `${TAG}-missing-track` });
        expect(res.status).toBe(404);
        expect(await sharesBy(OWNER)).toHaveLength(0);
    });

    it('returns 404 for a song or album with nothing to play: Discover, missing or corrupt', async () => {
        const artist = await prisma.artist.findFirstOrThrow({ where: { identityKey: TAG } });
        const discover = await prisma.album.create({
            data: { rgMbid: `${TAG}-d`, identityKey: `${TAG}-d`, artistId: artist.id, title: 'Suggested', primaryType: 'Album', location: 'DISCOVER' },
        });
        const library = await prisma.album.create({
            data: { rgMbid: `${TAG}-gone`, identityKey: `${TAG}-gone`, artistId: artist.id, title: 'Gone', primaryType: 'Album', location: 'LIBRARY' },
        });
        const song = (albumId: string, n: number, data: object = {}) =>
            prisma.track.create({ data: { albumId, title: `Song ${n}`, duration: 100, trackNo: n, filePath: `/${TAG}/${albumId}-${n}.flac`, fileModified: new Date(), fileSize: 1, ...data } });
        const suggested = await song(discover.id, 1);
        const missing = await song(library.id, 1, { missingSince: new Date() });
        const corrupt = await song(library.id, 2, { corrupt: true });

        const asks = [
            { entityType: 'track', entityId: suggested.id },
            { entityType: 'track', entityId: missing.id },
            { entityType: 'track', entityId: corrupt.id },
            { entityType: 'album', entityId: discover.id },
            { entityType: 'album', entityId: library.id },
        ];
        for (const body of asks) {
            const res = await request(app).post('/share').set('Authorization', `Bearer ${userToken(OWNER)}`).send(body);
            expect([body.entityId, res.status]).toEqual([body.entityId, 404]);
        }
        expect(await sharesBy(OWNER)).toHaveLength(0);
    });

    it('creates and returns a share token for a valid track', async () => {
        const res = await request(app)
            .post('/share')
            .set('Authorization', `Bearer ${userToken(OWNER)}`)
            .send({ entityType: 'track', entityId: trackId });
        expect(res.status).toBe(200);
        expect(res.body.url).toBe(`/share/${res.body.token}`);
        const rows = await sharesBy(OWNER);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ token: res.body.token, entityType: 'track', entityId: trackId });
    });

    it('creates the link on a second try when the first lost a transaction conflict, a deadlock as much as a write conflict', async () => {
        const conflict = Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } });
        const transaction = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(conflict as never);
        try {
            const res = await request(app)
                .post('/share')
                .set('Authorization', `Bearer ${userToken(OWNER)}`)
                .send({ entityType: 'track', entityId: trackId });
            expect(res.status).toBe(200);
            expect(transaction).toHaveBeenCalledTimes(2);
            expect(await sharesBy(OWNER)).toHaveLength(1);
        } finally {
            transaction.mockRestore();
        }
    });

    it('answers 409 "please retry", not a server error, when both runs lost a transaction conflict, and makes no link', async () => {
        const conflict = Object.assign(new Error('could not serialize access'), { code: 'P2034' });
        const transaction = jest.spyOn(prisma, '$transaction').mockRejectedValue(conflict as never);
        try {
            const res = await request(app)
                .post('/share')
                .set('Authorization', `Bearer ${userToken(OWNER)}`)
                .send({ entityType: 'track', entityId: trackId });
            expect(res.status).toBe(409);
            expect(res.body.error).toMatch(/retry/i);
            expect(transaction).toHaveBeenCalledTimes(2);
            expect(await sharesBy(OWNER)).toHaveLength(0);
        } finally {
            transaction.mockRestore();
        }
    });

    it('still answers 500 for a failure that is no conflict', async () => {
        const transaction = jest.spyOn(prisma, '$transaction').mockRejectedValue(new Error('connection lost') as never);
        try {
            const res = await request(app)
                .post('/share')
                .set('Authorization', `Bearer ${userToken(OWNER)}`)
                .send({ entityType: 'track', entityId: trackId });
            expect(res.status).toBe(500);
            expect(transaction).toHaveBeenCalledTimes(1);
        } finally {
            transaction.mockRestore();
        }
    });
});

describe('DELETE /share/:token -- revoke share link', () => {
    const seedLink = (createdBy: string) =>
        prisma.shareLink.create({ data: { token: TOKEN, entityType: 'track', entityId: trackId, createdBy } });

    it('returns 401 when not authenticated', async () => {
        await seedLink(OWNER);
        const res = await request(app).delete(`/share/${TOKEN}`);
        expect(res.status).toBe(401);
        expect(await sharesBy(OWNER)).toHaveLength(1);
    });

    it('returns 404 when token does not exist', async () => {
        const res = await request(app)
            .delete('/share/ghost-token')
            .set('Authorization', `Bearer ${userToken(OWNER)}`);
        expect(res.status).toBe(404);
    });

    it('returns 403 when authenticated user is not the link owner', async () => {
        await seedLink(OTHER);

        const res = await request(app)
            .delete(`/share/${TOKEN}`)
            .set('Authorization', `Bearer ${userToken(OWNER)}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Not the link owner');
        expect(await sharesBy(OTHER)).toHaveLength(1);
    });

    it('revokes successfully when owner deletes their link', async () => {
        await seedLink(OWNER);

        const res = await request(app)
            .delete(`/share/${TOKEN}`)
            .set('Authorization', `Bearer ${userToken(OWNER)}`);
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Share link revoked');
        expect(await sharesBy(OWNER)).toHaveLength(0);
    });
});

describe('GET /share/:token/cover-art/:coverArtId', () => {
    const coverUrl = (id: string, token = TOKEN) => `/share/${token}/cover-art/${encodeURIComponent(id)}`;
    const made: string[] = [];
    const putFile = (full: string) => {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, 'cover bytes');
        made.push(full);
    };
    // The share's own album carries whichever cover a test is about; the file may or may not be on disk.
    const setCover = (cover: string | null) => prisma.album.update({ where: { rgMbid: TAG }, data: { coverUrl: cover } });

    beforeEach(() => prisma.shareLink.create({ data: { token: TOKEN, entityType: 'track', entityId: trackId, createdBy: OWNER } }));
    afterEach(async () => {
        for (const full of made.splice(0)) fs.rmSync(full, { force: true });
        await setCover(null);
    });

    it('answers a cover id holding a lone percent sign with 404, not a server error', async () => {
        await setCover('native:50%off');
        const res = await request(app).get(coverUrl('native:50%off'));
        expect(res.status).toBe(404);
    });

    it('serves a stored cover whose name holds a lone percent sign', async () => {
        // The 404 above means "no such file" only if a file by that name is found when it exists.
        const id = `native:albums/${TAG}-50%off.jpg`;
        putFile(path.join(coversBasePath(), 'albums', `${TAG}-50%off.jpg`));
        await setCover(id);

        const res = await request(app).get(coverUrl(id));
        expect(res.status).toBe(200);
    });

    it('keeps a versioned cover for good, found without its version', async () => {
        const id = `native:albums/${TAG}-versioned.jpg?v=abc123def0`;
        putFile(path.join(coversBasePath(), 'albums', `${TAG}-versioned.jpg`));
        await setCover(id);

        const res = await request(app).get(coverUrl(id));

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('serves the same stored cover to a page that holds an older version of its address', async () => {
        // The cover was stored again after the page loaded: its old address must still show the picture.
        putFile(path.join(coversBasePath(), 'albums', `${TAG}-moved-on.jpg`));
        await setCover(`native:albums/${TAG}-moved-on.jpg?v=1111111111`);

        const res = await request(app).get(coverUrl(`native:albums/${TAG}-moved-on.jpg?v=0000000000`));

        expect(res.status).toBe(200);
    });

    it('still refuses a versioned address of a cover the share does not hold', async () => {
        putFile(path.join(coversBasePath(), 'albums', `${TAG}-other.jpg`));
        await setCover(`native:albums/${TAG}-mine.jpg?v=1111111111`);

        const res = await request(app).get(coverUrl(`native:albums/${TAG}-other.jpg?v=1111111111`));

        expect(res.status).toBe(404);
    });

    it('asks the client to revalidate a stored cover without a version, so a changed cover is sent again and an unchanged one is not', async () => {
        const id = `native:albums/${TAG}-revalidate.jpg`;
        const full = path.join(coversBasePath(), 'albums', `${TAG}-revalidate.jpg`);
        putFile(full);
        await setCover(id);

        const first = await request(app).get(coverUrl(id));
        expect(first.status).toBe(200);
        expect(first.headers['cache-control']).toBe('public, no-cache');
        expect(first.headers['cache-control']).not.toContain('immutable');

        const again = await request(app).get(coverUrl(id)).set('If-None-Match', first.headers.etag);
        expect(again.status).toBe(304);

        fs.writeFileSync(full, 'a changed cover');
        const changed = await request(app).get(coverUrl(id)).set('If-None-Match', first.headers.etag);
        expect(changed.status).toBe(200);
        expect(Buffer.from(changed.body).toString()).toBe('a changed cover');
    });

    describe('at a size', () => {
        const noisy = async (width: number, height: number) => {
            const noise = Buffer.alloc(width * height * 3);
            for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
            return sharp(noise, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
        };
        const widthOf = async (res: request.Response) => (await sharp(Buffer.from(res.body)).metadata()).width;
        const sized = async (name: string) => {
            const id = `native:albums/${TAG}-${name}.jpg`;
            const full = path.join(coversBasePath(), 'albums', `${TAG}-${name}.jpg`);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, await noisy(600, 400));
            made.push(full, full.replace(/\.jpg$/, '_w300.jpg'));
            await setCover(id);
            return { id, full, copy: full.replace(/\.jpg$/, '_w300.jpg') };
        };

        it('scales a wider cover to the size asked for', async () => {
            const { id } = await sized('scale');

            const res = await request(app).get(`${coverUrl(id)}?size=300`);

            expect(res.status).toBe(200);
            expect(await widthOf(res)).toBe(300);
        });

        it('makes the smaller copy again when it is older than its cover', async () => {
            const { id, copy } = await sized('stale');
            fs.writeFileSync(copy, await sharp({ create: { width: 300, height: 200, channels: 3, background: 'red' } }).jpeg().toBuffer());
            const past = new Date(Date.now() - 3_600_000);
            fs.utimesSync(copy, past, past);

            const res = await request(app).get(`${coverUrl(id)}?size=300`);

            expect((await sharp(Buffer.from(res.body)).stats()).dominant).not.toEqual({ r: 255, g: 0, b: 0 });
            expect(fs.statSync(copy).mtimeMs).toBeGreaterThan(past.getTime());
        });

        it('serves a smaller copy that is as new as its cover as it is', async () => {
            const { id, copy } = await sized('fresh');
            await request(app).get(`${coverUrl(id)}?size=300`);
            const before = fs.statSync(copy).mtimeMs;

            const res = await request(app).get(`${coverUrl(id)}?size=300`);

            expect(res.status).toBe(200);
            expect(fs.statSync(copy).mtimeMs).toBe(before);
            expect(res.headers['cache-control']).toBe('public, no-cache');
        });
    });

    it('answers 404 when the cover file is gone between the check and the send', async () => {
        const id = `native:albums/${TAG}-vanished.jpg`;
        await setCover(id);
        const vanished = path.join(coversBasePath(), 'albums', `${TAG}-vanished.jpg`);
        const real = fs.existsSync;
        const spy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => (String(p) === vanished ? true : real(p)));

        const res = await request(app).get(coverUrl(id));
        spy.mockRestore();

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Cover art not found' });
    });

    it('refuses a cover id that climbs out of the covers folder, though a file is there', async () => {
        // The file exists and the share's album holds the id, so only the path guard can be the reason for the 404.
        const outside = path.join(coversBasePath(), '..', `${TAG}-outside-50%off.jpg`);
        putFile(outside);
        expect(fs.existsSync(outside)).toBe(true);
        const id = `native:../${path.basename(outside)}`;
        await setCover(id);

        const res = await request(app).get(coverUrl(id));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Cover art not found' });
    });

    it("a page's covers do not use up the budget for opening the share", async () => {
        // The resolve limit is 60 a minute per address; a playlist page asks for one cover per song.
        for (let i = 0; i < 61; i++) {
            const res = await request(app).get(coverUrl(`native:albums/${TAG}-none-${i}.jpg`));
            expect([i, res.status]).toEqual([i, 404]);
        }

        const resolve = await request(app).get(`/share/${TOKEN}`);

        expect(resolve.status).toBe(200);
    });

    describe('only what the share holds', () => {
        const file = (name: string) => `native:albums/${TAG}-held-${name}.jpg`;
        const stored = (name: string) => putFile(path.join(coversBasePath(), 'albums', `${TAG}-held-${name}.jpg`));
        const links = { track: `${TAG}-c-track`, album: `${TAG}-c-album`, playlist: `${TAG}-c-playlist` };
        let artistId: string;
        let playlistId: string;
        let heldAlbumId: string;
        let heldTrackId: string;

        const album = (key: string, data: object = {}) =>
            prisma.album.create({
                data: { rgMbid: `${TAG}-c-${key}`, identityKey: `${TAG}-c-${key}`, artistId, title: key, primaryType: 'Album', location: 'LIBRARY', coverUrl: file(key), ...data },
            });
        const song = (albumId: string, n: number, data: object = {}) =>
            prisma.track.create({ data: { albumId, title: `Song ${n}`, duration: 100, trackNo: n, filePath: `/${TAG}/c-${albumId}-${n}.flac`, fileModified: new Date(), fileSize: 1, ...data } });

        beforeAll(async () => {
            artistId = (await prisma.artist.findFirstOrThrow({ where: { identityKey: TAG } })).id;
            const held = await album('held');
            const heldTrack = await song(held.id, 1);
            // A playlist holding a playable song, a song of a Discover album, and a corrupt one.
            const inPlaylist = await album('inplaylist');
            const suggested = await album('suggested', { location: 'DISCOVER' });
            const broken = await album('broken');
            const playable = await song(inPlaylist.id, 1);
            const hidden = await song(suggested.id, 1);
            const corrupt = await song(broken.id, 1, { corrupt: true });
            await album('elsewhere');
            playlistId = (await prisma.playlist.create({ data: { userId: OWNER, name: `${TAG}-c` } })).id;
            for (const [i, t] of [playable, hidden, corrupt].entries()) {
                await prisma.playlistItem.create({ data: { playlistId, trackId: t.id, sort: i, rank: `c${i}` } });
            }
            heldAlbumId = held.id;
            heldTrackId = heldTrack.id;
        });
        afterAll(async () => {
            await prisma.playlist.deleteMany({ where: { id: playlistId } });
            await prisma.track.deleteMany({ where: { album: { rgMbid: { startsWith: `${TAG}-c-` } } } });
            await prisma.album.deleteMany({ where: { rgMbid: { startsWith: `${TAG}-c-` } } });
        });
        // Every file is on disk, so only the share can be the reason for a refusal. The outer afterEach removes them.
        beforeEach(async () => {
            // The file's top-level beforeEach has just removed the owner's links.
            await prisma.shareLink.createMany({
                data: [
                    { token: links.track, entityType: 'track', entityId: heldTrackId, createdBy: OWNER },
                    { token: links.album, entityType: 'album', entityId: heldAlbumId, createdBy: OWNER },
                    { token: links.playlist, entityType: 'playlist', entityId: playlistId, createdBy: OWNER },
                ],
            });
            for (const name of ['held', 'inplaylist', 'suggested', 'broken', 'elsewhere']) stored(name);
            // Artist pictures are stored beside album covers.
            putFile(path.join(coversBasePath(), 'artists', `${TAG}-artist.jpg`));
        });

        const get = (token: string, id: string) => request(app).get(coverUrl(id, token));

        it("serves a song share's own album cover, an album share's cover, and a playlist's playable song's cover", async () => {
            expect((await get(links.track, file('held'))).status).toBe(200);
            expect((await get(links.album, file('held'))).status).toBe(200);
            expect((await get(links.playlist, file('inplaylist'))).status).toBe(200);
        });

        it('answers 404 for a cover the share does not hold, though the file is there', async () => {
            for (const token of Object.values(links)) {
                for (const id of [file('elsewhere'), `native:artists/${TAG}-artist.jpg`]) {
                    const res = await get(token, id);
                    expect([token, id, res.status]).toEqual([token, id, 404]);
                }
            }
            // One share's cover is not another's.
            expect((await get(links.playlist, file('held'))).status).toBe(404);
            expect((await get(links.track, file('inplaylist'))).status).toBe(404);
            expect((await get(links.album, file('inplaylist'))).status).toBe(404);
        });

        it('answers 404 for the cover of a playlist song that cannot play: Discover or corrupt', async () => {
            expect((await get(links.playlist, file('suggested'))).status).toBe(404);
            expect((await get(links.playlist, file('broken'))).status).toBe(404);
        });

        it("answers 404 for a size request too when the cover is not the share's", async () => {
            const res = await request(app).get(`${coverUrl(file('elsewhere'), links.track)}?size=500`);
            expect(res.status).toBe(404);
        });
    });
});

describe('GET /share/:token/stream/:trackId -- only a playable song streams', () => {
    // Every file is on disk, so only the playable-song rule can be the reason for a refusal.
    const DIR = `${TAG}-stream`;
    const BYTES = Buffer.from('fLaC-share-stream-bytes');
    const stream = (token: string, id: string) =>
        request(app).get(`/share/${token}/stream/${id}`).buffer(true).parse((r, cb) => {
            r.on('data', () => undefined);
            r.on('end', () => cb(null, undefined));
        });

    let albumId: string;
    let discoverId: string;
    const songs = {} as Record<'playable' | 'missing' | 'corrupt' | 'suggested', string>;
    let playlistId: string;

    beforeAll(async () => {
        const artist = await prisma.artist.findFirstOrThrow({ where: { identityKey: TAG } });
        albumId = (await prisma.album.create({ data: { rgMbid: `${TAG}-s`, identityKey: `${TAG}-s`, artistId: artist.id, title: 'Streams', primaryType: 'Album', location: 'LIBRARY' } })).id;
        discoverId = (await prisma.album.create({ data: { rgMbid: `${TAG}-sd`, identityKey: `${TAG}-sd`, artistId: artist.id, title: 'Streams suggested', primaryType: 'Album', location: 'DISCOVER' } })).id;
        const song = async (kind: keyof typeof songs, album: string, n: number, data: object = {}) => {
            const filePath = `${DIR}/${kind}.flac`;
            const full = path.join(config.music.musicPath, filePath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, BYTES);
            songs[kind] = (await prisma.track.create({ data: { albumId: album, title: kind, duration: 100, trackNo: n, filePath, fileModified: new Date(), fileSize: BYTES.length, ...data } })).id;
        };
        await song('playable', albumId, 1);
        await song('missing', albumId, 2, { missingSince: new Date() });
        await song('corrupt', albumId, 3, { corrupt: true });
        await song('suggested', discoverId, 1);
        playlistId = (await prisma.playlist.create({ data: { userId: OWNER, name: TAG } })).id;
        for (const [i, id] of Object.values(songs).entries()) {
            await prisma.playlistItem.create({ data: { playlistId, trackId: id, sort: i, rank: `s${i}` } });
        }
    });

    afterAll(async () => {
        await prisma.playlist.deleteMany({ where: { id: playlistId } });
        fs.rmSync(path.join(config.music.musicPath, DIR), { recursive: true, force: true });
    });

    const covering = (entityType: string, entityId: string) =>
        prisma.shareLink.create({ data: { token: `${TAG}-${entityType}-${entityId}`, entityType, entityId, createdBy: OWNER } }).then((l) => l.token);

    it('streams the playable song through a link to the song, to its album and to a playlist holding it', async () => {
        for (const [type, id] of [['track', songs.playable], ['album', albumId], ['playlist', playlistId]]) {
            const res = await stream(await covering(type, id), songs.playable);
            expect([type, res.status]).toEqual([type, 200]);
        }
    });

    it.each(['missing', 'corrupt', 'suggested'] as const)('answers 404 for the %s song, whatever the link covers', async (kind) => {
        const id = songs[kind];
        const links = [await covering('track', id), await covering('playlist', playlistId)];
        if (kind !== 'suggested') links.push(await covering('album', albumId));
        for (const token of links) {
            const res = await stream(token, id);
            expect([token, res.status]).toEqual([token, 404]);
        }
    });

    it('still answers 403 for a song the link does not cover', async () => {
        const res = await stream(await covering('track', songs.playable), songs.corrupt);
        expect(res.status).toBe(403);
    });

    describe('a link that has ended answers 410 with the reason, on every address that opens it', () => {
        const ended = {
            expired: { expiresAt: new Date(Date.now() - 1000) },
            'play-limit': { maxPlays: 2, playCount: 2 },
        } as const;

        it.each(['expired', 'play-limit'] as const)('says %s', async (reason) => {
            const token = `${TAG}-ended-${reason}`;
            await prisma.shareLink.create({ data: { token, entityType: 'track', entityId: songs.playable, createdBy: OWNER, ...ended[reason] } });
            const message = reason === 'expired' ? 'Share link has expired' : 'Share link play limit reached';

            for (const address of [`/share/${token}`, `/share/${token}/stream/${songs.playable}`, `/share/${token}/cover-art/native:albums%2Fx.jpg`]) {
                const res = await request(app).get(address);
                expect([address, res.status, res.body]).toEqual([address, 410, { error: message, reason }]);
            }
        });

        it('says play-limit when the last play is taken between the check and the count', async () => {
            const token = await covering('track', songs.playable);
            await prisma.shareLink.update({ where: { token }, data: { maxPlays: 1 } });
            const raw = jest.spyOn(prisma, '$executeRaw').mockResolvedValueOnce(0);

            const res = await request(app).get(`/share/${token}/stream/${songs.playable}`);
            raw.mockRestore();

            expect([res.status, res.body]).toEqual([410, { error: 'Share link play limit reached', reason: 'play-limit' }]);
        });
    });

    it('counts a visit only for a song that streams', async () => {
        const token = await covering('track', songs.corrupt);
        await stream(token, songs.corrupt);
        expect((await prisma.shareLink.findUniqueOrThrow({ where: { token } })).playCount).toBe(0);
    });

    /** A link of its own to one song, so a test starts from no plays and no window. */
    let linkN = 0;
    const own = async (data: object = {}, entityId = songs.playable) => {
        const token = `${TAG}-own-${linkN++}`;
        const link = await prisma.shareLink.create({ data: { token, entityType: 'track', entityId, createdBy: OWNER, ...data } });
        return { token, id: link.id };
    };
    const playsOf = async (token: string) => (await prisma.shareLink.findUniqueOrThrow({ where: { token } })).playCount;
    const get = (token: string, id: string, headers: Record<string, string> = {}) =>
        request(app).get(`/share/${token}/stream/${id}`).set(headers).buffer(true).parse((r, cb) => {
            r.on('data', () => undefined);
            r.on('end', () => cb(null, undefined));
        });
    /** The listener's next play: the 30 s window has passed. */
    const windowPasses = async (shareId: string) => {
        const keys = await redisClient.keys(`*${shareId}*`);
        if (keys.length) await redisClient.del(...keys);
    };

    describe('counting plays', () => {
        it("serves a listener's follow-up requests for a play already counted, though the play limit is now reached", async () => {
            const { token } = await own({ maxPlays: 1 });

            expect((await get(token, songs.playable)).status).toBe(200);
            expect(await playsOf(token)).toBe(1);

            for (const range of ['bytes=0-1', 'bytes=2-', 'bytes=0-']) {
                const res = await get(token, songs.playable, { Range: range });
                expect([range, res.status]).toEqual([range, 206]);
            }
            expect(await playsOf(token)).toBe(1);
        });

        it('still refuses a follow-up request once the link has expired', async () => {
            const { token } = await own({ maxPlays: 1 });
            await get(token, songs.playable);
            await prisma.shareLink.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 1000) } });

            const res = await request(app).get(`/share/${token}/stream/${songs.playable}`).set('Range', 'bytes=0-1');

            expect([res.status, res.body]).toEqual([410, { error: 'Share link has expired', reason: 'expired' }]);
        });

        it('refuses the next play, after the window, when the limit is reached', async () => {
            const { token, id } = await own({ maxPlays: 1 });
            await get(token, songs.playable);
            await windowPasses(id);

            const res = await request(app).get(`/share/${token}/stream/${songs.playable}`);

            expect([res.status, res.body]).toEqual([410, { error: 'Share link play limit reached', reason: 'play-limit' }]);
            expect(await playsOf(token)).toBe(1);
        });

        it('counts requests that arrive together as one play', async () => {
            const { token } = await own();

            const replies = await Promise.all([get(token, songs.playable), get(token, songs.playable, { Range: 'bytes=0-1' }), get(token, songs.playable, { Range: 'bytes=2-' })]);

            expect(replies.map((r) => r.status).sort()).toEqual([200, 206, 206]);
            expect(await playsOf(token)).toBe(1);
        });

        it('counts a play again after the window, and not within it', async () => {
            const { token, id } = await own();

            await get(token, songs.playable);
            await get(token, songs.playable);
            expect(await playsOf(token)).toBe(1);

            await windowPasses(id);
            await get(token, songs.playable);
            expect(await playsOf(token)).toBe(2);
        });

        it('keeps the window at 30 seconds, in Redis', async () => {
            const { token, id } = await own();
            await get(token, songs.playable);

            const [key] = await redisClient.keys(`*${id}*`);

            expect(key).toContain(songs.playable);
            const ttl = await redisClient.ttl(key);
            expect(ttl).toBeGreaterThan(25);
            expect(ttl).toBeLessThanOrEqual(30);
        });

        it('does not count a play whose stream did not start, and leaves the next request to count', async () => {
            const { token } = await own({ maxPlays: 1 });
            // A conditional request for a file the listener already holds is answered 304: nothing is played.
            const notModified = await get(token, songs.playable, { 'If-None-Match': '*' });
            expect(notModified.status).toBe(304);
            expect(await playsOf(token)).toBe(0);

            expect((await get(token, songs.playable)).status).toBe(200);
            expect(await playsOf(token)).toBe(1);
        });

        it('does not count a play for a file with nothing in it', async () => {
            const full = path.join(config.music.musicPath, DIR, 'empty.flac');
            fs.writeFileSync(full, '');
            const empty = await prisma.track.create({ data: { albumId, title: 'empty', duration: 100, trackNo: 9, filePath: `${DIR}/empty.flac`, fileModified: new Date(), fileSize: 1 } });
            const { token } = await own({ maxPlays: 1 }, empty.id);

            const res = await get(token, empty.id);

            expect(res.status).toBe(404);
            expect(await playsOf(token)).toBe(0);
        });

        it('gives the play back when the last one was taken between the check and the count, so the window is not held', async () => {
            const { token, id } = await own({ maxPlays: 1 });
            const raw = jest.spyOn(prisma, '$executeRaw').mockResolvedValueOnce(0);
            const refused = await request(app).get(`/share/${token}/stream/${songs.playable}`);
            raw.mockRestore();

            expect(refused.status).toBe(410);
            expect(await redisClient.keys(`*${id}*`)).toEqual([]);
            // The refusal left no mark: the next request is a first play.
            expect((await get(token, songs.playable)).status).toBe(200);
            expect(await playsOf(token)).toBe(1);
        });

        it("a follow-up request keeps the play going: it renews the window, so a long song is one play", async () => {
            const { token, id } = await own({ maxPlays: 1 });
            await get(token, songs.playable);
            const [key] = await redisClient.keys(`*${id}*`);
            // Most of the window has passed, as it does when a listener seeks late in a long song.
            await redisClient.expire(key, 3);

            expect((await get(token, songs.playable, { Range: 'bytes=5-' })).status).toBe(206);

            expect(await redisClient.ttl(key)).toBeGreaterThan(25);
            expect(await playsOf(token)).toBe(1);
        });

        it('a request that is not a follow-up does not leave a window behind when it is refused', async () => {
            const { token, id } = await own({ maxPlays: 0 });
            await request(app).get(`/share/${token}/stream/${songs.playable}`);
            expect(await redisClient.keys(`*${id}*`)).toEqual([]);
        });

        it.each([
            ['a whole song', {}, 200],
            ['a range', { Range: 'bytes=0-4' }, 206],
        ])('sends %s with private, no-store, so a browser does not keep the audio', async (_name, headers, status) => {
            const { token } = await own();
            const res = await get(token, songs.playable, headers);
            expect([res.status, res.headers['cache-control']]).toEqual([status, 'private, no-store']);
        });

        it('does not count a play whose listener left while the count was being taken', async () => {
            const { token, id } = await own({ maxPlays: 1 });
            const count = prisma.$executeRaw.bind(prisma);
            const slow = jest.spyOn(prisma, '$executeRaw').mockImplementation(((...args: Parameters<typeof count>) =>
                new Promise((resolve) => setTimeout(resolve, 150)).then(() => count(...args))) as typeof prisma.$executeRaw);
            try {
                const asking = request(app).get(`/share/${token}/stream/${songs.playable}`);
                asking.end(() => undefined);
                await new Promise((resolve) => setTimeout(resolve, 40));
                asking.abort();
                await new Promise((resolve) => setTimeout(resolve, 700));
            } finally {
                slow.mockRestore();
            }

            expect(await playsOf(token)).toBe(0);
            expect(await redisClient.keys(`*${id}*`)).toEqual([]);
        });

        it('counts every request, as a first play, while Redis is down', async () => {
            const { token } = await own();
            const expire = jest.spyOn(redisClient, 'expire').mockRejectedValue(new Error('down'));
            const set = jest.spyOn(redisClient, 'set').mockRejectedValue(new Error('down'));
            try {
                expect((await get(token, songs.playable)).status).toBe(200);
                expect((await get(token, songs.playable, { Range: 'bytes=0-1' })).status).toBe(206);
            } finally {
                expire.mockRestore();
                set.mockRestore();
            }

            expect(await playsOf(token)).toBe(2);
        });

        it('a link with 0 plays allowed plays nothing: it is not unlimited', async () => {
            const { token } = await own({ maxPlays: 0 });

            const opened = await request(app).get(`/share/${token}`);
            const streamed = await request(app).get(`/share/${token}/stream/${songs.playable}`);

            for (const res of [opened, streamed]) {
                expect([res.status, res.body]).toEqual([410, { error: 'Share link play limit reached', reason: 'play-limit' }]);
            }
            expect(await playsOf(token)).toBe(0);
        });
    });

    describe('answers that must not be cached', () => {
        it.each([
            ['opening an unknown link', '/share/zz-no-such-link'],
            ['streaming from an unknown link', '/share/zz-no-such-link/stream/x'],
            ['a cover from an unknown link', '/share/zz-no-such-link/cover-art/native:albums%2Fx.jpg'],
        ])('%s answers 404 with no-store', async (_name, address) => {
            const res = await request(app).get(address);
            expect([res.status, res.headers['cache-control']]).toEqual([404, 'no-store']);
        });

        it.each([
            ['expired', { expiresAt: new Date(Date.now() - 1000) }],
            ['play-limit', { maxPlays: 1, playCount: 1 }],
        ])('a link that is %s answers 410 with no-store, on every address', async (_reason, data) => {
            const { token } = await own(data);
            for (const address of [`/share/${token}`, `/share/${token}/stream/${songs.playable}`, `/share/${token}/cover-art/native:albums%2Fx.jpg`]) {
                const res = await request(app).get(address);
                expect([address, res.status, res.headers['cache-control']]).toEqual([address, 410, 'no-store']);
            }
        });

        it('a song with no file, and a song outside the link, are not cached either', async () => {
            const missing = await request(app).get(`/share/${(await own({}, songs.missing)).token}/stream/${songs.missing}`);
            expect([missing.status, missing.headers['cache-control']]).toEqual([404, 'no-store']);
            const outside = await request(app).get(`/share/${(await own()).token}/stream/${songs.corrupt}`);
            expect([outside.status, outside.headers['cache-control']]).toEqual([403, 'no-store']);
        });

        it('a song that streams is not marked no-store by this', async () => {
            const res = await get((await own()).token, songs.playable);
            expect(res.headers['cache-control']).not.toBe('no-store');
        });
    });
});
