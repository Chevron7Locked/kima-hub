/**
 * POST /share and DELETE /share/:token (authenticated); the cover route. GET /share/:token is in publicShare.route.test.ts. Streaming and cover
 * routes need real files and are left out; their path guard is tested directly.
 * Real router, real auth and real database.
 */

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import shareRoutes from '../../routes/share';
import { prisma } from '../../utils/db';
import { coversBasePath } from '../../services/imageStorage';
import { config } from '../../config';

const JWT_SECRET = process.env.JWT_SECRET!;
const TAG = 'zz-share-route';
const OWNER = `${TAG}-owner`;
const OTHER = `${TAG}-other`;
const TOKEN = `${TAG}-token`;

const app = express();
app.use(express.json());
app.use('/share', shareRoutes);

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

    it('counts a visit only for a song that streams', async () => {
        const token = await covering('track', songs.corrupt);
        await stream(token, songs.corrupt);
        expect((await prisma.shareLink.findUniqueOrThrow({ where: { token } })).playCount).toBe(0);
    });
});
