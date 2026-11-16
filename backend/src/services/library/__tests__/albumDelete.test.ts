/**
 * The album-delete module through its interface: what goes with an album, what is told after it, and what becomes of an
 * artist's keeps. Real database and event bus; no mocks.
 */
import { prisma } from "../../../utils/db";
import { eventBus, type SSEEvent } from "../../eventBus";
import { markerMoves } from "../../../__tests__/helpers/libraryMarker";
import { ownedIndexVersion } from "../../discovery/ownedIndexVersion";
import { deleteAlbums, deleteArtists, deleteEmptyArtists } from "../albumDelete";

const P = "zz-albumdel_";
const id = (n: string) => `${P}${n}`;

/** Everything the tests made except the listening user. */
async function clear(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryTrack" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryAlbum" WHERE id LIKE '${P}%'`);
    await prisma.playlist.deleteMany({ where: { userId: id("user") } });
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
