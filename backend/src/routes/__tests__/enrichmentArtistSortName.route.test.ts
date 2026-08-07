/**
 * PUT /enrichment/artists/:id/metadata and POST /enrichment/artists/:id/reset --
 * sortName write-time sync.
 *
 * `Artist.sortName` means "where this artist files alphabetically", and every
 * artist listing in the codebase now reads it directly (see
 * routes/subsonic/__tests__/library.sort.route.test.ts and
 * routes/library/__tests__/artists.sort.route.test.ts). But `sortName` is
 * computed from `name` alone -- an admin override to `displayName` used to
 * leave it untouched, so an artist renamed via this endpoint would keep
 * filing under the name the override was meant to replace, in every listing
 * at once. These two endpoints are the only writers of `displayName`, so
 * they are the only places that can keep `sortName` in sync with it.
 */

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: 'admin-1', role: 'admin' };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: 'admin-1', role: 'admin' };
        next();
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/redis', () => ({
    redisClient: { get: jest.fn(), setex: jest.fn(), del: jest.fn() },
}));

jest.mock('../../services/enrichment', () => ({ enrichmentService: {} }));
jest.mock('../../workers/unifiedEnrichment', () => ({
    getEnrichmentProgress: jest.fn(),
    runFullEnrichment: jest.fn(),
    reRunArtistsOnly: jest.fn(),
    reRunMoodTagsOnly: jest.fn(),
    resetAllEnrichmentData: jest.fn(),
    triggerEnrichmentNow: jest.fn(),
}));
jest.mock('../../services/enrichmentState', () => ({ enrichmentStateService: {} }));
jest.mock('../../services/enrichmentFailureService', () => ({
    enrichmentFailureService: { clearAllFailures: jest.fn(), deleteFailures: jest.fn() },
}));
jest.mock('../../utils/systemSettings', () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock('../../services/rateLimiter', () => ({ rateLimiter: {} }));
jest.mock('../../services/imageBackfill', () => ({ repairBrokenCovers: jest.fn() }));
jest.mock('../../services/mbidReassign', () => ({
    DuplicateMbidError: class DuplicateMbidError extends Error {},
    reassignAlbumRgMbid: jest.fn(),
    reassignArtistMbid: jest.fn(),
}));

jest.mock('../../utils/db', () => ({
    prisma: {
        artist: { findUnique: jest.fn(), update: jest.fn() },
    },
}));

import express from 'express';
import request from 'supertest';
import router from '../enrichment';
import { prisma } from '../../utils/db';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/enrichment', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    (prisma.artist.update as jest.Mock).mockImplementation(async ({ data }: any) => ({
        id: 'artist-1',
        ...data,
        albums: [],
    }));
});

describe('PUT /enrichment/artists/:id/metadata -- sortName follows displayName', () => {
    it('sets sortName from the override, article-stripped, not from the canonical name', async () => {
        await request(makeApp())
            .put('/enrichment/artists/artist-1/metadata')
            .send({ name: 'The Artist Formerly Known As Prince' })
            .expect(200);

        expect(prisma.artist.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                displayName: 'The Artist Formerly Known As Prince',
                sortName: 'artist formerly known as prince',
            }),
        }));
        // The canonical name was never needed for this branch -- no lookup.
        expect(prisma.artist.findUnique).not.toHaveBeenCalled();
    });

    it('reverts sortName to the canonical name when the override is cleared to an empty string', async () => {
        (prisma.artist.findUnique as jest.Mock).mockResolvedValue({ name: 'The Beatles' });

        await request(makeApp())
            .put('/enrichment/artists/artist-1/metadata')
            .send({ name: '' })
            .expect(200);

        expect(prisma.artist.findUnique).toHaveBeenCalledWith({
            where: { id: 'artist-1' },
            select: { name: true },
        });
        expect(prisma.artist.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                displayName: '',
                sortName: 'beatles',
            }),
        }));
    });

    it('reverts sortName to the canonical name when the override is cleared to null', async () => {
        (prisma.artist.findUnique as jest.Mock).mockResolvedValue({ name: 'Los Lobos' });

        await request(makeApp())
            .put('/enrichment/artists/artist-1/metadata')
            .send({ name: null })
            .expect(200);

        expect(prisma.artist.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                displayName: null,
                sortName: 'lobos',
            }),
        }));
    });

    it('does not touch sortName at all when name is not part of the request', async () => {
        await request(makeApp())
            .put('/enrichment/artists/artist-1/metadata')
            .send({ bio: 'Some bio text' })
            .expect(200);

        const call = (prisma.artist.update as jest.Mock).mock.calls[0][0];
        expect(call.data).not.toHaveProperty('sortName');
        expect(call.data).not.toHaveProperty('displayName');
    });
});

describe('POST /enrichment/artists/:id/reset -- sortName follows the cleared override', () => {
    it('resets sortName to the canonical name alongside displayName', async () => {
        (prisma.artist.findUnique as jest.Mock).mockResolvedValue({ id: 'artist-1', name: 'The Beatles' });

        await request(makeApp())
            .post('/enrichment/artists/artist-1/reset')
            .expect(200);

        expect(prisma.artist.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                displayName: null,
                sortName: 'beatles',
            }),
        }));
    });

    it('404s without touching sortName when the artist does not exist', async () => {
        (prisma.artist.findUnique as jest.Mock).mockResolvedValue(null);

        await request(makeApp())
            .post('/enrichment/artists/missing/reset')
            .expect(404);

        expect(prisma.artist.update).not.toHaveBeenCalled();
    });
});
