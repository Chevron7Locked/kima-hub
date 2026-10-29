/**
 * POST /discover/like claims the album only while it is still ACTIVE, so a
 * concurrent cleanup cannot be undone. A lost claim answers 409 ALBUM_GONE and
 * skips the Lidarr tag removal.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        discoveryAlbum: {
            findFirst: jest.fn(),
            updateMany: jest.fn(),
        },
        album: {
            // The exact-id lookup comes first; null sends the route to the title match.
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn(),
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

// A like wakes enrichment (discoveryAlbumLifecycle.takeIntoLibrary); the worker itself is not under test.
jest.mock('../../workers/unifiedEnrichment', () => ({
    triggerEnrichmentNow: jest.fn().mockResolvedValue({ artists: 0, tracks: 0, audioQueued: 0 }),
}));
jest.mock('../../services/artistCountsService', () => ({ updateArtistCounts: jest.fn().mockResolvedValue(undefined) }));

// Modules discover.ts imports at load time that this test does not exercise.
jest.mock('../../workers/queues', () => require('./helpers/discoverMocks').discoverQueuesMock());
jest.mock('../../utils/systemSettings', () => require('./helpers/discoverMocks').systemSettingsMock());
jest.mock('../../utils/distributedLock', () => require('./helpers/discoverMocks').distributedLockMock());
jest.mock('../../config', () => require('./helpers/discoverMocks').musicConfigMock());

// The Lidarr tag-removal calls in the /like body; none may run on the 409 path.
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

// A real artistMbid (not "temp-") sends the success path through removeDiscoveryTagByMbid.
const ACTIVE_DISCOVERY_ALBUM = {
    id: 'da-1',
    userId: 'user-123',
    rgMbid: ALBUM_ID,
    artistMbid: 'art-mbid-1',
    artistName: 'Aphex Twin',
    albumTitle: 'Drukqs',
    status: 'ACTIVE',
};

describe('POST /discover/like -- claims the album only while it is ACTIVE', () => {
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
        expect(prisma.discoveryAlbum.updateMany).not.toHaveBeenCalled();
    });

    it('answers 409 ALBUM_GONE and skips the Lidarr tag removal when the claim matches no row', async () => {
        // findFirst saw the row as ACTIVE, but a concurrent cleanup marked it DELETED before the claim.
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(ACTIVE_DISCOVERY_ALBUM);
        (prisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALBUM_GONE');

        // Gating on status ACTIVE, not the id alone, keeps a deleted album from being revived.
        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: 'da-1', status: 'ACTIVE' },
            data: { status: 'LIKED', likedAt: expect.any(Date) },
        });

        // No post-claim side effect (Lidarr tag removal, OwnedAlbum upsert) runs.
        expect(mockRemoveDiscoveryTagByMbid).not.toHaveBeenCalled();
        expect(mockGetArtists).not.toHaveBeenCalled();
        expect(mockRemoveTagsFromArtist).not.toHaveBeenCalled();
        expect(prisma.ownedAlbum.upsert).not.toHaveBeenCalled();
    });

    it('answers 200 and runs the side effects when the claim matches a row', async () => {
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(ACTIVE_DISCOVERY_ALBUM);
        (prisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        mockRemoveDiscoveryTagByMbid.mockResolvedValue(true);
        // No scanned Album matches, so the OwnedAlbum branch is skipped.
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.discoveryTrack.findMany as jest.Mock).mockResolvedValue([]);

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: 'da-1', status: 'ACTIVE' },
            data: { status: 'LIKED', likedAt: expect.any(Date) },
        });
        expect(mockRemoveDiscoveryTagByMbid).toHaveBeenCalledWith('art-mbid-1');
    });
});
