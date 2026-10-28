/**
 * The one-time sort of albums the old scanner filed by guesswork, on the real test database, against what a real
 * Lidarr said (fixtures/lidarr/discover-sort.json): on the scratch rig (scripts/record-lidarr.ts), Discover downloaded
 * Brad Sucks' Guess Who’s a Mess through Lidarr 3.1, which tagged the artist as Discover's and holds that album's 11
 * files and no others. The old scanner filed that download as a library album (its files spell the title with a
 * straight apostrophe) and marked it as the listener's.
 */
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { loadScenario, startLidarrReplay, type LidarrReplay } from "../../__tests__/helpers/lidarrReplay";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";
import { sortDiscoverAlbums } from "../discovery/sortDiscoverAlbums";

jest.setTimeout(60_000);

const P = "sda_";
const USER = `${P}user`;
const BRAD = { name: "Brad Sucks", mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55" };
const SONGS = 4;

let lidarr: LidarrReplay;

interface AlbumSpec {
    artist: { name: string; mbid: string | null };
    title: string;
    location: "LIBRARY" | "DISCOVER";
    /** The old scanner marked every album it filed in the library as the listener's. */
    owned?: boolean;
    edited?: boolean;
}

const songId = (key: string, i: number) => `${P}trk_${key}_${i}`;
const location = async (key: string) => (await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb_${key}` } })).location;
const owned = (key: string) => prisma.ownedAlbum.count({ where: { rgMbid: `${P}rg_${key}` } });

async function albums(specs: Record<string, AlbumSpec>) {
    for (const [key, spec] of Object.entries(specs)) {
        const artistId = `${P}art_${spec.artist.name.replace(/\W/g, "")}`;
        await prisma.artist.upsert({
            where: { id: artistId },
            create: { id: artistId, name: spec.artist.name, normalizedName: spec.artist.name.toLowerCase(), identityKey: artistId, mbid: spec.artist.mbid },
            update: {},
        });
        await prisma.album.create({
            data: {
                id: `${P}alb_${key}`,
                // Not yet identified: the old scanner's own placeholder id, which matches nothing Lidarr knows.
                rgMbid: `${P}rg_${key}`,
                artistId,
                identityKey: `${P}ik_${key}`,
                title: spec.title,
                primaryType: "Album",
                location: spec.location,
                hasUserOverrides: spec.edited ?? false,
            },
        });
        await prisma.track.createMany({
            data: Array.from({ length: SONGS }, (_, i) => ({
                id: songId(key, i),
                albumId: `${P}alb_${key}`,
                title: `${spec.title} ${i + 1}`,
                trackNo: i + 1,
                duration: 200,
                filePath: `/tmp/${P}${key}_${i}.mp3`,
                fileModified: new Date(),
                fileSize: 1000,
            })),
        });
        if (spec.owned) await prisma.ownedAlbum.create({ data: { artistId, rgMbid: `${P}rg_${key}`, source: "native_scan" } });
    }
}

const discoverDownload: AlbumSpec = { artist: BRAD, title: "Guess Who's a Mess", location: "LIBRARY", owned: true };
const ownRecord: AlbumSpec = { artist: { name: "Sda Own Artist", mbid: null }, title: "Own Record", location: "LIBRARY", owned: true };

async function plays(key: string, songs: number[]) {
    for (const i of songs) await prisma.play.create({ data: { userId: USER, trackId: songId(key, i), heard: true } });
}

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { rgMbid: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    lidarr = await startLidarrReplay(loadScenario("discover-sort"));
    await useLidarr(lidarr.url);
    await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null } });
    invalidateSystemSettingsCache();
});

afterEach(async () => {
    await lidarr.close();
});

afterAll(async () => {
    await cleanup();
    await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null, lidarrEnabled: false } });
    await prisma.$disconnect();
});

describe("Discover downloads the old scanner put in the library", () => {
    it("go back to Discover when nothing says a listener made them theirs, and stop being anyone's", async () => {
        await albums({ gwam: discoverDownload, own: ownRecord });
        const result = await sortDiscoverAlbums();
        expect(result).toMatchObject({ toDiscover: 1, keptByActivity: 0, lidarr: "read" });
        expect(await location("gwam")).toBe("DISCOVER");
        expect(await owned("gwam")).toBe(0);
        expect(await location("own")).toBe("LIBRARY");
        expect(await owned("own")).toBe(1);
        // Asked Lidarr which artists carry the Discover tag, and what it holds for them.
        expect(lidarr.asked.map((a) => `${a.method} ${a.path}`)).toEqual(
            expect.arrayContaining(["GET /api/v1/tag", "GET /api/v1/artist", "GET /api/v1/album?artistId=65"]),
        );
    });

    it("stay when a listener has another album by the artist, got themselves", async () => {
        await albums({
            gwam: discoverDownload,
            outOfIt: { artist: BRAD, title: "Out of It", location: "LIBRARY", owned: true },
        });
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 0, keptByActivity: 1 });
        expect(await location("gwam")).toBe("LIBRARY");
    });

    it("stay, both of them, when the library holds two copies of the album", async () => {
        await albums({ gwam: discoverDownload, gwamToo: { ...discoverDownload, title: "Guess Who’s a Mess" } });
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 0, keptByActivity: 2 });
        expect([await location("gwam"), await location("gwamToo")]).toEqual(["LIBRARY", "LIBRARY"]);
    });

    it("stay when played 3 times across 3 songs, not 3 plays of one song", async () => {
        await albums({ gwam: discoverDownload });
        await plays("gwam", [0, 1, 2]);
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });
        expect(await location("gwam")).toBe("LIBRARY");
    });

    it("go when the plays are all one song", async () => {
        await albums({ gwam: discoverDownload });
        await plays("gwam", [0, 0, 0, 0]);
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 1 });
        expect(await location("gwam")).toBe("DISCOVER");
    });

    it("stay when a song is liked, a song is in a playlist, or the album was edited", async () => {
        await albums({ gwam: discoverDownload });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: songId("gwam", 3) } });
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });

        await cleanup();
        await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
        await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null } });
        invalidateSystemSettingsCache();
        await albums({ gwam: discoverDownload });
        await prisma.playlist.create({
            data: { userId: USER, name: "mine", items: { create: { trackId: songId("gwam", 1), sort: 0 } } },
        });
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });

        await cleanup();
        await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
        await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null } });
        invalidateSystemSettingsCache();
        await albums({ gwam: { ...discoverDownload, edited: true } });
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });
        expect(await location("gwam")).toBe("LIBRARY");
    });
});

describe("albums the old scanner filed as Discover", () => {
    it("stay when Lidarr downloaded them for Discover, and stop being anyone's; the listener's own go to the library", async () => {
        await albums({
            // The old scanner marked Discover albums as its own too.
            gwam: { ...discoverDownload, location: "DISCOVER", owned: true },
            // Lidarr knows this album but downloaded none of it: the listener got it some other way.
            outOfIt: { artist: BRAD, title: "Out of It", location: "DISCOVER" },
        });
        expect(await sortDiscoverAlbums()).toMatchObject({ toLibrary: 1, keptByLidarr: 1 });
        expect(await location("gwam")).toBe("DISCOVER");
        expect(await owned("gwam")).toBe(0);
        expect(await location("outOfIt")).toBe("LIBRARY");
    });

    it("follow Discover's download records while they exist; a suggestion alone says nothing", async () => {
        await albums({
            current: { artist: { name: "Sda Suggested Now", mbid: null }, title: "This Week", location: "DISCOVER" },
            liked: { artist: { name: "Sda Liked", mbid: null }, title: "Kept Album", location: "DISCOVER" },
            rejected: { artist: { name: "Sda Rejected", mbid: null }, title: "Let Go", location: "DISCOVER" },
            requested: { artist: { name: "Sda Requested", mbid: null }, title: "You Asked", location: "DISCOVER" },
            yours: { artist: { name: "Sda Yours", mbid: null }, title: "Your Own Album", location: "DISCOVER" },
        });
        for (const [artistName, albumTitle, status] of [
            ["SDA SUGGESTED NOW", "This Week", "ACTIVE"],
            ["Sda Liked", "Kept Album", "LIKED"],
            ["Sda Rejected", "Let Go", "DELETED"],
        ] as const) {
            await prisma.discoveryAlbum.create({
                data: { userId: USER, rgMbid: `${P}sugg_${albumTitle}`, artistName, albumTitle, weekStartDate: new Date(Date.UTC(2026, 9, 19)), status },
            });
        }
        // This week's suggestion was a Discover download; the let-go one was the old playlist's library song.
        await prisma.downloadJob.create({
            data: {
                userId: USER,
                subject: "Sda Suggested Now - This Week",
                type: "album",
                status: "completed",
                discoveryBatchId: (await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 1 } })).id,
                metadata: { downloadType: "discovery", artistName: "Sda Suggested Now", albumTitle: "This Week" },
            },
        });
        await prisma.downloadJob.create({
            data: {
                userId: USER,
                subject: "Sda Requested - You Asked",
                type: "album",
                status: "completed",
                metadata: { downloadType: "library", artistName: "Sda Requested", albumTitle: "You Asked" },
            },
        });
        expect(await sortDiscoverAlbums()).toMatchObject({ toLibrary: 4, keptByRecords: 1 });
        expect(await location("current")).toBe("DISCOVER");
        expect([await location("rejected"), await location("liked"), await location("requested"), await location("yours")]).toEqual([
            "LIBRARY",
            "LIBRARY",
            "LIBRARY",
            "LIBRARY",
        ]);
    });
});

describe("the sort itself", () => {
    it("runs once", async () => {
        await albums({ gwam: discoverDownload });
        expect(await sortDiscoverAlbums()).not.toBeNull();
        await prisma.album.update({ where: { id: `${P}alb_gwam` }, data: { location: "LIBRARY" } });
        expect(await sortDiscoverAlbums()).toBeNull();
        expect(await location("gwam")).toBe("LIBRARY");
    });

    it("without Lidarr, Lidarr says nothing: the download stays where it is", async () => {
        await albums({ gwam: discoverDownload });
        await useLidarr(lidarr.url, { lidarrEnabled: false });
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 0, lidarr: "not set up" });
        expect(await location("gwam")).toBe("LIBRARY");
    });

    it("when Lidarr does not answer, moves nothing and tries again at the next start", async () => {
        await albums({ gwam: discoverDownload });
        await lidarr.close();
        expect(await sortDiscoverAlbums()).toBeNull();
        expect(await location("gwam")).toBe("LIBRARY");
        lidarr = await startLidarrReplay(loadScenario("discover-sort"));
        await useLidarr(lidarr.url);
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 1 });
    });
});
