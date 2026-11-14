/**
 * Discover's seed artists and album-ownership checks, on the real test database: plays, artists, albums, suggestions,
 * download jobs and failures are rows. Lidarr is a replay of replies a real Lidarr recorded (fixtures album-lookup-none,
 * discover-clear-delete, discover-sort); with no Lidarr set up, the service answers "not there" without asking.
 */
import { prisma } from '../../../utils/db';
import { DiscoverySeeding } from '../discoverySeeding';
import { artistIdentityKey } from '../../artistIdentity';
import { useLidarr, useNoLidarr } from '../../../__tests__/helpers/lidarrSettings';
import { loadScenario, startLidarrReplay, type LidarrReplay, type LidarrScenario } from '../../../__tests__/helpers/lidarrReplay';

jest.setTimeout(60_000);

const P = 'dseed_';
const USER = `${P}user`;
const OTHER_USER = `${P}other`;
const OLD_WEEK = new Date(Date.UTC(2020, 0, 6));

/** The rows a test makes; the two listeners stay for the whole file. */
async function clearRows() {
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
    await prisma.downloadJob.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
    await prisma.unavailableAlbum.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } }); // its plays go with it
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

async function artist(key: string, name: string, mbid: string | null) {
    await prisma.artist.create({
        data: { id: `${P}ar_${key}`, name, normalizedName: name.toLowerCase(), identityKey: artistIdentityKey(`${P}${name}`), mbid },
    });
}

/** A song on an album of the artist, with `plays` plays by USER over the last days, an hour apart. */
async function song(key: string, artistKey: string, plays: number) {
    await prisma.album.create({
        data: { id: `${P}al_${key}`, rgMbid: `${P}rg_${key}`, artistId: `${P}ar_${artistKey}`, identityKey: `${P}ik_${key}`, title: key, primaryType: 'Album', location: 'LIBRARY' },
    });
    await prisma.track.create({
        data: { id: `${P}t_${key}`, albumId: `${P}al_${key}`, title: key, trackNo: 1, duration: 100, filePath: `${P}${key}.flac`, fileModified: new Date(), fileSize: 1 },
    });
    await playsOf(`${P}t_${key}`, key, plays);
}

async function playsOf(trackId: string, key: string, plays: number, userId = USER) {
    await prisma.play.createMany({
        data: Array.from({ length: plays }, (_, i) => ({
            id: `${P}p_${key}_${i}`,
            userId,
            trackId,
            playedAt: new Date(Date.now() - 86_400_000 - i * 3_600_000),
        })),
    });
}

/** The seeds that are this file's artists: with no plays, the library fallback lists every library artist the worker's database holds. */
const mine = (seeds: Array<{ name: string; mbid?: string | null }>) => seeds.filter((s) => s.mbid?.startsWith(P) ?? false);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
    await clearRows();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
    await prisma.user.create({ data: { id: OTHER_USER, username: OTHER_USER, passwordHash: 'x' } });
    await useNoLidarr();
});

afterEach(clearRows);

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
    await useNoLidarr();
    await prisma.$disconnect();
});

describe('DiscoverySeeding', () => {
    describe('getSeedArtists', () => {
        /** Five songs of five artists, each played at least five times, the first the most. */
        async function fiveArtists(overrides: Record<number, { mbid: string | null }> = {}) {
            for (let i = 1; i <= 5; i++) {
                await artist(`a${i}`, `Artist ${i}`, overrides[i] ? overrides[i].mbid : `${P}mbid-${i}`);
                await song(`s${i}`, `a${i}`, 11 - i);
            }
        }

        it('seeds from the artists of the songs played enough, with their MBIDs', async () => {
            await fiveArtists();

            const result = await new DiscoverySeeding().getSeedArtists(USER);

            expect(mine(result).map((s) => s.mbid).sort()).toEqual([1, 2, 3, 4, 5].map((i) => `${P}mbid-${i}`));
            expect(mine(result)).toContainEqual({ name: 'Artist 1', mbid: `${P}mbid-1` });
        });

        it('leaves out an artist with a temp- MBID', async () => {
            await fiveArtists({ 1: { mbid: 'temp-12345' } });

            const result = await new DiscoverySeeding().getSeedArtists(USER);

            expect(result.find((s) => s.mbid === 'temp-12345')).toBeUndefined();
            expect(mine(result)).toHaveLength(4);
        });

        it('leaves out an artist with no MBID', async () => {
            await fiveArtists({ 1: { mbid: null } });

            const result = await new DiscoverySeeding().getSeedArtists(USER);

            expect(result.find((s) => s.name === 'Artist 1')).toBeUndefined();
            expect(mine(result)).toHaveLength(4);
        });

        it('falls back to the library, biggest artist first, when the listener has no plays', async () => {
            await artist('lib1', 'Library Artist One', `${P}lib-1`);
            await song('lib1a', 'lib1', 0);
            await song('lib1b', 'lib1', 0);
            await artist('lib2', 'Library Artist Two', `${P}lib-2`);
            await song('lib2a', 'lib2', 0);

            const result = await new DiscoverySeeding().getSeedArtists(USER, 1000);

            expect(mine(result).map((s) => s.name)).toEqual(['Library Artist One', 'Library Artist Two']);
        });

        it('falls back to the library when fewer than 5 songs were played enough', async () => {
            await artist('lib1', 'Library Artist', `${P}lib-1`);
            await song('lib1a', 'lib1', 2);

            const result = await new DiscoverySeeding().getSeedArtists(USER, 1000);

            expect(mine(result)).toEqual([{ name: 'Library Artist', mbid: `${P}lib-1` }]);
        });

        it("does not read another listener's plays", async () => {
            await fiveArtists();
            // Another listener plays five other artists more than this one plays its own.
            for (let i = 1; i <= 5; i++) {
                await artist(`o${i}`, `Other Artist ${i}`, `${P}mbid-o${i}`);
                await song(`o${i}`, `o${i}`, 0);
                await playsOf(`${P}t_o${i}`, `o${i}`, 30, OTHER_USER);
            }

            const result = await new DiscoverySeeding().getSeedArtists(USER, 1000);

            expect(mine(result).map((s) => s.mbid).sort()).toEqual([1, 2, 3, 4, 5].map((i) => `${P}mbid-${i}`));
        });

        it('stops at seedCount', async () => {
            for (let i = 0; i < 20; i++) {
                await artist(`m${i}`, `Artist ${i}`, `${P}mbid-m${i}`);
                await song(`m${i}`, `m${i}`, 20 - i);
            }

            const result = await new DiscoverySeeding().getSeedArtists(USER, 5);

            expect(result).toHaveLength(5);
        });

        it('lists an artist once, however many of its songs were played', async () => {
            await artist('same', 'Same Artist', `${P}mbid-same`);
            await song('same1', 'same', 10);
            await prisma.track.create({
                data: { id: `${P}t_same2`, albumId: `${P}al_same1`, title: 'same2', trackNo: 2, duration: 100, filePath: `${P}same2.flac`, fileModified: new Date(), fileSize: 1 },
            });
            await playsOf(`${P}t_same2`, 'same2', 8);
            for (const [key, plays] of [['x', 6], ['y', 5], ['z', 5]] as const) {
                await artist(key, `Other ${key}`, `${P}mbid-${key}`);
                await song(key, key, plays);
            }

            const result = await new DiscoverySeeding().getSeedArtists(USER);

            expect(mine(result).map((s) => s.name).sort()).toEqual(['Other x', 'Other y', 'Other z', 'Same Artist']);
        });
    });

    describe('isAlbumOwned', () => {
        const MBID = `${P}rg_asked`;
        const owned = (user = USER) => new DiscoverySeeding().isAlbumOwned(MBID, user);

        it('is true for an album in the OwnedAlbum table', async () => {
            await artist('o', 'Owner', null);
            await prisma.ownedAlbum.create({ data: { artistId: `${P}ar_o`, rgMbid: MBID, source: 'scan' } });

            expect(await owned()).toBe(true);
        });

        it('is true for an album in the library, and for one on Discover', async () => {
            await artist('o', 'Owner', null);
            await song('asked', 'o', 0);
            await prisma.album.update({ where: { id: `${P}al_asked` }, data: { rgMbid: MBID } });
            expect(await owned()).toBe(true);

            await prisma.album.update({ where: { id: `${P}al_asked` }, data: { location: 'DISCOVER' } });
            expect(await owned()).toBe(true);
        });

        it('is true for an album already suggested to this listener, but not for one suggested to another', async () => {
            const suggestTo = (userId: string) =>
                prisma.discoveryAlbum.create({
                    data: { userId, rgMbid: MBID, artistName: 'A', albumTitle: 'B', weekStartDate: OLD_WEEK, status: 'ACTIVE' },
                });
            await suggestTo(OTHER_USER);
            expect(await owned()).toBe(false);

            await suggestTo(USER);
            expect(await owned()).toBe(true);
        });

        it('is true for an album with a download pending or processing, false once it is settled', async () => {
            const job = (id: string, status: string) =>
                prisma.downloadJob.create({ data: { id: `${P}${id}`, userId: USER, subject: 'A - B', type: 'album', targetMbid: MBID, status } });
            await job('done', 'completed');
            await job('gone', 'failed');
            expect(await owned()).toBe(false);

            await job('busy', 'processing');
            expect(await owned()).toBe(true);

            await prisma.downloadJob.update({ where: { id: `${P}busy` }, data: { status: 'pending' } });
            expect(await owned()).toBe(true);
        });

        it('is true for an album that failed to download for this listener in the last 4 weeks, not for an older failure', async () => {
            const failed = (weeksAgo: number) =>
                prisma.unavailableAlbum.create({
                    data: {
                        userId: USER, albumMbid: MBID, artistName: 'A', albumTitle: 'B', similarity: 0.5, tier: 'medium',
                        weekStartDate: new Date(Date.now() - weeksAgo * 7 * 86_400_000),
                    },
                });
            await failed(6);
            expect(await owned()).toBe(false);

            await failed(2);
            expect(await owned()).toBe(true);
        });

        it('is false when the album is nowhere and Lidarr is not set up', async () => {
            expect(await owned()).toBe(false);
        });

        describe('against Lidarr', () => {
            let lidarr: LidarrReplay;
            const MOON_RG = '3988c875-b35f-4c3e-b143-ccb484d45347'; // Lidarr holds all of its tracks
            const NO_FILES_RG = '10e85e9b-0f07-33d4-a927-18a273f86eca'; // known to Lidarr, none of its tracks downloaded
            const UNKNOWN_RG = '00000000-0000-4000-8000-000000000000'; // unknown to Lidarr

            /**
             * The album objects a real Lidarr recorded in other scenarios, offered at the lookup by release-group id
             * that Kima makes here, plus the recorded empty answer for an id Lidarr does not know.
             */
            function lookups(): LidarrScenario {
                const recorded = (scenario: string, rg: string) =>
                    loadScenario(scenario).exchanges
                        .flatMap((e) => (Array.isArray(e.response) ? e.response : [e.response]))
                        .find((a: any) => a?.foreignAlbumId === rg);
                const lookup = (seq: number, rg: string, response: unknown) => ({
                    seq, at: '', method: 'GET', path: `/api/v1/album?foreignAlbumId=${rg}`, request: null, status: 200, response,
                });
                return {
                    name: 'seeding-lookups',
                    webhooks: [],
                    exchanges: [
                        lookup(1, MOON_RG, [recorded('discover-clear-delete', MOON_RG)]),
                        lookup(2, NO_FILES_RG, [recorded('discover-sort', NO_FILES_RG)]),
                        ...loadScenario('album-lookup-none').exchanges,
                    ],
                };
            }

            beforeAll(async () => {
                lidarr = await startLidarrReplay(lookups());
                lidarr.replay(99);
                await useLidarr(lidarr.url);
            });

            afterAll(async () => {
                await useNoLidarr();
                await lidarr.close();
            });

            it('is true when Lidarr has the album with its files', async () => {
                expect(await new DiscoverySeeding().isAlbumOwned(MOON_RG, USER)).toBe(true);
                expect(lidarr.asked.map((a) => a.path)).toContain(`/api/v1/album?foreignAlbumId=${MOON_RG}`);
            });

            it('is false when Lidarr knows the album but holds no files, or does not know it', async () => {
                expect(await new DiscoverySeeding().isAlbumOwned(NO_FILES_RG, USER)).toBe(false);
                expect(await new DiscoverySeeding().isAlbumOwned(UNKNOWN_RG, USER)).toBe(false);
            });
        });
    });
});
