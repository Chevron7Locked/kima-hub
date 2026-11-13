/**
 * Library Albums Route Integration Tests
 *
 * GET /albums (list), GET /albums/:id (detail), and DELETE /albums/:id (admin only).
 * Real router, real database and real tokens; DELETE works on a real folder in the temp directory.
 * Only Deezer and Lidarr (outside services) are faked.
 */

// p-limit is pure ESM and cannot be required by Jest's CJS runner
jest.mock('p-limit', () => {
    return () => (fn: (...args: any[]) => any) => fn();
});

jest.mock('../../services/deezer', () => ({
    deezerService: { getTrackPreview: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../../services/lidarr', () => ({
    lidarrService: { getMissingTracksByAlbumMbid: jest.fn().mockResolvedValue([]) },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import albumRoutes from '../../routes/library/albums';
import { requireAuthOrToken } from '../../middleware/auth';
import { config, useMusicFolder } from '../../config';
import { prisma } from '../../utils/db';
import { lidarrService } from '../../services/lidarr';
import { deezerService } from '../../services/deezer';
import { expectLog } from '../../__tests__/helpers/expectedLogs';

const MARK = 'zz-library-albums';
const startFolder = config.music.musicPath;
// base/music is the music root; base/outside holds what a poisoned path would reach.
let base: string;
let root: string;

// The library router signs the listener in before these routes; here the real middleware does it.
const app = express().use(express.json()).use(requireAuthOrToken).use('/', albumRoutes);
const as = (userId: string, role: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role, tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;

let admin: string;
let member: string;
let other: string;
let artistId: string;

async function cleanup() {
    await prisma.ownedAlbum.deleteMany({ where: { rgMbid: { startsWith: MARK } } });
    await prisma.discoveryAlbum.deleteMany({ where: { rgMbid: { startsWith: MARK } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { rgMbid: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: MARK } } });
}

const newArtist = (key: string, name = `${MARK} ${key}`) =>
    prisma.artist.create({ data: { name, identityKey: `${MARK}-${key}` } });

/** An album with the given songs (a number of songs, or explicit ones); library unless said otherwise. */
async function newAlbum(
    key: string,
    opts: { artistId?: string; location?: 'LIBRARY' | 'DISCOVER'; songs?: number; coverUrl?: string; year?: number; title?: string } = {},
) {
    const album = await prisma.album.create({
        data: {
            rgMbid: `${MARK}-${key}`,
            identityKey: `${MARK}-${key}`,
            primaryType: 'Album',
            title: opts.title ?? `${MARK} ${key}`,
            sortName: `${MARK} ${key}`.toLowerCase(),
            artistId: opts.artistId ?? artistId,
            location: opts.location ?? 'LIBRARY',
            coverUrl: opts.coverUrl,
            year: opts.year,
        },
    });
    for (let n = 1; n <= (opts.songs ?? 1); n++) {
        await prisma.track.create({
            data: { title: `${MARK} ${key} song ${n}`, albumId: album.id, trackNo: n, duration: 100, filePath: `${MARK}/${key}/${n}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
    return album;
}

const suggest = (userId: string, key: string) =>
    prisma.discoveryAlbum.create({
        data: { userId, rgMbid: `${MARK}-${key}`, artistName: 'A', albumTitle: 'T', weekStartDate: new Date('2026-10-05T00:00:00Z'), status: 'ACTIVE' },
    });

beforeAll(async () => {
    await cleanup();
    admin = (await prisma.user.create({ data: { username: `${MARK}-admin`, passwordHash: 'x', role: 'admin' } })).id;
    member = (await prisma.user.create({ data: { username: `${MARK}-member`, passwordHash: 'x' } })).id;
    other = (await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: 'x' } })).id;
    artistId = (await newArtist('main', `${MARK} Radiohead`)).id;
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'kima-library-albums-'));
    root = path.join(base, 'music');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(base, 'outside'));
    useMusicFolder(root);
});

afterAll(async () => {
    useMusicFolder(startFolder);
    fs.rmSync(base, { recursive: true, force: true });
    await cleanup();
});

beforeEach(() => {
    (lidarrService.getMissingTracksByAlbumMbid as jest.Mock).mockResolvedValue([]);
});

describe('GET /albums -- list albums', () => {
    // Every list is scoped to one artist, so albums other files leave in the shared database do not count.
    const list = async (qs: string, who = admin) => request(app).get(`/albums?${qs}`).set('Authorization', as(who, 'user'));
    const ids = (res: request.Response) => res.body.albums.map((a: { rgMbid: string }) => a.rgMbid);

    it('returns paginated album list with total', async () => {
        const solo = await newArtist('list-solo');
        await newAlbum('list-solo-1', { artistId: solo.id });

        const res = await list(`artistId=${solo.id}`);
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual([`${MARK}-list-solo-1`]);
        expect(res.body.total).toBe(1);
        expect(res.body.offset).toBe(0);
        expect(res.body.limit).toBeDefined();
        expect(res.body.albums[0].artist).toEqual({ id: solo.id, mbid: null, name: `${MARK} list-solo` });
    });

    it('adds coverArt alias to each album', async () => {
        const art = await newArtist('cover');
        await newAlbum('cover-1', { artistId: art.id, coverUrl: '/covers/ok-computer.jpg' });

        const res = await list(`artistId=${art.id}`);
        expect(res.status).toBe(200);
        expect(res.body.albums[0].coverArt).toBe('/covers/ok-computer.jpg');
    });

    it('filters by artistId when provided', async () => {
        const mine = await newArtist('filter-mine');
        const theirs = await newArtist('filter-theirs');
        await newAlbum('filter-mine-1', { artistId: mine.id });
        await newAlbum('filter-theirs-1', { artistId: theirs.id });

        const res = await list(`artistId=${mine.id}&filter=all`);
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual([`${MARK}-filter-mine-1`]);
        expect(res.body.total).toBe(1);
    });

    it('lists only the library by default, and leaves out an album with no songs', async () => {
        const art = await newArtist('owned');
        await newAlbum('owned-lib', { artistId: art.id });
        await newAlbum('owned-empty', { artistId: art.id, songs: 0 });
        await newAlbum('owned-disc', { artistId: art.id, location: 'DISCOVER' });
        await suggest(admin, 'owned-disc');

        const res = await list(`artistId=${art.id}`);
        expect(ids(res)).toEqual([`${MARK}-owned-lib`]);
        expect(res.body.total).toBe(1);
    });

    it('applies "discovery" filter when filter=discovery: the listener\'s own Discover albums only', async () => {
        const art = await newArtist('discovery');
        await newAlbum('discovery-lib', { artistId: art.id });
        await newAlbum('discovery-mine', { artistId: art.id, location: 'DISCOVER' });
        await newAlbum('discovery-theirs', { artistId: art.id, location: 'DISCOVER' });
        await newAlbum('discovery-nobody', { artistId: art.id, location: 'DISCOVER' });
        await suggest(admin, 'discovery-mine');
        await suggest(other, 'discovery-theirs');

        const res = await list(`artistId=${art.id}&filter=discovery`, admin);
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual([`${MARK}-discovery-mine`]);
        expect(res.body.total).toBe(1);

        // "all" is the library plus the same Discover albums, nothing else.
        const all = await list(`artistId=${art.id}&filter=all`, admin);
        expect(ids(all).sort()).toEqual([`${MARK}-discovery-lib`, `${MARK}-discovery-mine`]);
    });

    it('ignores a suggestion that is no longer active', async () => {
        const art = await newArtist('discovery-gone');
        await newAlbum('discovery-gone-1', { artistId: art.id, location: 'DISCOVER' });
        await prisma.discoveryAlbum.create({
            data: { userId: admin, rgMbid: `${MARK}-discovery-gone-1`, artistName: 'A', albumTitle: 'T', weekStartDate: new Date('2026-10-05T00:00:00Z'), status: 'DELETED' },
        });

        const res = await list(`artistId=${art.id}&filter=discovery`);
        expect(res.body.albums).toEqual([]);
    });

    it('respects limit and offset query params', async () => {
        const art = await newArtist('paging');
        for (const k of ['a', 'b', 'c']) await newAlbum(`paging-${k}`, { artistId: art.id });

        const res = await list(`artistId=${art.id}&limit=1&offset=1&filter=all`);
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(1);
        expect(res.body.offset).toBe(1);
        expect(res.body.total).toBe(3);
        expect(ids(res)).toEqual([`${MARK}-paging-b`]);
    });

    it('caps limit at MAX_LIMIT (10000)', async () => {
        const res = await list(`artistId=${artistId}&limit=99999&filter=all`);
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(10000);
    });

    it('returns empty array when no albums match', async () => {
        const art = await newArtist('none');

        const res = await list(`artistId=${art.id}&filter=owned`);
        expect(res.status).toBe(200);
        expect(res.body.albums).toEqual([]);
        expect(res.body.total).toBe(0);
    });
});

describe('GET /albums/:id -- album detail', () => {
    const detail = (id: string) => request(app).get(`/albums/${id}`).set('Authorization', as(member, 'user'));

    it('returns 404 for a nonexistent album id', async () => {
        const res = await detail('nonexistent-id');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Album not found');
    });

    it('returns album with tracks, in track order, and artist for a valid id', async () => {
        const album = await newAlbum('detail-tracks', { songs: 0, year: 1997, title: 'OK Computer' });
        for (const [trackNo, title] of [[2, 'Paranoid Android'], [1, 'Airbag']] as const) {
            await prisma.track.create({
                data: { title: `${MARK} ${title}`, albumId: album.id, trackNo, duration: 231, filePath: `${MARK}/detail-tracks/${trackNo}.flac`, fileModified: new Date(), fileSize: 1 },
            });
        }

        const res = await detail(album.id);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(album.id);
        expect(res.body.title).toBe('OK Computer');
        expect(res.body.tracks.map((t: { title: string }) => t.title)).toEqual([`${MARK} Airbag`, `${MARK} Paranoid Android`]);
        expect(res.body.artist.name).toBe(`${MARK} Radiohead`);
    });

    it('includes owned flag from OwnedAlbum table', async () => {
        const album = await newAlbum('detail-owned');
        await prisma.ownedAlbum.create({ data: { artistId, rgMbid: album.rgMbid, source: 'native_scan' } });

        const res = await detail(album.id);
        expect(res.status).toBe(200);
        expect(res.body.owned).toBe(true);
    });

    it('sets owned=false when no OwnedAlbum record exists', async () => {
        const album = await newAlbum('detail-unowned');

        const res = await detail(album.id);
        expect(res.status).toBe(200);
        expect(res.body.owned).toBe(false);
    });

    it('also resolves by rgMbid (passed as :id param)', async () => {
        const album = await newAlbum('detail-by-mbid');

        const res = await detail(album.rgMbid);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(album.id);
    });

    it('includes coverArt alias', async () => {
        const album = await newAlbum('detail-cover', { coverUrl: '/covers/ok.jpg' });

        const res = await detail(album.id);
        expect(res.status).toBe(200);
        expect(res.body.coverArt).toBe('/covers/ok.jpg');
    });

    it('returns missingTracks=[] when Lidarr reports none', async () => {
        const album = await newAlbum('detail-nomissing');

        const res = await detail(album.id);
        expect(res.status).toBe(200);
        expect(res.body.missingTracks).toEqual([]);
        expect(lidarrService.getMissingTracksByAlbumMbid).toHaveBeenCalledWith(album.rgMbid);
    });

    it('lists what Lidarr says is missing, with a preview where Deezer has one', async () => {
        const album = await newAlbum('detail-missing');
        (lidarrService.getMissingTracksByAlbumMbid as jest.Mock).mockResolvedValue([{ title: 'Lucky', trackNumber: 10 }]);
        (deezerService.getTrackPreview as jest.Mock).mockResolvedValueOnce('https://deezer.invalid/lucky.mp3');

        const res = await detail(album.id);
        expect(res.status).toBe(200);
        expect(res.body.missingTracks).toEqual([{ title: 'Lucky', trackNumber: 10, previewUrl: 'https://deezer.invalid/lucky.mp3' }]);
    });
});

describe('DELETE /albums/:id', () => {
    const remove = (id: string, who = admin, role = 'admin') => request(app).delete(`/albums/${id}`).set('Authorization', as(who, role));
    const albumExists = async (id: string) => (await prisma.album.findUnique({ where: { id } })) !== null;
    const put = (rel: string) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'x');
        return file;
    };

    it('returns 404 when album does not exist', async () => {
        const res = await remove('ghost-album');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Album not found');
    });

    it('refuses a signed-in member, and keeps the album', async () => {
        const album = await newAlbum('delete-member');

        const res = await remove(album.id, member, 'user');
        expect(res.status).toBe(403);
        expect(await albumExists(album.id)).toBe(true);
    });

    it('deletes the album and its songs, and reports no files when none are on disk', async () => {
        const album = await newAlbum('delete-nofiles');

        const res = await remove(album.id);
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Album deleted successfully');
        expect(res.body.deletedFiles).toBe(0);
        expect(await albumExists(album.id)).toBe(false);
        expect(await prisma.track.count({ where: { albumId: album.id } })).toBe(0);
    });

    it('counts and removes the song files that exist on disk, and the album folder once empty', async () => {
        const art = await newArtist('delete-files', 'DeleteFiles');
        const album = await newAlbum('delete-files', { artistId: art.id, songs: 0, title: 'Album One' });
        const files = ['DeleteFiles/Album One/01.flac', 'DeleteFiles/Album One/02.flac'].map(put);
        for (const [i, rel] of ['DeleteFiles/Album One/01.flac', 'DeleteFiles/Album One/02.flac', 'DeleteFiles/Album One/03-gone.flac'].entries()) {
            await prisma.track.create({
                data: { title: `${MARK} delete-files ${i}`, albumId: album.id, trackNo: i + 1, duration: 1, filePath: rel, fileModified: new Date(), fileSize: 1 },
            });
        }

        const res = await remove(album.id);
        expect(res.status).toBe(200);
        // The third song's file was never there: it is not counted.
        expect(res.body.deletedFiles).toBe(2);
        expect(files.some((f) => fs.existsSync(f))).toBe(false);
        expect(fs.existsSync(path.join(root, 'DeleteFiles', 'Album One'))).toBe(false);
        expect(await albumExists(album.id)).toBe(false);
    });

    it('refuses a track path and an album title that escape the music root', async () => {
        expectLog('warn');
        // Artist.name and Album.title are ID3 tag values, so a file added to the watched folder chooses them.
        // Neither the album folder nor the track path may reach the folder delete or the file delete.
        const keep = path.join(base, 'outside', 'keep.txt');
        fs.writeFileSync(keep, 'x');
        const emptyOutside = path.join(base, 'outside-empty');
        fs.mkdirSync(emptyOutside);
        const art = await newArtist('delete-escape', 'EscapeArtist');
        const album = await newAlbum('delete-escape', { artistId: art.id, songs: 0, title: '../../outside-empty' });
        await prisma.track.create({
            data: { title: `${MARK} escape`, albumId: album.id, trackNo: 1, duration: 1, filePath: '../outside/keep.txt', fileModified: new Date(), fileSize: 1 },
        });

        const res = await remove(album.id);

        expect(res.status).toBe(200);
        // Nothing outside the root was touched, and nothing was counted.
        expect(fs.existsSync(keep)).toBe(true);
        expect(fs.existsSync(emptyOutside)).toBe(true);
        expect(res.body.deletedFiles).toBe(0);
        // The row still goes: a poisoned tag must not make an album undeletable, which is why a refused path
        // is skipped, not thrown.
        expect(await albumExists(album.id)).toBe(false);
    });
});
