/**
 * The one-time sort of albums the scanner filed by guesswork, on the real test database. Discover downloaded Brad
 * Sucks' Guess Who’s a Mess; the files spell the title with a straight apostrophe, so the scanner filed the download as
 * a library album and marked it as the listener's. Only Discover's own records (a suggestion, or a download job in a
 * Discover batch, which the real flow always writes) say an album is Discover's; Lidarr's Discover tag marks an artist
 * and is no evidence, so the sort must never ask Lidarr (a replayed Lidarr is up to prove it).
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
    /** Filed in the library, the album was marked as the listener's. */
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
                // Not yet identified: a placeholder id, which matches nothing Lidarr knows.
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

/** Discover's own download record of an album, as createDiscoveryDownloadJob writes it (a job in a Discover batch). */
async function discoverRecord(key: string, spec: AlbumSpec) {
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 1, status: "completed" } });
    await prisma.downloadJob.create({
        data: {
            userId: USER, subject: `${spec.artist.name} - ${spec.title}`, type: "album", status: "completed", targetMbid: `${P}rg_${key}`,
            discoveryBatchId: batch.id, metadata: { downloadType: "discovery", artistName: spec.artist.name, albumTitle: spec.title },
        },
    });
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

/** An empty library with one listener, and the sort not yet run. */
async function resetRun() {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null } });
    invalidateSystemSettingsCache();
}

beforeEach(async () => {
    lidarr = await startLidarrReplay(loadScenario("discover-sort"));
    await useLidarr(lidarr.url);
    await resetRun();
});

afterEach(async () => {
    await lidarr.close();
});

afterAll(async () => {
    await cleanup();
    await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null, lidarrEnabled: false } });
    await prisma.$disconnect();
});

describe("Discover downloads filed in the library", () => {
    it("go back to Discover when nothing says a listener made them theirs, and stop being anyone's", async () => {
        await albums({ gwam: discoverDownload, own: ownRecord });
        await discoverRecord("gwam", discoverDownload);
        const result = await sortDiscoverAlbums();
        expect(result).toMatchObject({ toDiscover: 1, keptByActivity: 0 });
        expect(await location("gwam")).toBe("DISCOVER");
        expect(await owned("gwam")).toBe(0);
        expect(await location("own")).toBe("LIBRARY");
        expect(await owned("own")).toBe(1);
        // Lidarr's tag is no evidence, so the sort never asks Lidarr anything.
        expect(lidarr.asked).toEqual([]);
    });

    it("stay when a listener has another album by the artist, got themselves", async () => {
        await albums({
            gwam: discoverDownload,
            outOfIt: { artist: BRAD, title: "Out of It", location: "LIBRARY", owned: true },
        });
        await discoverRecord("gwam", discoverDownload);
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 0, keptByActivity: 1 });
        expect(await location("gwam")).toBe("LIBRARY");
    });

    it("stay, both of them, when the library holds two copies of the album", async () => {
        const curly = { ...discoverDownload, title: "Guess Who’s a Mess" };
        await albums({ gwam: discoverDownload, gwamToo: curly });
        await discoverRecord("gwam", discoverDownload);
        await discoverRecord("gwamToo", curly);
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 0, keptByActivity: 2 });
        expect([await location("gwam"), await location("gwamToo")]).toEqual(["LIBRARY", "LIBRARY"]);
    });

    it("two albums whose titles have no letters are not taken for copies of one album", async () => {
        const punct = { name: "Sda Punct", mbid: null };
        await albums({
            dots: { artist: punct, title: "...", location: "LIBRARY", owned: true },
            bangs: { artist: punct, title: "!!!", location: "LIBRARY", owned: true },
        });
        const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 1 } });
        for (const key of ["dots", "bangs"]) {
            await prisma.downloadJob.create({
                data: {
                    userId: USER, subject: `Sda Punct - ${key}`, type: "album", status: "completed", targetMbid: `${P}rg_${key}`,
                    discoveryBatchId: batch.id, metadata: { downloadType: "discovery" },
                },
            });
        }
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 2, keptByActivity: 0 });
    });

    it("stay when played 3 times across 3 songs, not 3 plays of one song", async () => {
        await albums({ gwam: discoverDownload });
        await discoverRecord("gwam", discoverDownload);
        await plays("gwam", [0, 1, 2]);
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });
        expect(await location("gwam")).toBe("LIBRARY");
    });

    it("go when the plays are all one song", async () => {
        await albums({ gwam: discoverDownload });
        await discoverRecord("gwam", discoverDownload);
        await plays("gwam", [0, 0, 0, 0]);
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 1 });
        expect(await location("gwam")).toBe("DISCOVER");
    });

    it("stay when a song is liked, a song is in a playlist, or the album was edited", async () => {
        await albums({ gwam: discoverDownload });
        await discoverRecord("gwam", discoverDownload);
        await prisma.likedTrack.create({ data: { userId: USER, trackId: songId("gwam", 3) } });
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });

        await resetRun();
        await albums({ gwam: discoverDownload });
        await discoverRecord("gwam", discoverDownload);
        await prisma.playlist.create({
            data: { userId: USER, name: "mine", items: { create: { trackId: songId("gwam", 1), sort: 0 } } },
        });
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });

        await resetRun();
        await albums({ gwam: { ...discoverDownload, edited: true } });
        await discoverRecord("gwam", discoverDownload);
        expect(await sortDiscoverAlbums()).toMatchObject({ keptByActivity: 1 });
        expect(await location("gwam")).toBe("LIBRARY");
    });
});

describe("albums filed as Discover", () => {
    it("stay on Discover's download record, and stop being anyone's; one no record names goes to the library as the listener's", async () => {
        const filed: AlbumSpec = { ...discoverDownload, location: "DISCOVER", owned: true };
        await albums({
            // Filed as Discover, the album was marked as the listener's too.
            gwam: filed,
            // Lidarr tags this artist as Discover's, but no Discover record names this album: the listener's own.
            outOfIt: { artist: BRAD, title: "Out of It", location: "DISCOVER" },
        });
        await discoverRecord("gwam", filed);
        expect(await sortDiscoverAlbums()).toMatchObject({ toLibrary: 1, keptByRecords: 1 });
        expect(await location("gwam")).toBe("DISCOVER");
        expect(await owned("gwam")).toBe(0);
        expect(await location("outOfIt")).toBe("LIBRARY");
        expect(await owned("outOfIt")).toBe(1);
        expect(lidarr.asked).toEqual([]);
    });

    it("count a Discover download record from any week kept, not only the current one", async () => {
        await albums({ old: { ...discoverDownload, location: "DISCOVER", owned: false } });
        const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 8, 7)), targetSongCount: 1, status: "completed" } });
        await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 26)), targetSongCount: 1, status: "completed" } });
        await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${BRAD.name} - ${discoverDownload.title}`, type: "album", status: "completed", targetMbid: `${P}rg_old`,
                discoveryBatchId: batch.id, metadata: { downloadType: "discovery", artistName: BRAD.name, albumTitle: discoverDownload.title },
            },
        });
        expect(await sortDiscoverAlbums()).toMatchObject({ toLibrary: 0, keptByRecords: 1 });
        expect(await location("old")).toBe("DISCOVER");
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
        // This week's suggestion was a Discover download; the let-go one was a library song.
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

    it("needs no Lidarr: with Lidarr turned off the sort still follows Discover's records", async () => {
        await albums({ gwam: discoverDownload });
        await discoverRecord("gwam", discoverDownload);
        await useLidarr(lidarr.url, { lidarrEnabled: false });
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 1 });
        expect(await location("gwam")).toBe("DISCOVER");
    });

    it("is not held up by a Lidarr that does not answer: it never asks", async () => {
        await albums({ gwam: discoverDownload });
        await discoverRecord("gwam", discoverDownload);
        await lidarr.close();
        expect(await sortDiscoverAlbums()).toMatchObject({ toDiscover: 1 });
        expect(await location("gwam")).toBe("DISCOVER");
        lidarr = await startLidarrReplay(loadScenario("discover-sort"));
    });
});
