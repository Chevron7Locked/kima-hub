/**
 * The album-delete module through its interface: what goes with an album, what is told after it, and what becomes of an
 * artist's keeps. Real database and event bus; no mocks.
 */
import { prisma } from "../../../utils/db";
import { eventBus, type SSEEvent } from "../../eventBus";
import { markerMoves } from "../../../__tests__/helpers/libraryMarker";
import { ownedIndexVersion } from "../../discovery/ownedIndexVersion";
import { deleteAlbums, deleteArtists, deleteEmptyArtists, deleteSongs } from "../albumDelete";

const P = "zz-albumdel_";
const id = (n: string) => `${P}${n}`;

/** Everything the tests made except the listening user. */
async function clear(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryTrack" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryAlbum" WHERE id LIKE '${P}%'`);
    await prisma.playlist.deleteMany({ where: { userId: id("user") } });
    await prisma.shareLink.deleteMany({ where: { token: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

async function artist(n: string): Promise<string> {
    return (await prisma.artist.create({ data: { id: id(n), name: `${P}${n}`, identityKey: id(`${n}-key`) } })).id;
}

/** An album of `songs` songs under `artistId`, each song flagged missing or not. */
async function album(n: string, artistId: string, opts: { location?: "LIBRARY" | "DISCOVER"; songs?: number; missing?: boolean } = {}) {
    const { location = "LIBRARY", songs = 1, missing = false } = opts;
    await prisma.album.create({
        data: { id: id(n), rgMbid: id(`${n}-rg`), artistId, identityKey: id(`${n}-key`), title: `${P}${n}`, primaryType: "Album", location },
    });
    for (let i = 0; i < songs; i++) {
        await prisma.track.create({
            data: {
                id: id(`${n}-t${i}`), albumId: id(n), title: `${P}${n} ${i}`, trackNo: i + 1, duration: 100,
                filePath: `/${P}outside/${n}/${i}.flac`, fileModified: new Date(), fileSize: 1, ...(missing ? { missingSince: new Date() } : {}),
            },
        });
    }
}

const keep = (artistId: string, rgMbid: string, source = "native_scan") => prisma.ownedAlbum.create({ data: { artistId, rgMbid, source } });
const holdsSong = (name: string, trackId: string) =>
    prisma.playlist.create({ data: { userId: id("user"), name: `${P}${name}`, items: { create: [{ trackId, sort: 0, rank: "a" }] } } });
const told = () => heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload);

const heard: SSEEvent[] = [];
let stop: () => void;

beforeAll(async () => {
    await clear();
    await prisma.user.deleteMany({ where: { id: id("user") } });
    await prisma.user.create({ data: { id: id("user"), username: id("user"), passwordHash: "x" } });
    stop = eventBus.subscribe(id("user"), { send: (event) => (heard.push(event), true) });
});
beforeEach(() => {
    heard.length = 0;
});
afterEach(clear);
afterAll(async () => {
    stop();
    await clear();
    await prisma.user.deleteMany({ where: { id: id("user") } });
});

describe("deleteAlbums", () => {
    it("takes the albums, their songs and their Discover song records", async () => {
        const a = await artist("a");
        await album("one", a, { songs: 2 });
        await album("two", a);
        await album("stays", a);
        await prisma.discoveryAlbum.create({ data: { id: id("da"), userId: id("user"), rgMbid: id("one-rg"), artistName: "x", albumTitle: "x", weekStartDate: new Date() } });
        await prisma.discoveryTrack.create({ data: { id: id("dt"), discoveryAlbumId: id("da"), trackId: id("one-t0"), fileName: "a", filePath: "a" } });

        const result = await deleteAlbums([id("one"), id("two")]);

        expect(result.albums).toBe(2);
        expect(await prisma.album.findMany({ where: { id: { startsWith: P } }, select: { id: true } })).toEqual([{ id: id("stays") }]);
        expect(await prisma.track.count({ where: { id: { startsWith: id("one") } } })).toBe(0);
        expect(await prisma.discoveryTrack.count({ where: { id: id("dt") } })).toBe(0);
    });

    it("leaves the keep: an album gone is still one the listener kept, so Discover never offers it again", async () => {
        const a = await artist("a");
        await album("lib", a);
        await album("other", a);
        await keep(a, id("lib-rg"), "discovery_liked");

        await deleteAlbums([id("lib")]);

        expect(await prisma.ownedAlbum.findMany({ where: { artistId: a } })).toEqual([{ artistId: a, rgMbid: id("lib-rg"), source: "discovery_liked" }]);
    });

    it("tells the playlists that held its songs, once, and not the others", async () => {
        const a = await artist("a");
        await album("gone", a, { songs: 2 });
        await album("kept", a);
        const holding = await prisma.playlist.create({
            data: { userId: id("user"), name: `${P}holds`, items: { create: [{ trackId: id("gone-t0"), sort: 0, rank: "a" }, { trackId: id("gone-t1"), sort: 1, rank: "b" }] } },
        });
        const other = await holdsSong("other", id("kept-t0"));

        await deleteAlbums([id("gone")]);

        expect(told()).toEqual([{ playlistId: holding.id, deleted: false }]);
        expect(await prisma.playlistItem.count({ where: { playlistId: other.id } })).toBe(1);
    });

    it("recounts the artist's counts", async () => {
        const a = await artist("a");
        await album("one", a, { songs: 2 });
        await album("two", a, { songs: 1 });
        await prisma.artist.update({ where: { id: a }, data: { libraryAlbumCount: 2, totalTrackCount: 3 } });

        await deleteAlbums([id("one")]);

        expect(await prisma.artist.findUniqueOrThrow({ where: { id: a }, select: { libraryAlbumCount: true, totalTrackCount: true } })).toEqual({
            libraryAlbumCount: 1,
            totalTrackCount: 1,
        });
    });

    it("makes Discover's owned-album snapshot rebuild", async () => {
        const a = await artist("a");
        await album("one", a);
        const before = ownedIndexVersion();
        await deleteAlbums([id("one")]);
        expect(ownedIndexVersion()).toBeGreaterThan(before);
    });

    it("moves the library-changed marker for an album a client lists, and not for Discover's, a missing song's or an empty one", async () => {
        const a = await artist("a");
        await album("listed", a);
        await album("discover", a, { location: "DISCOVER" });
        await album("missing", a, { missing: true });
        await album("empty", a, { songs: 0 });

        expect(await markerMoves(() => deleteAlbums([id("discover"), id("missing"), id("empty")]))).toBe(false);
        expect(await markerMoves(() => deleteAlbums([id("listed")]))).toBe(true);
    });

    it("with `only`, leaves an album at another location alone", async () => {
        const a = await artist("a");
        await album("lib", a);
        await album("dis", a, { location: "DISCOVER" });

        const result = await deleteAlbums([id("lib"), id("dis")], { only: "DISCOVER" });

        expect(result.albums).toBe(1);
        expect(await prisma.album.findMany({ where: { id: { startsWith: P } }, select: { id: true } })).toEqual([{ id: id("lib") }]);
    });

    it("inside the caller's transaction, tells nothing until settled, and nothing at all if the transaction rolls back", async () => {
        const a = await artist("a");
        await album("gone", a);
        await holdsSong("holds", id("gone-t0"));
        const before = ownedIndexVersion();

        await expect(
            prisma.$transaction(async (tx) => {
                const result = await deleteAlbums([id("gone")], { within: tx });
                expect(result.albums).toBe(1);
                expect(heard).toEqual([]);
                expect(ownedIndexVersion()).toBe(before);
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");

        expect(await prisma.album.count({ where: { id: id("gone") } })).toBe(1);
        expect(heard).toEqual([]);

        const result = await prisma.$transaction((tx) => deleteAlbums([id("gone")], { within: tx }));
        expect(heard).toEqual([]);
        await result.settle();
        expect(told()).toHaveLength(1);
        expect(ownedIndexVersion()).toBeGreaterThan(before);
    });

    it("an id no album has is nothing to delete", async () => {
        expect((await deleteAlbums([id("nope")])).albums).toBe(0);
    });
});

describe("deleteArtists", () => {
    it("takes the artist with its albums, songs, similar links and keeps, and tells the playlists", async () => {
        const a = await artist("a");
        const b = await artist("b");
        await album("one", a, { songs: 2 });
        await keep(a, id("one-rg"));
        await keep(a, id("missing-rg"));
        await prisma.similarArtist.create({ data: { fromArtistId: a, toArtistId: b } });
        await holdsSong("holds", id("one-t1"));

        const result = await deleteArtists([a]);

        expect(result.artists).toBe(1);
        expect(await prisma.artist.count({ where: { id: a } })).toBe(0);
        expect(await prisma.album.count({ where: { id: id("one") } })).toBe(0);
        expect(await prisma.ownedAlbum.count({ where: { artistId: a } })).toBe(0);
        expect(await prisma.similarArtist.count({ where: { OR: [{ fromArtistId: a }, { toArtistId: a }] } })).toBe(0);
        expect(told()).toHaveLength(1);
        expect(await prisma.artist.count({ where: { id: b } })).toBe(1);
    });

    it("with `keepsTo`, hands the keeps to the successor, the more protective source standing on a clash", async () => {
        const gone = await artist("gone");
        const heir = await artist("heir");
        await keep(gone, id("only-gone-rg"), "discovery_liked");
        await keep(gone, id("both-rg"), "native_scan");
        await keep(heir, id("both-rg"), "discovery_liked");

        await deleteArtists([gone], { keepsTo: heir });

        expect(await prisma.artist.count({ where: { id: gone } })).toBe(0);
        const held = await prisma.ownedAlbum.findMany({ where: { artistId: heir }, orderBy: { rgMbid: "asc" } });
        expect(held).toEqual([
            { artistId: heir, rgMbid: id("both-rg"), source: "native_scan" },
            { artistId: heir, rgMbid: id("only-gone-rg"), source: "discovery_liked" },
        ]);
    });

    it("with `keepsTo`, recounts the successor, which may hold the albums the merged artist had", async () => {
        const gone = await artist("gone");
        const heir = await artist("heir");
        await album("moved", heir, { songs: 2 });
        await prisma.artist.update({ where: { id: heir }, data: { libraryAlbumCount: 0, totalTrackCount: 0 } });

        await deleteArtists([gone], { keepsTo: heir });

        expect(await prisma.artist.findUniqueOrThrow({ where: { id: heir }, select: { libraryAlbumCount: true, totalTrackCount: true } })).toEqual({
            libraryAlbumCount: 1,
            totalTrackCount: 2,
        });
    });

    it("moves the library-changed marker only for an artist a client lists", async () => {
        const quiet = await artist("quiet");
        await album("dis", quiet, { location: "DISCOVER" });
        const loud = await artist("loud");
        await album("lib", loud);

        expect(await markerMoves(() => deleteArtists([quiet]))).toBe(false);
        expect(await markerMoves(() => deleteArtists([loud]))).toBe(true);
    });
});

describe("deleteEmptyArtists", () => {
    it("removes artists with no albums, with their keeps, and leaves one that still has an album", async () => {
        const bare = await artist("bare");
        const kept = await artist("kept");
        const busy = await artist("busy");
        await album("one", busy);
        await keep(kept, id("kept-rg"));

        const removed = await deleteEmptyArtists();

        expect(removed).toBeGreaterThanOrEqual(2);
        expect(await prisma.artist.count({ where: { id: { in: [bare, kept] } } })).toBe(0);
        expect(await prisma.ownedAlbum.count({ where: { artistId: kept } })).toBe(0);
        expect(await prisma.artist.count({ where: { id: busy } })).toBe(1);
    });
});

const link = (n: string, entityType: "album" | "track" | "playlist", entityId: string) =>
    prisma.shareLink.create({ data: { token: id(n), entityType, entityId, createdBy: id("user") } });
const linksLeft = async () => (await prisma.shareLink.findMany({ where: { token: { startsWith: P } }, select: { token: true } })).map((l) => l.token).sort();
const aSong = (n: string, albumId: string) =>
    prisma.track.create({
        data: { id: id(n), albumId, title: n, trackNo: 1, duration: 1, filePath: `/${P}outside/${n}.flac`, fileModified: new Date(), fileSize: 1 },
    });

describe("a song or album added after the list was made", () => {
    it("keeps an album that got a song since it was listed empty, and takes the ones still empty", async () => {
        const a = await artist("a");
        await album("stillEmpty", a, { songs: 0 });
        await album("filled", a, { songs: 0 });
        await aSong("late", id("filled"));

        const result = await deleteAlbums([id("stillEmpty"), id("filled")], { onlyEmpty: true });

        expect(result.albums).toBe(1);
        expect(await prisma.album.findMany({ where: { id: { startsWith: P } }, select: { id: true } })).toEqual([{ id: id("filled") }]);
        expect(await prisma.track.count({ where: { id: id("late") } })).toBe(1);
    });

    it("keeps an artist that got an album since it was listed empty", async () => {
        const quiet = await artist("quiet");
        const busy = await artist("busy");
        await album("late", busy, { songs: 1 });

        const result = await deleteArtists([quiet, busy], { onlyEmpty: true });

        expect(result.artists).toBe(1);
        expect(await prisma.artist.count({ where: { id: busy } })).toBe(1);
        expect(await prisma.album.count({ where: { id: id("late") } })).toBe(1);
    });

    it("waits for a scan that is adding a song at that moment, and then leaves the album", async () => {
        const a = await artist("a");
        await album("racing", a, { songs: 0 });
        let adding!: () => void;
        const added = new Promise<void>((resolve) => (adding = resolve));
        // The scan: inserts the song (taking the album row's share lock through the foreign key), then commits late.
        const scan = prisma.$transaction(async (tx) => {
            await tx.track.create({
                data: { id: id("scanned"), albumId: id("racing"), title: "s", trackNo: 1, duration: 1, filePath: `/${P}outside/s.flac`, fileModified: new Date(), fileSize: 1 },
            });
            adding();
            await new Promise((resolve) => setTimeout(resolve, 300));
        });
        await added;

        const deleting = deleteAlbums([id("racing")], { onlyEmpty: true });
        await scan;
        const result = await deleting;

        expect(result.albums).toBe(0);
        expect(await prisma.album.count({ where: { id: id("racing") } })).toBe(1);
        expect(await prisma.track.count({ where: { id: id("scanned") } })).toBe(1);
    });
});

describe("a delete locks what it removes, for every caller", () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("an album delete waits for a scan filing a song into the album, then takes that song and its share link too", async () => {
        const a = await artist("a");
        await album("racing", a, { songs: 1 });
        let filing!: () => void;
        const filed = new Promise<void>((resolve) => (filing = resolve));
        // The scan: files a song under the album (taking its row's share lock through the foreign key), names it in a
        // share link, then commits late.
        const scan = prisma.$transaction(async (tx) => {
            await tx.track.create({
                data: { id: id("scanned"), albumId: id("racing"), title: "s", trackNo: 9, duration: 1, filePath: `/${P}outside/s.flac`, fileModified: new Date(), fileSize: 1 },
            });
            await tx.shareLink.create({ data: { token: id("tok-scanned"), entityType: "track", entityId: id("scanned"), createdBy: id("user") } });
            filing();
            await wait(300);
        });
        await filed;

        const deleting = deleteAlbums([id("racing")]);
        await scan;
        const result = await deleting;

        expect(result.albums).toBe(1);
        expect(await prisma.album.count({ where: { id: id("racing") } })).toBe(0);
        expect(await prisma.track.count({ where: { id: { startsWith: id("racing") } } })).toBe(0);
        expect(await prisma.track.count({ where: { id: id("scanned") } })).toBe(0);
        expect(await prisma.shareLink.count({ where: { token: id("tok-scanned") } })).toBe(0);
    });

    it("a scan filing a song into an album that is being deleted waits, then finds the album gone", async () => {
        const a = await artist("a");
        await album("going", a, { songs: 1 });
        let deleted!: () => void;
        const done = new Promise<void>((resolve) => (deleted = resolve));
        // The delete, in the caller's transaction, committing late.
        const deleting = prisma.$transaction(async (tx) => {
            const deletion = await deleteAlbums([id("going")], { within: tx });
            deleted();
            await wait(300);
            return deletion;
        });
        await done;

        const filing = prisma.track
            .create({
                data: { id: id("late"), albumId: id("going"), title: "late", trackNo: 9, duration: 1, filePath: `/${P}outside/late.flac`, fileModified: new Date(), fileSize: 1 },
            })
            .then(() => "filed", () => "refused");
        await deleting;

        expect(await filing).toBe("refused");
        expect(await prisma.album.count({ where: { id: id("going") } })).toBe(0);
        expect(await prisma.track.count({ where: { id: id("late") } })).toBe(0);
    });

    it("an artist delete waits for a scan filing an album under the artist, then takes that album and its songs too", async () => {
        const a = await artist("a");
        let filing!: () => void;
        const filed = new Promise<void>((resolve) => (filing = resolve));
        const scan = prisma.$transaction(async (tx) => {
            await tx.album.create({
                data: { id: id("fresh"), rgMbid: id("fresh-rg"), artistId: a, identityKey: id("fresh-key"), title: `${P}fresh`, primaryType: "Album", location: "LIBRARY" },
            });
            await tx.track.create({
                data: { id: id("fresh-t"), albumId: id("fresh"), title: "f", trackNo: 1, duration: 1, filePath: `/${P}outside/f.flac`, fileModified: new Date(), fileSize: 1 },
            });
            filing();
            await wait(300);
        });
        await filed;

        const deleting = deleteArtists([a]);
        await scan;
        const result = await deleting;

        expect(result.artists).toBe(1);
        expect(result.albums).toBe(1);
        expect(await prisma.artist.count({ where: { id: a } })).toBe(0);
        expect(await prisma.album.count({ where: { id: id("fresh") } })).toBe(0);
        expect(await prisma.track.count({ where: { id: id("fresh-t") } })).toBe(0);
    });

    it("a scan filing an album under an artist that is being deleted waits, then finds the artist gone", async () => {
        const a = await artist("a");
        let deleted!: () => void;
        const done = new Promise<void>((resolve) => (deleted = resolve));
        const deleting = prisma.$transaction(async (tx) => {
            const deletion = await deleteArtists([a], { within: tx });
            deleted();
            await wait(300);
            return deletion;
        });
        await done;

        const filing = prisma.album
            .create({
                data: { id: id("late"), rgMbid: id("late-rg"), artistId: a, identityKey: id("late-key"), title: `${P}late`, primaryType: "Album", location: "LIBRARY" },
            })
            .then(() => "filed", () => "refused");
        await deleting;

        expect(await filing).toBe("refused");
        expect(await prisma.artist.count({ where: { id: a } })).toBe(0);
        expect(await prisma.album.count({ where: { id: id("late") } })).toBe(0);
    });
});

describe("share links", () => {
    it("an album delete takes the links to the album and to its songs, and no others", async () => {
        const a = await artist("a");
        await album("gone", a, { songs: 2 });
        await album("kept", a);
        await link("album", "album", id("gone"));
        await link("song", "track", id("gone-t1"));
        await link("keptAlbum", "album", id("kept"));
        await link("keptSong", "track", id("kept-t0"));
        await link("list", "playlist", id("gone"));

        await deleteAlbums([id("gone")]);

        expect(await linksLeft()).toEqual([id("keptAlbum"), id("keptSong"), id("list")].sort());
    });

    it("an artist delete takes the links of its albums and songs", async () => {
        const a = await artist("a");
        const b = await artist("b");
        await album("one", a, { songs: 2 });
        await album("two", b);
        await link("album", "album", id("one"));
        await link("song", "track", id("one-t0"));
        await link("other", "album", id("two"));

        await deleteArtists([a]);

        expect(await linksLeft()).toEqual([id("other")]);
    });
});

describe("deleteSongs", () => {
    it("takes the songs, their Discover records, share links and playlist entries, and leaves the rest of the album", async () => {
        const a = await artist("a");
        await album("one", a, { songs: 3 });
        await prisma.discoveryAlbum.create({ data: { id: id("da"), userId: id("user"), rgMbid: id("one-rg"), artistName: "x", albumTitle: "x", weekStartDate: new Date() } });
        await prisma.discoveryTrack.create({ data: { id: id("dt"), discoveryAlbumId: id("da"), trackId: id("one-t0"), fileName: "a", filePath: "a" } });
        await link("gone", "track", id("one-t0"));
        await link("stays", "track", id("one-t1"));
        await link("album", "album", id("one"));
        const holding = await holdsSong("holds", id("one-t0"));

        const result = await deleteSongs([id("one-t0")]);

        expect(result).toMatchObject({ songs: 1, albums: 0 });
        expect((await prisma.track.findMany({ where: { albumId: id("one") }, select: { id: true }, orderBy: { id: "asc" } })).map((t) => t.id)).toEqual([id("one-t1"), id("one-t2")]);
        expect(await prisma.discoveryTrack.count({ where: { id: id("dt") } })).toBe(0);
        expect(await linksLeft()).toEqual([id("album"), id("stays")].sort());
        expect(await prisma.playlistItem.count({ where: { playlistId: holding.id } })).toBe(0);
        expect(told()).toEqual([{ playlistId: holding.id, deleted: false }]);
    });

    it("takes the album too when it was the last song, with the album's share links", async () => {
        const a = await artist("a");
        await album("last", a, { songs: 1 });
        await album("other", a);
        await link("album", "album", id("last"));
        await link("other", "album", id("other"));

        const result = await deleteSongs([id("last-t0")]);

        expect(result).toMatchObject({ songs: 1, albums: 1 });
        expect(await prisma.album.findMany({ where: { id: { startsWith: P } }, select: { id: true } })).toEqual([{ id: id("other") }]);
        expect(await linksLeft()).toEqual([id("other")]);
    });

    it("deletes songs of several albums in one run and recounts their artist", async () => {
        const a = await artist("a");
        await album("one", a, { songs: 2 });
        await album("two", a, { songs: 1 });
        await prisma.artist.update({ where: { id: a }, data: { libraryAlbumCount: 2, totalTrackCount: 3 } });

        const result = await deleteSongs([id("one-t0"), id("two-t0")]);

        expect(result).toMatchObject({ songs: 2, albums: 1 });
        expect(await prisma.artist.findUniqueOrThrow({ where: { id: a }, select: { libraryAlbumCount: true, totalTrackCount: true } })).toEqual({
            libraryAlbumCount: 1,
            totalTrackCount: 1,
        });
    });

    it("with `detachDiscovery`, keeps the Discover record and unnames the song in it", async () => {
        const a = await artist("a");
        await album("one", a, { songs: 2 });
        await prisma.discoveryAlbum.create({ data: { id: id("da"), userId: id("user"), rgMbid: id("one-rg"), artistName: "x", albumTitle: "x", weekStartDate: new Date() } });
        await prisma.discoveryTrack.create({ data: { id: id("dt"), discoveryAlbumId: id("da"), trackId: id("one-t0"), fileName: "a", filePath: "a" } });

        await deleteSongs([id("one-t0")], { detachDiscovery: true });

        expect(await prisma.discoveryTrack.findUniqueOrThrow({ where: { id: id("dt") }, select: { trackId: true } })).toEqual({ trackId: null });
    });

    it("moves the library-changed marker for a playable song, and not for a missing one", async () => {
        const a = await artist("a");
        await album("one", a, { songs: 2 });
        await album("gone", a, { songs: 1, missing: true });

        expect(await markerMoves(() => deleteSongs([id("gone-t0")]))).toBe(false);
        expect(await markerMoves(() => deleteSongs([id("one-t0")]))).toBe(true);
    });

    it("inside the caller's transaction, tells nothing until settled", async () => {
        const a = await artist("a");
        await album("one", a, { songs: 1 });
        await holdsSong("holds", id("one-t0"));

        const result = await prisma.$transaction((tx) => deleteSongs([id("one-t0")], { within: tx }));
        expect(heard).toEqual([]);
        await result.settle();
        expect(told()).toHaveLength(1);
    });

    it("an id no song has is nothing to delete", async () => {
        expect(await deleteSongs([id("nope")])).toMatchObject({ songs: 0, albums: 0 });
    });
});
