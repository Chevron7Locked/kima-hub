/**
 * POST /discover/like claims the album only while it is still ACTIVE, so a
 * concurrent cleanup cannot be undone. A lost claim answers 409 ALBUM_GONE and
 * skips the Lidarr tag removal. Real router, real database; auth, queues, Lidarr and the enrichment wake-up are stood in.
 */

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Inject an authenticated user; the real middleware would 401 without a session.
jest.mock('../../middleware/auth', () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'dlk_user' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'dlk_user', role: 'admin' };
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
jest.mock('../../utils/distributedLock', () => require('./helpers/discoverMocks').distributedLockMock());

// The Lidarr tag-removal calls in the /like body; none may run on the 409 path.
const mockGetAlbum = jest.fn();
const mockGetOrCreateDiscoveryTag = jest.fn();
const mockRemoveTagsFromArtist = jest.fn();
const mockGetArtistById = jest.fn();
jest.mock('../../services/lidarr', () => ({
    lidarrService: {
        getAlbum: (...a: any[]) => mockGetAlbum(...a),
        getArtistById: (...a: any[]) => mockGetArtistById(...a),
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

const P = 'dlk_';
const USER = `${P}user`;
const OTHER = `${P}other`;
const ALBUM_ID = `${P}rg`;
const WEEK = new Date(Date.UTC(2026, 9, 19));

const app = express();
app.use(express.json());
app.use('/discover', discoverRoutes);

async function cleanup() {
    await prisma.downloadJob.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: { in: [USER, OTHER] } } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
}

beforeEach(async () => {
    jest.clearAllMocks();
    for (const m of [mockGetAlbum, mockGetOrCreateDiscoveryTag, mockRemoveTagsFromArtist, mockGetArtistById]) m.mockReset();
    // Lidarr's artist 9 is the one the suggestion's album record belongs to.
    mockGetArtistById.mockResolvedValue({ id: 9, artistName: 'Dlk Artist', foreignArtistId: 'art-mbid-1' });
    await cleanup();
    for (const id of [USER, OTHER]) await prisma.user.create({ data: { id, username: id, passwordHash: 'x' } });
});

afterAll(async () => {
    await cleanup();
    // The router pulls in services/listenBrainz, which opens the shared Redis
    // client at import. Left open, Jest finishes the suite and outlives the
    // process on that socket.
    await closeClient(redisClient);
    await prisma.$disconnect();
});

// The stored Lidarr album id sends the success path to Lidarr's record for the album, whose artist loses the tag.
async function suggest(userId = USER, id = `${P}da`) {
    return prisma.discoveryAlbum.create({
        data: {
            id,
            userId,
            rgMbid: ALBUM_ID,
            artistMbid: 'art-mbid-1',
            lidarrAlbumId: 41,
            artistName: 'Dlk Artist',
            albumTitle: 'Dlk Album',
            weekStartDate: WEEK,
            status: 'ACTIVE',
        },
    });
}

// The scanned copy of the suggestion, which a like moves to the library.
async function seedDiscoverAlbum() {
    await prisma.artist.create({ data: { id: `${P}art`, name: 'Dlk Artist', normalizedName: 'dlk artist', identityKey: 'dlkartist' } });
    await prisma.album.create({
        data: { id: `${P}alb`, rgMbid: ALBUM_ID, artistId: `${P}art`, identityKey: `${P}ik`, title: 'Dlk Album', primaryType: 'Album', location: 'DISCOVER' },
    });
}

const statusOf = async (id: string) => (await prisma.discoveryAlbum.findUniqueOrThrow({ where: { id } })).status;

describe('POST /discover/like -- claims the album only while it is ACTIVE', () => {
    it('400 when albumId is missing (no claim attempted)', async () => {
        await suggest();

        const res = await request(app).post('/discover/like').send({});

        expect(res.status).toBe(400);
        expect(await statusOf(`${P}da`)).toBe('ACTIVE');
    });

    it('404 when no ACTIVE discovery album of the listener matches', async () => {
        // Another listener's suggestion for the same release, and the listener's own already liked one.
        await suggest(OTHER, `${P}da-other`);
        await prisma.discoveryAlbum.create({
            data: { id: `${P}da-liked`, userId: USER, rgMbid: `${P}rg-liked`, artistName: 'Dlk Artist', albumTitle: 'Liked', weekStartDate: WEEK, status: 'LIKED' },
        });

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });
        const liked = await request(app).post('/discover/like').send({ albumId: `${P}rg-liked` });

        expect(res.status).toBe(404);
        expect(liked.status).toBe(404);
        expect(await statusOf(`${P}da-other`)).toBe('ACTIVE');
        expect(mockGetAlbum).not.toHaveBeenCalled();
    });

    it('answers 409 ALBUM_GONE and skips the Lidarr tag removal when cleanup claims the row first', async () => {
        await suggest();
        await seedDiscoverAlbum();
        // The route's lookup saw the row as ACTIVE, but a concurrent cleanup marks it DELETED before the claim.
        const realFindFirst = prisma.discoveryAlbum.findFirst.bind(prisma.discoveryAlbum);
        const spy = jest.spyOn(prisma.discoveryAlbum, 'findFirst').mockImplementationOnce((async (args: any) => {
            const seen = await realFindFirst(args);
            await prisma.discoveryAlbum.update({ where: { id: `${P}da` }, data: { status: 'DELETED' } });
            return seen;
        }) as any);

        let res;
        try {
            res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });
        } finally {
            spy.mockRestore();
        }

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALBUM_GONE');

        // Gating on status ACTIVE, not the id alone, keeps a deleted album from being revived.
        const row = await prisma.discoveryAlbum.findUniqueOrThrow({ where: { id: `${P}da` } });
        expect(row.status).toBe('DELETED');
        expect(row.likedAt).toBeNull();

        // No post-claim side effect (Lidarr tag removal, library move, ownership row) runs.
        expect(mockGetAlbum).not.toHaveBeenCalled();
        expect(mockRemoveTagsFromArtist).not.toHaveBeenCalled();
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb` } })).location).toBe('DISCOVER');
        expect(await prisma.ownedAlbum.count({ where: { artistId: `${P}art` } })).toBe(0);
    });

    it('answers 200, marks the suggestion LIKED, takes the album into the library and removes the Lidarr tag', async () => {
        await suggest();
        await seedDiscoverAlbum();
        mockGetAlbum.mockResolvedValue({ id: 41, artistId: 9 });
        mockGetOrCreateDiscoveryTag.mockResolvedValue(22);
        mockRemoveTagsFromArtist.mockResolvedValue(true);

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const row = await prisma.discoveryAlbum.findUniqueOrThrow({ where: { id: `${P}da` } });
        expect(row.status).toBe('LIKED');
        expect(row.likedAt).toBeInstanceOf(Date);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb` } })).location).toBe('LIBRARY');
        expect((await prisma.ownedAlbum.findFirstOrThrow({ where: { artistId: `${P}art` } })).source).toBe('discovery_liked');
        expect(mockGetAlbum).toHaveBeenCalledWith(41);
        expect(mockRemoveTagsFromArtist).toHaveBeenCalledWith(9, [22]);
    });

    it('answers 200 when no scanned album matches yet', async () => {
        await suggest();
        mockGetAlbum.mockResolvedValue({ id: 41, artistId: 9 });
        mockGetOrCreateDiscoveryTag.mockResolvedValue(22);
        mockRemoveTagsFromArtist.mockResolvedValue(true);

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(await statusOf(`${P}da`)).toBe('LIKED');
        expect(mockGetAlbum).toHaveBeenCalledWith(41);
        expect(mockRemoveTagsFromArtist).toHaveBeenCalledWith(9, [22]);
    });
});

// The like finds the album's Lidarr record the way Discover's clearing does, and keeps the tag while another current
// suggestion needs it.
describe('POST /discover/like -- whose Lidarr artist loses the tag', () => {
    const lidarrKnowsAlbum = () => {
        mockGetAlbum.mockResolvedValue({ id: 41, artistId: 9 });
        mockGetOrCreateDiscoveryTag.mockResolvedValue(22);
        mockRemoveTagsFromArtist.mockResolvedValue(true);
    };

    // A suggestion of another album by the same artist (or one the test overrides), left ACTIVE for the week.
    const otherSuggestion = (data: Record<string, unknown>) =>
        prisma.discoveryAlbum.create({
            data: {
                userId: OTHER, rgMbid: `${P}rg-other`, artistName: 'Dlk Artist', artistMbid: 'art-mbid-1',
                albumTitle: 'Other Album', weekStartDate: WEEK, status: 'ACTIVE', ...data,
            } as any,
        });

    async function suggestWithoutLidarrId() {
        await prisma.discoveryAlbum.create({
            data: { id: `${P}da`, userId: USER, rgMbid: ALBUM_ID, artistMbid: 'art-mbid-1', artistName: 'Dlk Artist', albumTitle: 'Dlk Album', weekStartDate: WEEK, status: 'ACTIVE' },
        });
    }

    it("untags by the Lidarr id of the album's Discover download job when the suggestion stored none", async () => {
        await suggestWithoutLidarrId();
        const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: WEEK, targetSongCount: 10, status: 'completed' } });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: 'Dlk Artist - Dlk Album', type: 'album', status: 'completed', targetMbid: ALBUM_ID, lidarrAlbumId: 41, discoveryBatchId: batch.id },
        });
        lidarrKnowsAlbum();

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(mockGetAlbum).toHaveBeenCalledWith(41);
        expect(mockRemoveTagsFromArtist).toHaveBeenCalledWith(9, [22]);
    });

    it("untags by the Lidarr id another listener's suggestion of the same album stored", async () => {
        await suggestWithoutLidarrId();
        await otherSuggestion({ rgMbid: ALBUM_ID, lidarrAlbumId: 41, status: 'DELETED' });
        lidarrKnowsAlbum();

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(mockRemoveTagsFromArtist).toHaveBeenCalledWith(9, [22]);
    });

    it("does not use a listener's own download of that album as Discover's record, and untags nobody with no record", async () => {
        await suggestWithoutLidarrId();
        await prisma.downloadJob.create({
            data: { userId: USER, subject: 'Dlk Artist - Dlk Album', type: 'album', status: 'completed', targetMbid: ALBUM_ID, lidarrAlbumId: 41 },
        });

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(await statusOf(`${P}da`)).toBe('LIKED');
        expect(mockGetAlbum).not.toHaveBeenCalled();
        expect(mockRemoveTagsFromArtist).not.toHaveBeenCalled();
    });

    it("keeps the tag while another listener's current suggestion carries the same artist id", async () => {
        await suggest();
        await otherSuggestion({ artistName: 'Spelled Otherwise' });
        lidarrKnowsAlbum();

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(await statusOf(`${P}da`)).toBe('LIKED');
        expect(mockRemoveTagsFromArtist).not.toHaveBeenCalled();
    });

    it.each([[null], ['temp-77']])("keeps the tag while another listener's current suggestion of the artist's name has artist id %s", async (artistMbid) => {
        await suggest();
        await otherSuggestion({ artistName: 'DLK artist', artistMbid });
        lidarrKnowsAlbum();

        const res = await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(res.status).toBe(200);
        expect(mockRemoveTagsFromArtist).not.toHaveBeenCalled();
    });

    it('takes the tag off when the other suggestion is a same-name artist with another MusicBrainz id', async () => {
        await suggest();
        await otherSuggestion({ artistMbid: 'other-mbid' });
        lidarrKnowsAlbum();

        await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(mockRemoveTagsFromArtist).toHaveBeenCalledWith(9, [22]);
    });

    it.each([['LIKED'], ['DELETED'], ['MOVED']])('takes the tag off when the other suggestion of the artist is %s', async (status) => {
        await suggest();
        await otherSuggestion({ status });
        lidarrKnowsAlbum();

        await request(app).post('/discover/like').send({ albumId: ALBUM_ID });

        expect(mockRemoveTagsFromArtist).toHaveBeenCalledWith(9, [22]);
    });
});
