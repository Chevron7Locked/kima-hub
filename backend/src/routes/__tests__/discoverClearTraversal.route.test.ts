/**
 * DELETE /discover/clear -- the recursive delete must stay inside the discovery
 * folder.
 *
 * The fallback filesystem cleanup builds three candidate paths out of
 * `album.artistName` and `album.albumTitle` and hands the first one that exists
 * to `fs.rmSync(..., { recursive: true, force: true })`. Those two values are
 * not paths the scanner produced: they come from Spotify-imported playlist and
 * track names and from file tags, so a caller can arrange for one to contain
 * `../..`. `path.join` normalises those segments away silently.
 *
 * Containment is asserted against the DISCOVERY folder, not just the music
 * root, because `../Radiohead` resolves to a path that IS inside the music root
 * and is still entirely the wrong directory to delete.
 *
 * `fs` is mocked here (the precedent is library-albums.route.test.ts): with the
 * guard removed and a real filesystem, the traversal case resolves to `/`,
 * which exists, and the test would attempt to delete the machine.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        discoveryAlbum: {
            findMany: jest.fn(),
            updateMany: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
            findFirst: jest.fn().mockResolvedValue(null),
            delete: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        album: {
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
        },
        ownedAlbum: {
            upsert: jest.fn().mockResolvedValue({}),
            findFirst: jest.fn().mockResolvedValue(null),
        },
        track: {
            findMany: jest.fn().mockResolvedValue([]),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        downloadJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        discoveryBatch: {
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
        },
        unavailableAlbum: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn(async (fn: any) =>
            typeof fn === 'function' ? fn({}) : Promise.resolve([]),
        ),
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../middleware/auth', () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123', role: 'admin' };
        next();
    },
}));

jest.mock('../../services/lastfm', () => ({ lastFmService: {} }));
jest.mock('../../workers/queues', () => ({
    discoverQueue: {
        getJob: jest.fn(),
        add: jest.fn(),
        getActive: jest.fn().mockResolvedValue([]),
        getWaiting: jest.fn().mockResolvedValue([]),
    },
    scanQueue: { add: jest.fn() },
}));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/lidarr', () => ({ lidarrService: {} }));
jest.mock('../../utils/distributedLock', () => ({
    distributedLock: { withLock: jest.fn(async (_k: string, _t: number, fn: any) => fn()) },
}));
jest.mock('../../config', () => ({ config: { music: { musicPath: '/music' } } }));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(true),
    rmSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    unlinkSync: jest.fn(),
    rmdirSync: jest.fn(),
    statSync: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import discoverRoutes from '../discover';
import { prisma } from '../../utils/db';

const DISCOVERY_ROOT = '/music/discovery';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/discover', discoverRoutes);
    return app;
}

function activeAlbum(artistName: string, albumTitle: string) {
    return {
        id: 'da-1',
        userId: 'user-123',
        status: 'ACTIVE',
        artistName,
        albumTitle,
        rgMbid: 'rg-1',
        artistMbid: 'ar-1',
    };
}

describe('DELETE /discover/clear -- filesystem containment', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (prisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    });

    it('deletes nothing outside the discovery folder when the artist name climbs out', async () => {
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
            activeAlbum('../../../../tmp/evil', 'Album'),
        ]);

        await request(app).delete('/discover/clear');

        // Every path handed to a recursive force delete must sit under the
        // discovery folder. With the guard removed these resolve to "/" and
        // above, which is the whole point.
        for (const call of (fs.rmSync as jest.Mock).mock.calls) {
            expect(String(call[0]).startsWith(DISCOVERY_ROOT + '/')).toBe(true);
        }
        expect(fs.rmSync).not.toHaveBeenCalled();
    });

    it('deletes nothing outside it when the climb lands back inside the music root', async () => {
        // "../Radiohead" resolves to /music/Radiohead -- inside the music root,
        // so a music-root-only check would wave it through, and it is a real
        // library artist folder.
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
            activeAlbum('../Radiohead', 'OK Computer'),
        ]);

        await request(app).delete('/discover/clear');

        for (const call of (fs.rmSync as jest.Mock).mock.calls) {
            expect(String(call[0]).startsWith(DISCOVERY_ROOT + '/')).toBe(true);
        }
        expect(fs.rmSync).not.toHaveBeenCalled();
    });

    it('still deletes an ordinary discovery album folder', async () => {
        // The guard must not break the feature it protects.
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([
            activeAlbum('Boards of Canada', 'Geogaddi'),
        ]);

        await request(app).delete('/discover/clear');

        expect(fs.rmSync).toHaveBeenCalled();
        const deleted = String((fs.rmSync as jest.Mock).mock.calls[0][0]);
        expect(deleted).toBe('/music/discovery/Boards of Canada/Geogaddi');
    });
});
