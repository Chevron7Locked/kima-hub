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
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import path from 'path';
import shareRoutes, { settleShareBackgroundWork } from '../../routes/share';
import { prisma } from '../../utils/db';
import { redisClient } from '../../utils/redis';
import { coversBasePath } from '../../services/imageStorage';
import os from 'os';
import { config, useMusicFolder } from '../../config';
import { AudioStreamingService } from '../../services/audioStreaming';
import { mountAsServer } from "./helpers/serverMount";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

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

// The streaming tests write real files under the music folder, so the test has its own and needs no writable /music.
const startFolder = config.music.musicPath;
const musicFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kima-share-music-'));

beforeAll(async () => {
    useMusicFolder(musicFolder);
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

// What a request leaves running when its response closes (renewing its play's window) ends before the next test, and before
// Redis is closed at the end of the file.
afterEach(settleShareBackgroundWork);

afterAll(async () => {
    useMusicFolder(startFolder);
    fs.rmSync(musicFolder, { recursive: true, force: true });
    await clean();
});

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

    it('answers 403 for a song outside the album or the playlist of the link, and for an id that is no song', async () => {
        const outside = await prisma.track.create({ data: { albumId: discoverId, title: 'outside', duration: 100, trackNo: 9, filePath: `${DIR}/outside.flac`, fileModified: new Date(), fileSize: BYTES.length } });
        try {
            const links = { album: await covering('album', albumId), playlist: await covering('playlist', playlistId) };
            for (const [type, song] of [['album', outside.id], ['playlist', outside.id], ['album', 'no-such-song'], ['playlist', 'no-such-song']] as const) {
                const res = await stream(links[type], song);
                expect([type, song, res.status]).toEqual([type, song, 403]);
            }
        } finally {
            await prisma.track.delete({ where: { id: outside.id } });
        }
    });

    // A query count is the only way to see this: the answer is the same either way. A song that plays is the usual request,
    // and each request is made once per range a listener's player asks for.
    it('finds the song a link plays with one lookup, whatever the link covers', async () => {
        const tracks = jest.spyOn(prisma.track, 'findFirst');
        const items = jest.spyOn(prisma.playlistItem, 'findFirst');
        try {
            for (const [type, id] of [['track', songs.playable], ['album', albumId], ['playlist', playlistId]]) {
                const token = await covering(type, id);
                tracks.mockClear();
                items.mockClear();
                expect((await stream(token, songs.playable)).status).toBe(200);
                expect([type, tracks.mock.calls.length, items.mock.calls.length]).toEqual([type, 1, 0]);
            }
        } finally {
            tracks.mockRestore();
            items.mockRestore();
        }
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
    /** A song long enough that a paused reply stays open. */
    const longSong = async (name: string, trackNo: number) => {
        fs.writeFileSync(path.join(config.music.musicPath, DIR, `${name}.flac`), Buffer.alloc(24 * 1024 * 1024));
        return prisma.track.create({ data: { albumId, title: name, duration: 100, trackNo, filePath: `${DIR}/${name}.flac`, fileModified: new Date(), fileSize: 24 * 1024 * 1024 } });
    };
    /**
     * Only the timer a response keeps while it is open (it ticks more often than the window lasts) is captured, so a test runs
     * its ticks by hand and can see whether the response stopped it.
     */
    const captureRenewTimers = () => {
        const timers: Array<{ tick: () => void; handle: NodeJS.Timeout }> = [];
        const realSetInterval = global.setInterval;
        const spy = jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
            if (typeof ms === 'number' && ms < 30_000) {
                const handle = realSetInterval(() => undefined, 60_000);
                timers.push({ tick: fn, handle });
                return handle;
            }
            return realSetInterval(fn, ms);
        }) as typeof setInterval);
        return { timers, tickAll: () => timers.forEach((timer) => timer.tick()), restore: () => spy.mockRestore() };
    };
    /** A request to the running server from one address and browser, so every request is the same listener's. */
    const over = (port: number, requestPath: string, headers: Record<string, string> = {}) =>
        new Promise<http.IncomingMessage>((resolve, reject) =>
            http.get({ host: '127.0.0.1', port, path: requestPath, headers: { 'User-Agent': 'one-listener', ...headers } }, resolve).on('error', reject));
    /** Reads a reply to its end and answers its status. */
    const drain = (reply: http.IncomingMessage) =>
        new Promise<number | undefined>((resolve, reject) => {
            reply.on('error', reject).on('end', () => resolve(reply.statusCode)).resume();
        });
    /** Holds the statement that counts a play until `release`, and says when it is held (`stalled`) and when it has answered (`counted`). */
    const stallCounting = () => {
        const realExecute: any = prisma.$executeRaw.bind(prisma);
        let release!: () => void;
        let markStalled!: () => void;
        let markCounted!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const stalled = new Promise<void>((resolve) => (markStalled = resolve));
        const counted = new Promise<void>((resolve) => (markCounted = resolve));
        const spy = jest.spyOn(prisma, '$executeRaw').mockImplementation(((...args: unknown[]) =>
            String((args[0] as TemplateStringsArray)?.join?.(' ')).includes('+ 1')
                ? (markStalled(), held.then(() => realExecute(...args)).then((n: number) => (markCounted(), n)))
                : realExecute(...args)) as never);
        return { release, stalled, counted, restore: () => spy.mockRestore() };
    };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

        it('counts no play for a HEAD request, which sends no audio', async () => {
            const { token, id } = await own({ maxPlays: 1 });

            const res = await request(app).head(`/share/${token}/stream/${songs.playable}`);
            await settleShareBackgroundWork();

            expect(res.status).toBe(200);
            expect(await playsOf(token)).toBe(0);
            expect(await redisClient.keys(`*${id}*`)).toEqual([]);
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

        describe('two listeners of one shared song', () => {
            const listener = (name: string) => ({ 'User-Agent': name });

            it('each count a play: the second is no follow-up of the first', async () => {
                const { token } = await own();

                expect((await get(token, songs.playable, listener('listener-a'))).status).toBe(200);
                expect((await get(token, songs.playable, listener('listener-b'))).status).toBe(200);

                expect(await playsOf(token)).toBe(2);
            });

            it('are told apart by the limit: the second is refused when the first took the last play', async () => {
                const { token } = await own({ maxPlays: 1 });
                await get(token, songs.playable, listener('listener-a'));

                const second = await get(token, songs.playable, listener('listener-b'));

                expect(second.status).toBe(410);
                expect(await playsOf(token)).toBe(1);
            });

            it("a listener's own follow-ups stay one play while the other listens", async () => {
                const { token } = await own();

                await get(token, songs.playable, listener('listener-a'));
                await get(token, songs.playable, listener('listener-b'));
                await get(token, songs.playable, { ...listener('listener-a'), Range: 'bytes=0-1' });
                await get(token, songs.playable, { ...listener('listener-b'), Range: 'bytes=2-' });

                expect(await playsOf(token)).toBe(2);
            });

            it("one's requests do not renew the other's window", async () => {
                const { token, id } = await own();
                await get(token, songs.playable, listener('listener-a'));
                await settleShareBackgroundWork();
                const [keyA] = await redisClient.keys(`*${id}*`);
                await redisClient.expire(keyA, 3);

                await get(token, songs.playable, listener('listener-b'));
                await settleShareBackgroundWork();

                expect(await redisClient.ttl(keyA)).toBeLessThanOrEqual(3);
                expect((await redisClient.keys(`*${id}*`)).length).toBe(2);
            });

            it('counts a play when the window ended between it being read and being renewed', async () => {
                const { token } = await own();
                // The window was there when read, and gone when its token was to be renewed.
                jest.spyOn(redisClient, 'get').mockResolvedValueOnce('a-token-that-just-expired');

                expect((await get(token, songs.playable, listener('listener-a'))).status).toBe(200);

                expect(await playsOf(token)).toBe(1);
                jest.restoreAllMocks();
            });

            it('keeps the listener out of the window key in the clear', async () => {
                const { token, id } = await own();
                await get(token, songs.playable, listener('a-very-recognisable-agent'));

                const keys = await redisClient.keys(`*${id}*`);

                expect(keys).toHaveLength(1);
                expect(keys[0]).not.toContain('a-very-recognisable-agent');
                expect(keys[0]).not.toContain('127.0.0.1');
            });

            it('are told by their sign-in when they have one, whatever their browser says', async () => {
                const { token, id } = await own();
                const asUser = (userId: string) => {
                    const signedIn = express();
                    signedIn.use((req, _res, next) => {
                        (req as any).session = { userId };
                        next();
                    });
                    mountAsServer(signedIn, '/share', shareRoutes, '/api/share');
                    return signedIn;
                };
                const play = (userId: string, agent: string) =>
                    request(asUser(userId)).get(`/share/${token}/stream/${songs.playable}`).set('User-Agent', agent).buffer(true).parse((r, cb) => {
                        r.on('data', () => undefined);
                        r.on('end', () => cb(null, undefined));
                    });

                await play('user-one', 'same-agent');
                await play('user-two', 'same-agent');
                expect(await playsOf(token)).toBe(2);

                await play('user-one', 'another-agent');
                expect(await playsOf(token)).toBe(2);
                expect((await redisClient.keys(`*${id}*`)).length).toBe(2);
            });
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

        it('ends the response of a play that did not start though giving the play back stalls, and finishes giving it back afterwards', async () => {
            const { token, id } = await own({ maxPlays: 1 });
            const logged = expectLog('warn');
            const realExecute: any = prisma.$executeRaw.bind(prisma);
            let release!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            // The take-back (the statement that lowers the count) stalls until released, then runs; counting the play does not.
            const execute = jest.spyOn(prisma, '$executeRaw').mockImplementation(((...args: unknown[]) =>
                String((args[0] as TemplateStringsArray)?.join?.(' ')).includes('GREATEST') ? held.then(() => realExecute(...args)) : realExecute(...args)) as never);
            try {
                const started = Date.now();
                const res = await get(token, songs.playable, { 'If-None-Match': '*' });
                expect(res.status).toBe(304);
                // It waited for the take-back a few seconds, not until the stall ended (the case's own limit is 15 s).
                expect(Date.now() - started).toBeLessThan(8_000);
                expect(logged).toHaveBeenCalledWith(expect.stringContaining('Giving back a play'));
                // The window is still held while the take-back has not finished.
                expect(await redisClient.keys(`*${id}*`)).not.toEqual([]);

                release();
                await settleShareBackgroundWork();
                expect(await redisClient.keys(`*${id}*`)).toEqual([]);
            } finally {
                release();
                execute.mockRestore();
            }
            // The take-back did happen: the play counted at the start was given back.
            expect(await playsOf(token)).toBe(0);
        }, 15_000);

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

        it('a response still open keeps its play going: a listener paused past the window who then seeks is not a new play', async () => {
            const full = path.join(config.music.musicPath, DIR, 'long.flac');
            fs.writeFileSync(full, Buffer.alloc(24 * 1024 * 1024));
            const long = await prisma.track.create({ data: { albumId, title: 'long', duration: 100, trackNo: 10, filePath: `${DIR}/long.flac`, fileModified: new Date(), fileSize: 24 * 1024 * 1024 } });
            const { token, id } = await own({ maxPlays: 1 }, long.id);

            const renewing = captureRenewTimers();
            const server = http.createServer(app).listen(0);
            let reply: http.IncomingMessage | undefined;
            try {
                const { port } = server.address() as AddressInfo;
                reply = await new Promise<http.IncomingMessage>((resolve, reject) =>
                    http.get({ port, path: `/share/${token}/stream/${long.id}` }, resolve).on('error', reject));
                reply.pause();
                const [key] = await redisClient.keys(`*${id}*`);
                await redisClient.expire(key, 3);

                renewing.tickAll();
                await new Promise(resolve => setTimeout(resolve, 150));

                expect(await redisClient.ttl(key)).toBeGreaterThan(25);
            } finally {
                renewing.restore();
                reply?.destroy();
                server.closeAllConnections();
                server.close();
            }
        });

        it("a play given back late does not free the window of the listener who took it after the first one ended", async () => {
            const { token, id } = await own();
            const realExecute: any = prisma.$executeRaw.bind(prisma);
            let release!: () => void;
            let markStalled!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            const stalled = new Promise<void>((resolve) => (markStalled = resolve));
            // The first listener's take-back (the statement that lowers the count) stalls until released.
            const execute = jest.spyOn(prisma, '$executeRaw').mockImplementation(((...args: unknown[]) =>
                String((args[0] as TemplateStringsArray)?.join?.(' ')).includes('GREATEST')
                    ? (markStalled(), held.then(() => realExecute(...args)))
                    : realExecute(...args)) as never);
            try {
                // A play that never starts (304) is taken back; its take-back is stalled, so its window is still its own.
                // (`.then` starts a supertest request.)
                const first = get(token, songs.playable, { 'If-None-Match': '*' }).then((r) => r);
                await stalled;
                // The window passes and a second listener's play takes it.
                await windowPasses(id);
                expect((await get(token, songs.playable)).status).toBe(200);
                const [key] = await redisClient.keys(`*${id}*`);
                const second = await redisClient.get(key);
                await first;

                release();
                await settleShareBackgroundWork();

                expect(await redisClient.get(key)).toBe(second);
            } finally {
                release();
                execute.mockRestore();
            }
        }, 15_000);

        it("a response still open does not renew a window that another listener's play has taken", async () => {
            const full = path.join(config.music.musicPath, DIR, 'long2.flac');
            fs.writeFileSync(full, Buffer.alloc(24 * 1024 * 1024));
            const long = await prisma.track.create({ data: { albumId, title: 'long2', duration: 100, trackNo: 11, filePath: `${DIR}/long2.flac`, fileModified: new Date(), fileSize: 24 * 1024 * 1024 } });
            const { token, id } = await own({}, long.id);

            const renewing = captureRenewTimers();
            const server = http.createServer(app).listen(0);
            let reply: http.IncomingMessage | undefined;
            try {
                const { port } = server.address() as AddressInfo;
                reply = await new Promise<http.IncomingMessage>((resolve, reject) =>
                    http.get({ port, path: `/share/${token}/stream/${long.id}` }, resolve).on('error', reject));
                reply.pause();
                const [key] = await redisClient.keys(`*${id}*`);
                // The first listener's window passed and another listener's play took it, with 3 s of its own left.
                await redisClient.set(key, 'another-listener', 'EX', 3);

                renewing.tickAll();
                await new Promise(resolve => setTimeout(resolve, 150));

                expect(await redisClient.ttl(key)).toBeLessThanOrEqual(3);
            } finally {
                renewing.restore();
                reply?.destroy();
                server.closeAllConnections();
                server.close();
            }
        });

        describe('a first request that fails while a seek of the same play is open', () => {
            it('leaves the window and the play to the seek that is using them', async () => {
                const long = await longSong('long3', 12);
                const { token, id } = await own({}, long.id);
                const stall = stallCounting();
                const server = http.createServer(app).listen(0);
                let seek: http.IncomingMessage | undefined;
                try {
                    const { port } = server.address() as AddressInfo;
                    const listen = (path: string, headers: Record<string, string> = {}) => over(port, `/share/${token}/stream/${path}`, headers);
                    // The first request takes the window and waits to count its play.
                    const first = listen(long.id, { 'If-None-Match': '*' }).then(drain);
                    await stall.stalled;
                    const [key] = await redisClient.keys(`*${id}*`);
                    const window = await redisClient.get(key);
                    // The listener's seek finds the window and plays on, held open.
                    seek = await listen(long.id, { Range: 'bytes=5-' });
                    seek.pause();

                    stall.release();
                    // Nothing plays for the first request (304), and its play is given back, unless a seek is playing.
                    expect(await first).toBe(304);
                    await settleShareBackgroundWork();

                    expect(await redisClient.get(key)).toBe(window);
                    expect(await playsOf(token)).toBe(1);

                    // The next seek is still a follow-up of that play.
                    expect(await listen(long.id, { Range: 'bytes=9-' }).then(drain)).toBe(206);
                    expect(await playsOf(token)).toBe(1);
                } finally {
                    stall.release();
                    stall.restore();
                    seek?.destroy();
                    server.closeAllConnections();
                    server.close();
                }
            }, 15_000);

            it('does not count a seek that is still looking up its song as part of the play: the first request gives its play back and the seek counts its own', async () => {
                const long = await longSong('long5', 14);
                const { token, id } = await own({}, long.id);
                const stall = stallCounting();
                const realFind: any = prisma.track.findFirst.bind(prisma.track);
                let lookups = 0;
                let release!: () => void;
                let markReached!: () => void;
                const held = new Promise<void>((resolve) => (release = resolve));
                const reached = new Promise<void>((resolve) => (markReached = resolve));
                // The first request's lookup passes; the seek's, the second, is held.
                const lookup = jest.spyOn(prisma.track, 'findFirst').mockImplementation(((...args: unknown[]) =>
                    ++lookups === 2 ? (markReached(), held.then(() => realFind(...args))) : realFind(...args)) as never);
                const server = http.createServer(app).listen(0);
                try {
                    const { port } = server.address() as AddressInfo;
                    const listen = (headers: Record<string, string> = {}) => over(port, `/share/${token}/stream/${long.id}`, headers);
                    const first = listen({ 'If-None-Match': '*' }).then(drain);
                    await stall.stalled;
                    const seek = listen({ Range: 'bytes=5-' }).then(drain);
                    await reached;

                    // The first request fails while the seek has only looked at its song: it has not joined the play, because
                    // a request joins one only once it is sure to be answered with audio.
                    stall.release();
                    expect(await first).toBe(304);
                    await settleShareBackgroundWork();
                    expect(await redisClient.keys(`*${id}*`)).toEqual([]);
                    expect(await playsOf(token)).toBe(0);

                    // The seek then plays, and the one play is counted once.
                    release();
                    expect(await seek).toBe(206);
                    expect(await playsOf(token)).toBe(1);
                } finally {
                    release();
                    stall.release();
                    stall.restore();
                    lookup.mockRestore();
                    server.closeAllConnections();
                    server.close();
                }
            }, 15_000);

            it('frees the window and gives the play back once no response of it is open', async () => {
                const long = await longSong('long4', 13);
                const { token, id } = await own({}, long.id);
                const server = http.createServer(app).listen(0);
                try {
                    const { port } = server.address() as AddressInfo;
                    const listen = (headers: Record<string, string> = {}) => over(port, `/share/${token}/stream/${long.id}`, headers);
                    const seek = await listen();
                    seek.pause();
                    const [key] = await redisClient.keys(`*${id}*`);
                    const window = await redisClient.get(key);
                    seek.destroy();
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    await settleShareBackgroundWork();
                    // The only response left its window to run out, and left no count behind.
                    expect(await redisClient.exists(`share:open:${window}`)).toBe(0);
                    expect(await playsOf(token)).toBe(1);

                    // A first request that fails now, with nothing open, takes its play back and frees the window.
                    await windowPasses(id);
                    expect(await listen({ 'If-None-Match': '*' }).then(drain)).toBe(304);
                    await settleShareBackgroundWork();
                    expect(await redisClient.keys(`*${id}*`)).toEqual([]);
                    expect(await playsOf(token)).toBe(1);
                } finally {
                    server.closeAllConnections();
                    server.close();
                }
            }, 15_000);
        });

        describe('the edges of a play window', () => {
            /** A song of its own with a small file, so a test can spoil it without touching another's. */
            const spoilable = async (name: string, trackNo: number) => {
                fs.writeFileSync(path.join(config.music.musicPath, DIR, `${name}.flac`), BYTES);
                return prisma.track.create({ data: { albumId, title: name, duration: 100, trackNo, filePath: `${DIR}/${name}.flac`, fileModified: new Date(), fileSize: BYTES.length } });
            };

            describe('a response stops renewing a window that is no longer its own', () => {
                /** Opens a long song, pauses the reply, and runs the response's renewal once after `change` was done to the window. */
                const renewOnceAfter = async (change: (key: string) => Promise<unknown> | void, trackNo: number) => {
                    const long = await longSong(`long-renew-${trackNo}`, trackNo);
                    const { token, id } = await own({}, long.id);
                    const renewing = captureRenewTimers();
                    const cleared = jest.spyOn(global, 'clearInterval');
                    const server = http.createServer(app).listen(0);
                    let reply: http.IncomingMessage | undefined;
                    try {
                        const { port } = server.address() as AddressInfo;
                        reply = await over(port, `/share/${token}/stream/${long.id}`);
                        reply.pause();
                        const [key] = await redisClient.keys(`*${id}*`);
                        await change(key);

                        renewing.tickAll();
                        await pause(150);
                        return { handle: renewing.timers[0].handle, cleared: cleared.mock.calls.map(([handle]) => handle) };
                    } finally {
                        cleared.mockRestore();
                        renewing.restore();
                        reply?.destroy();
                        server.closeAllConnections();
                        server.close();
                    }
                };

                it('when the window ended and another listener took it', async () => {
                    const { handle, cleared } = await renewOnceAfter((key) => redisClient.set(key, 'another-listener', 'EX', 3), 30);
                    expect(cleared).toContain(handle);
                });

                it('when the window ended and nobody took it', async () => {
                    const { handle, cleared } = await renewOnceAfter((key) => redisClient.del(key), 31);
                    expect(cleared).toContain(handle);
                });

                it('but not when Redis failed for a moment: the window may still be its own, so the next tick tries again', async () => {
                    const logged = expectLog('warn');
                    const failing = jest.spyOn(redisClient, 'eval');
                    try {
                        const { handle, cleared } = await renewOnceAfter(() => {
                            failing.mockRejectedValueOnce(new Error('down'));
                        }, 32);
                        expect(logged).toHaveBeenCalledWith(expect.stringContaining('Could not renew a play window'));
                        expect(cleared).not.toContain(handle);
                    } finally {
                        failing.mockRestore();
                    }
                });
            });

            describe('a request that is refused does not extend the window', () => {
                it.each([
                    ['the link no longer covers its song', 403, (token: string) => prisma.shareLink.update({ where: { token }, data: { entityId: songs.corrupt } }), 41],
                    ['its song has become corrupt', 404, (_token: string, song: string) => prisma.track.update({ where: { id: song }, data: { corrupt: true } }), 42],
                    ['its song has gone missing', 404, (_token: string, song: string) => prisma.track.update({ where: { id: song }, data: { missingSince: new Date() } }), 43],
                    ['its file has gone', 404, (_token: string, _song: string, file: string) => fs.promises.rm(file), 44],
                ] as const)('when %s', async (_what, status, spoil, trackNo) => {
                    const song = await spoilable(`refused-${trackNo}`, trackNo);
                    const { token, id } = await own({}, song.id);
                    expect((await get(token, song.id)).status).toBe(200);
                    await settleShareBackgroundWork();
                    const [key] = await redisClient.keys(`*${id}*`);
                    // Most of the window has passed, as it does when a listener comes back to a long song.
                    await redisClient.expire(key, 3);

                    await spoil(token, song.id, path.join(config.music.musicPath, DIR, `refused-${trackNo}.flac`));
                    expect((await get(token, song.id, { Range: 'bytes=5-' })).status).toBe(status);
                    await settleShareBackgroundWork();

                    expect(await redisClient.ttl(key)).toBeLessThanOrEqual(3);
                    expect(await playsOf(token)).toBe(1);
                });
            });

            describe('a play that never streamed', () => {
                /** The counts of open responses and the played marks, which are kept under a window's token and not under its share. */
                const tokenKeys = async () => [...(await redisClient.keys('share:open:*')), ...(await redisClient.keys('share:played:*'))];
                /** Holds the first request to reach the streaming module until `release`, and passes every other. */
                const holdFirstToStream = () => {
                    const real = AudioStreamingService.prototype.streamFileWithRangeSupport;
                    let calls = 0;
                    let release!: () => void;
                    let arrive!: () => void;
                    const held = new Promise<void>((resolve) => (release = resolve));
                    const reached = new Promise<void>((resolve) => (arrive = resolve));
                    const spy = jest.spyOn(AudioStreamingService.prototype, 'streamFileWithRangeSupport').mockImplementation(function (this: AudioStreamingService, ...args) {
                        if (++calls > 1) return real.apply(this, args);
                        arrive();
                        return held.then(() => real.apply(this, args));
                    });
                    return { release, reached, restore: () => { release(); spy.mockRestore(); } };
                };

                it('is given back, and its window freed, when the last response of it ends without one, though the first to fail was not the last', async () => {
                    const long = await longSong('long-gone-nowhere', 50);
                    const { token, id } = await own({}, long.id);
                    const stall = stallCounting();
                    const hold = holdFirstToStream();
                    const before = await tokenKeys();
                    const server = http.createServer(app).listen(0);
                    try {
                        const { port } = server.address() as AddressInfo;
                        const listen = (headers: Record<string, string>) => over(port, `/share/${token}/stream/${long.id}`, headers);
                        // The first request takes the window and waits to count its play; the listener's seek finds the window,
                        // and is held just before it would stream.
                        const first = listen({ 'If-None-Match': '*' }).then(drain);
                        await stall.stalled;
                        const seek = listen({ 'If-None-Match': '*', Range: 'bytes=5-' }).then(drain);
                        await hold.reached;

                        // The first request fails with the seek open, so the play is left to the seek.
                        stall.release();
                        expect(await first).toBe(304);
                        await settleShareBackgroundWork();
                        expect(await playsOf(token)).toBe(1);

                        // The seek, the last response of the play, fails as well: nothing was ever played.
                        hold.release();
                        expect(await seek).toBe(304);
                        await settleShareBackgroundWork();
                        expect(await playsOf(token)).toBe(0);
                        expect(await redisClient.keys(`*${id}*`)).toEqual([]);
                        expect((await tokenKeys()).filter((key) => !before.includes(key))).toEqual([]);
                    } finally {
                        hold.restore();
                        stall.release();
                        stall.restore();
                        server.closeAllConnections();
                        server.close();
                    }
                }, 15_000);

                it('is kept when an earlier response of it streamed, whatever the last one does', async () => {
                    const { token, id } = await own();
                    expect((await get(token, songs.playable)).status).toBe(200);
                    await settleShareBackgroundWork();

                    expect((await get(token, songs.playable, { 'If-None-Match': '*' })).status).toBe(304);
                    await settleShareBackgroundWork();

                    expect(await playsOf(token)).toBe(1);
                    expect(await redisClient.keys(`*${id}*`)).not.toEqual([]);
                });
            });

            it('gives the play back and frees the window when counting it fails, so the next request is a first play', async () => {
                const { token, id } = await own({ maxPlays: 1 });
                const before = [...(await redisClient.keys('share:open:*')), ...(await redisClient.keys('share:played:*'))];
                const logged = expectLog('error');
                const counting = jest.spyOn(prisma, '$executeRaw').mockRejectedValueOnce(new Error('database down'));
                try {
                    const failed = await get(token, songs.playable);
                    expect(failed.status).toBe(500);
                    expect(logged).toHaveBeenCalledWith(expect.stringContaining('database down'));
                } finally {
                    counting.mockRestore();
                }
                await settleShareBackgroundWork();

                expect(await redisClient.keys(`*${id}*`)).toEqual([]);
                // Neither the count of open responses nor the played mark outlives the window it was kept for.
                const after = [...(await redisClient.keys('share:open:*')), ...(await redisClient.keys('share:played:*'))];
                expect(after.filter((key) => !before.includes(key))).toEqual([]);
                expect(await playsOf(token)).toBe(0);
                expect((await get(token, songs.playable)).status).toBe(200);
                expect(await playsOf(token)).toBe(1);
            });
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
            const stall = stallCounting();
            const server = http.createServer(app).listen(0);
            const closed: Promise<void>[] = [];
            server.on('connection', (socket) => closed.push(new Promise((resolve) => socket.once('close', () => resolve()))));
            try {
                const { port } = server.address() as AddressInfo;
                // Not `over`: the listener's request itself is needed, to hang up on it.
                const asking = http.get({ host: '127.0.0.1', port, path: `/share/${token}/stream/${songs.playable}`, headers: { 'User-Agent': 'one-listener' } });
                asking.on('error', () => undefined);
                await stall.stalled;
                asking.destroy();
                // The count is let through only once the server has seen the listener go: nothing here waits on a clock.
                await Promise.all(closed);
                stall.release();
                await stall.counted;
                // The rest of the request ran in the turn the count answered in; what it left running is tracked.
                await new Promise((resolve) => setImmediate(resolve));
                await settleShareBackgroundWork();
            } finally {
                stall.release();
                stall.restore();
                await new Promise((resolve) => server.close(resolve));
            }

            expect(await playsOf(token)).toBe(0);
            expect(await redisClient.keys(`*${id}*`)).toEqual([]);
        });

        it('does not keep a play whose listener left after the headers went out and before any audio did', async () => {
            const { token, id } = await own({ maxPlays: 1 });
            const server = http.createServer(app).listen(0);
            const sockets: Socket[] = [];
            const closed: Promise<void>[] = [];
            server.on('connection', (socket) => {
                sockets.push(socket);
                closed.push(new Promise((resolve) => socket.once('close', () => resolve())));
            });
            // The streaming module is stood in for: it sends the headers, the connection then goes in the same turn (the
            // response has not heard of it), and the first of the audio is written to it.
            let wrote!: () => void;
            const written = new Promise<void>((resolve) => (wrote = resolve));
            const streaming = jest.spyOn(AudioStreamingService.prototype, 'streamFileWithRangeSupport').mockImplementation(async (_req, res) => {
                res.status(200).set({ 'Accept-Ranges': 'bytes', 'Content-Length': '4' });
                res.flushHeaders();
                sockets.forEach((socket) => socket.destroy());
                res.write(Buffer.from('abcd'));
                wrote();
            });
            try {
                const { port } = server.address() as AddressInfo;
                over(port, `/share/${token}/stream/${songs.playable}`).then(drain).catch(() => undefined);
                await written;
                await Promise.all(closed);
                await settleShareBackgroundWork();
            } finally {
                streaming.mockRestore();
                await new Promise((resolve) => server.close(resolve));
            }

            expect(await playsOf(token)).toBe(0);
            expect(await redisClient.keys(`*${id}*`)).toEqual([]);
        });

        it('takes no window and counts no play for a listener who left before the window was taken', async () => {
            const { token, id } = await own({ maxPlays: 1 });
            const server = http.createServer(app).listen(0);
            const closed: Promise<void>[] = [];
            server.on('connection', (socket) => closed.push(new Promise((resolve) => socket.once('close', () => resolve()))));
            // The look for the listener's window is held, so the listener can go before the window would be taken.
            const realGet = redisClient.get.bind(redisClient) as (key: string) => Promise<string | null>;
            let release!: () => void;
            let reached!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const held = new Promise<void>((resolve) => (reached = resolve));
            let looked!: () => void;
            const answered = new Promise<void>((resolve) => (looked = resolve));
            const look = jest.spyOn(redisClient, 'get').mockImplementation(((key: string) =>
                key.startsWith('share:play:')
                    ? (reached(), gate.then(() => realGet(key)).then((value) => (looked(), value)))
                    : realGet(key)) as never);
            const taking = jest.spyOn(redisClient, 'set');
            const counting = jest.spyOn(prisma, '$executeRaw');
            try {
                const { port } = server.address() as AddressInfo;
                const asking = http.get({ host: '127.0.0.1', port, path: `/share/${token}/stream/${songs.playable}`, headers: { 'User-Agent': 'one-listener' } });
                asking.on('error', () => undefined);
                await held;
                asking.destroy();
                await Promise.all(closed);
                release();
                // The request goes on in the turn the look answers in: by the next turn it has taken a window, or has not.
                await answered;
                await new Promise((resolve) => setImmediate(resolve));
                await settleShareBackgroundWork();
                expect(taking.mock.calls.filter(([key]) => String(key).startsWith('share:play:'))).toEqual([]);
                expect(counting).not.toHaveBeenCalled();
            } finally {
                release();
                look.mockRestore();
                taking.mockRestore();
                counting.mockRestore();
                await new Promise((resolve) => server.close(resolve));
            }

            expect(await playsOf(token)).toBe(0);
            expect(await redisClient.keys(`*${id}*`)).toEqual([]);
        });

        it("work left running after the response, the renewal as it closes, can be waited for", async () => {
            const { token } = await own();
            let release!: (renewed: number) => void;
            let markReached!: () => void;
            const held = new Promise<number>((resolve) => (release = resolve));
            const reached = new Promise<void>((resolve) => (markReached = resolve));
            // The count of open responses is renewed as the response closes, by a Redis call of its own (the opening and
            // leaving are scripts, and are not this one); that renewal is held.
            const expire = jest.spyOn(redisClient, 'pexpire').mockImplementation((() => (markReached(), held)) as never);
            try {
                expect((await get(token, songs.playable)).status).toBe(200);
                await reached;

                let settled = false;
                const done = settleShareBackgroundWork().then(() => { settled = true; });
                await new Promise((resolve) => setImmediate(resolve));
                expect(settled).toBe(false);

                release(1);
                await done;
                expect(settled).toBe(true);
            } finally {
                release(1);
                expire.mockRestore();
            }
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
