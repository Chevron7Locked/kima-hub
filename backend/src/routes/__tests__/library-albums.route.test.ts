/**
 * Library Albums Route Integration Tests
 *
 * Tests GET /albums (list), GET /albums/:id (detail), and DELETE /albums/:id.
 * None of these routes require authentication (no requireAuth middleware).
 * File-system calls in DELETE are mocked at the 'fs' and 'path' level.
 */

// All mocks must be before imports

// p-limit is pure ESM and cannot be required by Jest's CJS runner
jest.mock('p-limit', () => {
    return () => (fn: (...args: any[]) => any) => fn();
});

jest.mock('../../utils/db', () => ({
    Prisma: {
        SortOrder: { asc: 'asc', desc: 'desc' },
    },
    prisma: {
        album: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            count: jest.fn(),
            delete: jest.fn(),
        },
        ownedAlbum: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
        },
        track: { findMany: jest.fn() },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/deezer', () => ({
    deezerService: { getTrackPreview: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../../services/lidarr', () => ({
    lidarrService: { getMissingTracksByAlbumMbid: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../utils/errors', () => ({
    safeError: jest.fn((res: any, _ctx: string, _err: unknown) => {
        res.status(500).json({ error: 'Internal server error' });
    }),
}));

jest.mock('../../config', () => ({
    config: {
        music: {
            musicPath: '/music',
        },
    },
}));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(false),
    unlinkSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    rmdirSync: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import albumRoutes from '../../routes/library/albums';
import { prisma } from '../../utils/db';
import fs from 'fs';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', albumRoutes);
    return app;
}

const BASE_ARTIST = { id: 'artist-1', mbid: 'mbid-artist-1', name: 'Radiohead' };
const BASE_ALBUM = {
    id: 'album-1',
    title: 'OK Computer',
    artistId: 'artist-1',
    rgMbid: 'mbid-ok-computer',
    year: 1997,
    coverUrl: null,
    location: 'LIBRARY',
    artist: BASE_ARTIST,
    tracks: [],
};

describe('GET /albums -- list albums', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns paginated album list with total', async () => {
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([BASE_ALBUM]);
        (prisma.album.count as jest.Mock).mockResolvedValue(1);

        const res = await request(app).get('/albums');
        expect(res.status).toBe(200);
        expect(res.body.albums).toHaveLength(1);
        expect(res.body.total).toBe(1);
        expect(res.body.offset).toBe(0);
        expect(res.body.limit).toBeDefined();
    });

    it('adds coverArt alias to each album', async () => {
        const albumWithCover = { ...BASE_ALBUM, coverUrl: '/covers/ok-computer.jpg' };
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([albumWithCover]);
        (prisma.album.count as jest.Mock).mockResolvedValue(1);

        const res = await request(app).get('/albums');
        expect(res.status).toBe(200);
        expect(res.body.albums[0].coverArt).toBe('/covers/ok-computer.jpg');
    });

    it('filters by artistId when provided', async () => {
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([BASE_ALBUM]);
        (prisma.album.count as jest.Mock).mockResolvedValue(1);

        const res = await request(app).get('/albums?artistId=artist-1&filter=all');
        expect(res.status).toBe(200);

        const findManyCall = (prisma.album.findMany as jest.Mock).mock.calls[0][0];
        const whereClause = JSON.stringify(findManyCall.where);
        expect(whereClause).toContain('artist-1');
    });

    it('applies "discovery" filter when filter=discovery', async () => {
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.count as jest.Mock).mockResolvedValue(0);

        const res = await request(app).get('/albums?filter=discovery');
        expect(res.status).toBe(200);

        const findManyCall = (prisma.album.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.location).toBe('DISCOVER');
    });

    it('respects limit and offset query params', async () => {
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.count as jest.Mock).mockResolvedValue(0);

        const res = await request(app).get('/albums?limit=10&offset=20&filter=all');
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(10);
        expect(res.body.offset).toBe(20);
    });

    it('caps limit at MAX_LIMIT (10000)', async () => {
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.count as jest.Mock).mockResolvedValue(0);

        const res = await request(app).get('/albums?limit=99999&filter=all');
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(10000);
    });

    it('returns empty array when no albums match', async () => {
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.count as jest.Mock).mockResolvedValue(0);

        const res = await request(app).get('/albums?filter=owned');
        expect(res.status).toBe(200);
        expect(res.body.albums).toEqual([]);
        expect(res.body.total).toBe(0);
    });
});

describe('GET /albums/:id -- album detail', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 404 for a nonexistent album id', async () => {
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/albums/nonexistent-id');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Album not found');
    });

    it('returns album with tracks and artist for a valid id', async () => {
        const albumWithTracks = {
            ...BASE_ALBUM,
            tracks: [
                { id: 'track-1', title: 'Airbag', trackNo: 1, duration: 231, filePath: 'r/ok/01.flac' },
            ],
        };
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(albumWithTracks);
        (prisma.ownedAlbum.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/albums/album-1');
        expect(res.status).toBe(200);
        expect(res.body.id).toBe('album-1');
        expect(res.body.title).toBe('OK Computer');
        expect(res.body.tracks).toHaveLength(1);
        expect(res.body.artist.name).toBe('Radiohead');
    });

    it('includes owned flag from OwnedAlbum table', async () => {
        (prisma.album.findFirst as jest.Mock).mockResolvedValue({ ...BASE_ALBUM, tracks: [] });
        (prisma.ownedAlbum.findUnique as jest.Mock).mockResolvedValue({ rgMbid: 'mbid-ok-computer' });

        const res = await request(app).get('/albums/album-1');
        expect(res.status).toBe(200);
        expect(res.body.owned).toBe(true);
    });

    it('sets owned=false when no OwnedAlbum record exists', async () => {
        (prisma.album.findFirst as jest.Mock).mockResolvedValue({ ...BASE_ALBUM, tracks: [] });
        (prisma.ownedAlbum.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/albums/album-1');
        expect(res.status).toBe(200);
        expect(res.body.owned).toBe(false);
    });

    it('also resolves by rgMbid (passed as :id param)', async () => {
        (prisma.album.findFirst as jest.Mock).mockResolvedValue({ ...BASE_ALBUM, tracks: [] });
        (prisma.ownedAlbum.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/albums/mbid-ok-computer');
        expect(res.status).toBe(200);

        // findFirst should have been called with an OR that includes rgMbid
        const call = (prisma.album.findFirst as jest.Mock).mock.calls[0][0];
        expect(call.where.OR).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ rgMbid: 'mbid-ok-computer' }),
            ]),
        );
    });

    it('includes coverArt alias', async () => {
        const albumWithCover = { ...BASE_ALBUM, coverUrl: '/covers/ok.jpg', tracks: [] };
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(albumWithCover);
        (prisma.ownedAlbum.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/albums/album-1');
        expect(res.status).toBe(200);
        expect(res.body.coverArt).toBe('/covers/ok.jpg');
    });

    it('returns missingTracks=[] when album has no rgMbid', async () => {
        const noMbidAlbum = { ...BASE_ALBUM, rgMbid: null, tracks: [] };
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(noMbidAlbum);
        (prisma.ownedAlbum.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/albums/album-1');
        expect(res.status).toBe(200);
        expect(res.body.missingTracks).toEqual([]);
    });
});

describe('DELETE /albums/:id', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 404 when album does not exist', async () => {
        (prisma.album.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).delete('/albums/ghost-album');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Album not found');
    });

    it('deletes album and returns deletedFiles count', async () => {
        const albumToDelete = {
            ...BASE_ALBUM,
            artist: { ...BASE_ARTIST },
            tracks: [
                { id: 'track-1', title: 'Airbag', filePath: 'Radiohead/OK Computer/01.flac', album: BASE_ALBUM },
            ],
        };
        (prisma.album.findUnique as jest.Mock).mockResolvedValue(albumToDelete);
        (prisma.album.delete as jest.Mock).mockResolvedValue(albumToDelete);
        // File does not exist on disk -- no actual deletion
        (fs.existsSync as jest.Mock).mockReturnValue(false);

        const res = await request(app).delete('/albums/album-1');
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Album deleted successfully');
        expect(typeof res.body.deletedFiles).toBe('number');
        expect(prisma.album.delete).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'album-1' } }),
        );
    });

    it('increments deletedFiles when track file exists on disk', async () => {
        const albumToDelete = {
            ...BASE_ALBUM,
            artist: { ...BASE_ARTIST },
            tracks: [
                { id: 'track-1', title: 'Airbag', filePath: 'Radiohead/OK Computer/01.flac', album: BASE_ALBUM },
                { id: 'track-2', title: 'Paranoid Android', filePath: 'Radiohead/OK Computer/02.flac', album: BASE_ALBUM },
            ],
        };
        (prisma.album.findUnique as jest.Mock).mockResolvedValue(albumToDelete);
        (prisma.album.delete as jest.Mock).mockResolvedValue(albumToDelete);
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.unlinkSync as jest.Mock).mockImplementation(() => {});
        (fs.readdirSync as jest.Mock).mockReturnValue([]);

        const res = await request(app).delete('/albums/album-1');
        expect(res.status).toBe(200);
        expect(res.body.deletedFiles).toBe(2);
        expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    });
});
