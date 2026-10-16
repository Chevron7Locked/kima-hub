/**
 * DELETE /discover/clear only deletes inside the discovery folder. Artist and
 * album names come from imports and tags and can contain `../`, so containment
 * is checked against the discovery folder, not the music root. `fs` is mocked
 * so a failure cannot delete real files.
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
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123', role: 'admin' };
        next();
    },
}));

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
import { redisClient } from '../../utils/redis';
import { closeClient } from '../../utils/closeRedisClient';

afterAll(async () => {
    // The router pulls in services/listenBrainz, which opens the shared Redis
    // client at import. Left open, Jest finishes the suite and outlives the
    // process on that socket.
    await closeClient(redisClient);
});

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
