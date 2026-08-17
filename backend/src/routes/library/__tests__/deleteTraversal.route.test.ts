/**
 * The track and artist DELETE routes must not act on a path outside the music
 * root.
 *
 * The guard itself is unit-tested in trackPath.test.ts, but a helper test stays
 * green if a route stops calling the helper -- which is exactly how this class
 * of bug arrived in the first place (an unguarded join carried along when code
 * moved). These are route-level: they plant a traversing value in the data the
 * route reads and assert nothing outside the root is touched.
 *
 * Artist deletion is the sharp one: it is the path with two
 * rmSync(recursive, force) calls, and `artist.name` is an ID3 tag value.
 */

jest.mock('../../../utils/db', () => ({
    prisma: {
        track: { findUnique: jest.fn(), delete: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        artist: { findUnique: jest.fn(), delete: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        album: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        ownedAlbum: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        similarArtist: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        $transaction: jest.fn(async (fn: any) => (typeof fn === 'function' ? fn({}) : [])),
    },
}));

jest.mock('../../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../config', () => ({
    config: { music: { musicPath: '/music' } },
}));

jest.mock('../../../middleware/auth', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
    requireAdmin: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
}));

// artists.ts pulls these in at module load. Left real, their clients start
// connecting and the test process never settles.
jest.mock('../../../utils/redis', () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        setex: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
        keys: jest.fn().mockResolvedValue([]),
    },
}));
jest.mock('../../../services/lastfm', () => ({ lastFmService: {} }));
jest.mock('../../../services/deezer', () => ({ deezerService: {} }));
jest.mock('../../../services/musicbrainz', () => ({ musicBrainzService: {} }));
jest.mock('../../../services/dataCache', () => ({ dataCacheService: { get: jest.fn(), set: jest.fn() } }));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(true),
    unlinkSync: jest.fn(),
    rmSync: jest.fn(),
    rmdirSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    statSync: jest.fn().mockReturnValue({ isDirectory: () => false }),
}));

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import tracksRoutes from '../tracks';
import artistsRoutes from '../artists';
import { prisma } from '../../../utils/db';

const ROOT = '/music';
const EVIL = '../../../../tmp/evil';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', tracksRoutes);
    app.use('/', artistsRoutes);
    return app;
}

/** Every filesystem path this request touched, across all destructive calls. */
function touchedPaths(): string[] {
    const calls = [
        ...(fs.unlinkSync as jest.Mock).mock.calls,
        ...(fs.rmSync as jest.Mock).mock.calls,
        ...(fs.rmdirSync as jest.Mock).mock.calls,
    ];
    return calls.map((c) => String(c[0]));
}

describe('library delete routes stay inside the music root', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('DELETE /tracks/:id refuses a filePath that escapes the root', async () => {
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({
            id: 'tr-1',
            title: 'Airbag',
            filePath: `${EVIL}.flac`,
            album: { id: 'al-1', title: 'OK Computer', artist: { id: 'ar-1', name: 'Radiohead' } },
        });

        await request(app).delete('/tracks/tr-1');

        for (const p of touchedPaths()) {
            expect(p.startsWith(ROOT + '/')).toBe(true);
        }
        expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('DELETE /artists/:id refuses a tag-derived name that escapes the root', async () => {
        // artist.name reaches rmSync(recursive, force) through the "common
        // paths" list, and the track filePath reaches unlinkSync.
        (prisma.artist.findUnique as jest.Mock).mockResolvedValue({
            id: 'ar-1',
            name: EVIL,
            mbid: null,
            albums: [
                {
                    id: 'al-1',
                    title: 'Album',
                    tracks: [{ id: 'tr-1', filePath: `${EVIL}.flac` }],
                },
            ],
        });

        await request(app).delete('/artists/ar-1');

        for (const p of touchedPaths()) {
            expect(p.startsWith(ROOT + '/')).toBe(true);
        }
        expect(fs.rmSync).not.toHaveBeenCalled();
        expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('DELETE /artists/:id still deletes an ordinary artist folder', async () => {
        // The guard must not break the feature it protects.
        (prisma.artist.findUnique as jest.Mock).mockResolvedValue({
            id: 'ar-1',
            name: 'Radiohead',
            mbid: null,
            albums: [
                {
                    id: 'al-1',
                    title: 'OK Computer',
                    tracks: [{ id: 'tr-1', filePath: 'Radiohead/OK Computer/01.flac' }],
                },
            ],
        });

        await request(app).delete('/artists/ar-1');

        const touched = touchedPaths();
        expect(touched.length).toBeGreaterThan(0);
        for (const p of touched) {
            expect(p.startsWith(ROOT + '/')).toBe(true);
        }
    });
});
