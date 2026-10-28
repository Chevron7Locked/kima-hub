/**
 * All three Release Radar endpoints resolve artwork through the providers and
 * prefer it over Lidarr's unchecked Cover Art Archive address. Failure path first.
 */

// All mocks before imports.

jest.mock('../../utils/db', () => ({
    prisma: {
        album: { findMany: jest.fn().mockResolvedValue([]) },
        similarArtist: { findMany: jest.fn().mockResolvedValue([]) },
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
}));

const mockGetCalendar = jest.fn();
const mockGetMonitoredArtists = jest.fn();
jest.mock('../../services/lidarr', () => ({
    lidarrService: {
        getCalendar: (...a: any[]) => mockGetCalendar(...a),
        getMonitoredArtists: (...a: any[]) => mockGetMonitoredArtists(...a),
    },
}));

// The artwork sources, mocked at the source so the real artwork.ts runs.
const mockGetAlbumCover = jest.fn();
jest.mock('../../services/deezer', () => ({
    deezerService: {
        getAlbumCover: (...a: any[]) => mockGetAlbumCover(...a),
        getArtistImage: jest.fn().mockResolvedValue(null),
    },
}));
jest.mock('../../services/coverArt', () => ({
    coverArtService: { getCoverArt: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../../services/fanart', () => ({
    fanartService: {
        getAlbumCover: jest.fn().mockResolvedValue(null),
        getArtistImage: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock('../../utils/redis', () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue('OK'),
    },
}));

jest.mock('../../utils/ssrf', () => ({
    ...jest.requireActual('../../utils/ssrf'),
    // Redirect checking has its own test (ssrfRedirects); here the address check is stubbed and fetch is spied.
    fetchChecked: (url: string, init?: RequestInit) => fetch(url, init),
    validateUrlForFetch: jest.fn().mockResolvedValue(null),
}));

import express from 'express';
import request from 'supertest';
import releaseRoutes from '../releases';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/releases', releaseRoutes);
    return app;
}

/** What Lidarr hands out: an archive address nobody has checked. */
const LIDARR_GUESS = 'https://coverartarchive.org/release-group/album-mbid/front-500';
/** What a provider returns: an address that came from an index, not a guess. */
const FROM_DEEZER = 'https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg';

const calendarEntry = (over: Record<string, unknown> = {}) => ({
    id: 1,
    title: 'Age Of Aquarius',
    artistName: 'Perturbator',
    artistMbid: 'artist-mbid',
    albumMbid: 'album-mbid',
    releaseDate: new Date(Date.now() + 7 * 864e5).toISOString(),
    monitored: true,
    grabbed: false,
    hasFile: false,
    coverUrl: LIDARR_GUESS,
    ...over,
});

describe('the Release Radar and the artwork it promises', () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetMonitoredArtists.mockResolvedValue([]);
        mockGetAlbumCover.mockResolvedValue(null);
        // The archive does not have the address Lidarr guessed.
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockImplementation((async () =>
                ({ ok: false, status: 404 }) as unknown as Response) as never);
    });

    afterEach(() => fetchSpy.mockRestore());

    describe('GET /releases/radar', () => {
        it('never sends an address the archive cannot serve', async () => {
            mockGetCalendar.mockResolvedValue([calendarEntry()]);

            const res = await request(makeApp()).get('/releases/radar');

            expect(res.status).toBe(200);
            expect(res.body.upcoming).toHaveLength(1);
            expect(res.body.upcoming[0].coverUrl).toBeNull();
        });

        it('asks the providers, with the details they need to find the record', async () => {
            mockGetCalendar.mockResolvedValue([calendarEntry()]);

            await request(makeApp()).get('/releases/radar');

            expect(mockGetAlbumCover).toHaveBeenCalledWith(
                'Perturbator',
                'Age Of Aquarius',
            );
        });

        it('sends what the providers found rather than what Lidarr guessed', async () => {
            // The archive has nothing; Deezer has the record.
            mockGetAlbumCover.mockResolvedValue(FROM_DEEZER);
            mockGetCalendar.mockResolvedValue([calendarEntry()]);

            const res = await request(makeApp()).get('/releases/radar');

            expect(res.body.upcoming[0].coverUrl).toBe(FROM_DEEZER);
        });

        it('keeps every other field on the release untouched', async () => {
            mockGetCalendar.mockResolvedValue([calendarEntry()]);

            const res = await request(makeApp()).get('/releases/radar');

            expect(res.body.upcoming[0]).toMatchObject({
                title: 'Age Of Aquarius',
                artistName: 'Perturbator',
                albumMbid: 'album-mbid',
                status: 'upcoming',
                inLibrary: false,
            });
        });

        it('holds on to the Lidarr address when it is the only one that works', async () => {
            fetchSpy.mockImplementation((async () =>
                ({ ok: true, status: 200 }) as unknown as Response) as never);
            mockGetCalendar.mockResolvedValue([calendarEntry()]);

            const res = await request(makeApp()).get('/releases/radar');

            expect(res.body.upcoming[0].coverUrl).toBe(LIDARR_GUESS);
        });
    });

    describe('GET /releases/upcoming', () => {
        it('goes through the providers here too', async () => {
            mockGetAlbumCover.mockResolvedValue(FROM_DEEZER);
            mockGetCalendar.mockResolvedValue([calendarEntry()]);

            const res = await request(makeApp()).get('/releases/upcoming');

            expect(res.status).toBe(200);
            expect(res.body.releases[0].coverUrl).toBe(FROM_DEEZER);
        });
    });

    it('no response from any release endpoint carries a hand-built archive address', async () => {
        // A guessed coverartarchive.org/.../front-500 address must never leave
        // this server.
        mockGetCalendar.mockResolvedValue([
            calendarEntry({ id: 1 }),
            calendarEntry({ id: 2, releaseDate: new Date(Date.now() - 864e5).toISOString() }),
        ]);

        const app = makeApp();
        for (const path of ['/releases/radar', '/releases/upcoming']) {
            const res = await request(app).get(path);
            expect(JSON.stringify(res.body)).not.toContain('front-500');
        }
    });
});
