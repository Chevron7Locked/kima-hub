/**
 * Task 7 Step 5 adversarial route tests -- POST /discover/like must be SYMMETRIC
 * to the cleanup claim guard. The find-then-update /like was a non-atomic race:
 * it `findFirst({status:"ACTIVE"})` then bare `update({where:{id}})` with no
 * status condition, so an interleaved cleanup that flipped the row to DELETED
 * (and deleted its files) could be RESURRECTED to LIKED by the bare update,
 * leaving a liked album whose tracks were already gone.
 *
 * The fix (discover.ts:612-624) replaces the bare update with a CONDITIONAL
 * claim -- updateMany({where:{id,status:"ACTIVE"},data:{status:"LIKED",...}}) --
 * and returns 409 / code:"ALBUM_GONE" when the claim matches 0 rows (the row was
 * concurrently removed). This is the most important behavioral change of the
 * task and previously had ZERO test coverage.
 *
 * Doctrine: failure / boundary path FIRST, happy path LAST. Each assertion
 * targets a discriminator that can ONLY be produced by the conditional-claim
 * code path, so the test cannot pass against the legacy bare-update handler:
 *   - count 0 -> HTTP 409 with code "ALBUM_GONE" (the bare update returns 200).
 *   - count 0 -> NO Lidarr tag-removal runs (the guard returns before it).
 *   - count 1 -> HTTP 200 and the claim where-clause was {id,status:"ACTIVE"}
 *     (the bare update used {id} only -- the missing status condition is the bug).
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
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
}));

// Module-load-time imports in discover.ts that we do not exercise here.
jest.mock('../../services/lastfm', () => ({ lastFmService: {} }));
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

describe('POST /discover/like -- symmetric claim guard (Task 7 Step 5)', () => {
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

        // DISCRIMINATOR 1: the legacy bare update({where:{id}}) would have
        // overwritten DELETED->LIKED and returned 200. The claim guard returns 409.
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALBUM_GONE');

        // DISCRIMINATOR 2: the claim where-clause must be gated on status:"ACTIVE",
        // not {id} alone -- the missing status condition IS the resurrection bug.
        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: 'da-1', status: 'ACTIVE' },
            data: { status: 'LIKED', likedAt: expect.any(Date) },
        });

        // DISCRIMINATOR 3: the body short-circuits at the guard, so NONE of the
        // post-claim side effects (Lidarr tag removal, OwnedAlbum upsert) may run.
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

        // DISCRIMINATOR: the claim ran with the ACTIVE-gated conditional where.
        expect(prisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
            where: { id: 'da-1', status: 'ACTIVE' },
            data: { status: 'LIKED', likedAt: expect.any(Date) },
        });
        // The claim succeeded, so the Lidarr discovery-tag removal must run
        // (real-name artistMbid -> the by-MBID branch).
        expect(mockRemoveDiscoveryTagByMbid).toHaveBeenCalledWith('art-mbid-1');
    });
});
