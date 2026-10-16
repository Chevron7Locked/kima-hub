/**
 * POST /discover/like claims the album only while it is still ACTIVE, so a
 * concurrent cleanup cannot be undone. A lost claim answers 409 ALBUM_GONE and
 * skips the Lidarr tag removal. Failure path first.
 */

// All mocks before imports.

jest.mock('../../utils/db', () => ({
    prisma: {
        discoveryAlbum: {
            findFirst: jest.fn(),
            updateMany: jest.fn(),
        },
        album: {
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        ownedAlbum: {
            upsert: jest.fn(),
        },
        discoveryTrack: {
            findMany: jest.fn(),
        },
        play: {
            updateMany: jest.fn(),
        },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Inject an authenticated user; the real middleware would 401 without a session.
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

// Module-load-time imports in discover.ts that we do not exercise here.
jest.mock('../../workers/queues', () => ({
    discoverQueue: { getJob: jest.fn(), add: jest.fn() },
    scanQueue: { add: jest.fn() },
}));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ musicPath: '/music' }),
}));
jest.mock('../../utils/distributedLock', () => ({
    distributedLock: { withLock: jest.fn(async (_k: string, _t: number, fn: any) => fn()) },
}));
jest.mock('../../config', () => ({ config: { music: { musicPath: '/music' } } }));

// The Lidarr tag-removal calls in the /like body. We assert NONE of these run on
// the 409 (count 0) path -- the claim guard returns before reaching them.
const mockRemoveDiscoveryTagByMbid = jest.fn();
const mockGetArtists = jest.fn();
const mockGetOrCreateDiscoveryTag = jest.fn();
const mockRemoveTagsFromArtist = jest.fn();
jest.mock('../../services/lidarr', () => ({
    lidarrService: {
        removeDiscoveryTagByMbid: (...a: any[]) => mockRemoveDiscoveryTagByMbid(...a),
        getArtists: (...a: any[]) => mockGetArtists(...a),
        getOrCreateDiscoveryTag: (...a: any[]) => mockGetOrCreateDiscoveryTag(...a),
        removeTagsFromArtist: (...a: any[]) => mockRemoveTagsFromArtist(...a),
    },
}));

import express from 'express';
import request from 'supertest';
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

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/discover', discoverRoutes);
    return app;
}

const ALBUM_ID = 'rg-mbid-123';

// A real-name artistMbid (not "temp-") so the body takes the removeDiscoveryTagByMbid
// branch on the happy path -- letting us prove that branch is skipped on the 409.
const ACTIVE_DISCOVERY_ALBUM = {
    id: 'da-1',
    userId: 'user-123',
    rgMbid: ALBUM_ID,
    artistMbid: 'art-mbid-1',
    artistName: 'Aphex Twin',
    albumTitle: 'Drukqs',
    status: 'ACTIVE',
};

describe('POST /discover/like -- symmetric claim guard', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('400 when albumId is missing (no claim attempted)', async () => {
        const res = await request(app).post('/discover/like').send({});

        expect(res.status).toBe(400);
        expect(prisma.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it('404 when no ACTIVE discovery album matches (find returns null)', async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(404);
        // No claim is attempted when the album was never ACTIVE to begin with.
        expect(prisma.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it('RESURRECTION GUARD: claim matches 0 rows -> 409 ALBUM_GONE, NO Lidarr tag-removal', async () => {
        // The race: findFirst snapshotted the row as ACTIVE, but a concurrent
        // cleanup flipped it to DELETED (and deleted its files) before the claim.
        // The conditional updateMany({status:"ACTIVE"}) now matches 0 rows.
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(ACTIVE_DISCOVERY_ALBUM);
        (prisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        // A bare update({where:{id}}) would overwrite DELETED->LIKED and return
        // 200; the claim guard returns 409.
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALBUM_GONE');

        // The claim must be gated on status:"ACTIVE", not {id} alone, or a
        // deleted album could be resurrected.
        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: 'da-1', status: 'ACTIVE' },
            data: { status: 'LIKED', likedAt: expect.any(Date) },
        });

        // The handler stops at the guard: no post-claim side effect (Lidarr tag
        // removal, OwnedAlbum upsert) may run.
        expect(mockRemoveDiscoveryTagByMbid).not.toHaveBeenCalled();
        expect(mockGetArtists).not.toHaveBeenCalled();
        expect(mockRemoveTagsFromArtist).not.toHaveBeenCalled();
        expect(prisma.ownedAlbum.upsert).not.toHaveBeenCalled();
    });

    it('HAPPY PATH: claim matches 1 row -> 200, claim gated on status ACTIVE, side effects run', async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(ACTIVE_DISCOVERY_ALBUM);
        (prisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        mockRemoveDiscoveryTagByMbid.mockResolvedValue(true);
        // No scanned Album match -> the OwnedAlbum branch is skipped, but the
        // claim/tag-removal still prove the success path executes past the guard.
        (prisma.album.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryTrack.findMany as jest.Mock).mockResolvedValue([]);

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // The claim ran with the ACTIVE-gated where.
        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: 'da-1', status: 'ACTIVE' },
            data: { status: 'LIKED', likedAt: expect.any(Date) },
        });
        // The claim succeeded, so the Lidarr discovery-tag removal must run
        // (real-name artistMbid -> the by-MBID branch).
        expect(mockRemoveDiscoveryTagByMbid).toHaveBeenCalledWith('art-mbid-1');
    });
});
