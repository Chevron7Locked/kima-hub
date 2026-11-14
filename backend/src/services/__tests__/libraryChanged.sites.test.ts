/**
 * Every place outside a scan that moves an album between the library and Discover, or removes one, moves the
 * library-changed marker exactly when the library a client lists changed: a library album gained, lost or moved. Discover
 * albums are not listed, so moving or removing those leaves it. Real database and the real marker (services/libraryChanged.ts).
 */
jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../workers/unifiedEnrichment", () => ({ triggerEnrichmentNow: jest.fn() }));

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";
import { clearOrphanedDiscoverAlbums } from "../discovery/discoverClearing";
import { relocateDiscoverAlbums } from "../discovery/discoverEvidence";
import { returnToDiscover, takeIntoLibrary } from "../discovery/discoveryAlbumLifecycle";
import { sortDiscoverAlbums } from "../discovery/sortDiscoverAlbums";
import { pruneEmptyAlbumsAndArtists } from "../libraryPrune";

jest.setTimeout(60_000);

const P = "lcsites";
const USER = `${P}_user`;
const WEEK = new Date(Date.UTC(2026, 9, 19));

async function cleanup() {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

/** An artist `key` with one album and, unless `songs` is false, one song on it. */
async function album(key: string, location: "LIBRARY" | "DISCOVER", songs = true) {
    await prisma.artist.create({ data: { id: `${P}_art_${key}`, name: `${P} artist ${key}`, normalizedName: `${P} artist ${key}`, identityKey: `${P}_ik_${key}` } });
    const row = await prisma.album.create({
        data: { id: `${P}_alb_${key}`, rgMbid: `${P}_rg_${key}`, artistId: `${P}_art_${key}`, identityKey: `${P}_ak_${key}`, title: `${P} Album ${key}`, primaryType: "Album", year: 2024, location },
    });
    if (songs) {
        await prisma.track.create({
            data: { id: `${P}_t_${key}`, albumId: row.id, title: "song", trackNo: 1, duration: 100, filePath: `${P}/${key}/01.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
    return row;
}

/** Discover's own download record of the album `key`, as createDiscoveryDownloadJob writes it. */
async function discoverRecord(key: string) {
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: WEEK, targetSongCount: 10, status: "completed" } });
    await prisma.downloadJob.create({
        data: {
            userId: USER, subject: `${P} artist ${key} - ${P} Album ${key}`, type: "album", targetMbid: `${P}_rg_${key}`, status: "completed",
            discoveryBatchId: batch.id, metadata: { downloadType: "discovery", artistName: `${P} artist ${key}`, albumTitle: `${P} Album ${key}` },
        },
    });
}

const likedOwnership = (key: string) =>
    prisma.ownedAlbum.create({ data: { artistId: `${P}_art_${key}`, rgMbid: `${P}_rg_${key}`, source: "discovery_liked" } });

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
});

afterAll(async () => {
    await cleanup();
    await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null } });
    invalidateSystemSettingsCache();
    await prisma.$disconnect();
});

describe("a liked album joining the library", () => {
    it("moves the marker, because the library lists a new album", async () => {
        const discover = await album("like", "DISCOVER");
        expect(await markerMoves(() => takeIntoLibrary(discover))).toBe(true);
    });
});

describe("an unliked album going back to Discover", () => {
    it("moves the marker, because the library loses an album", async () => {
        const liked = await album("unlike", "LIBRARY");
        await likedOwnership("unlike");
        expect(await markerMoves(() => returnToDiscover(liked))).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: liked.id } })).location).toBe("DISCOVER");
    });

    it("leaves the marker when the album stays, because it was not brought in by a like", async () => {
        const own = await album("own", "LIBRARY");
        expect(await markerMoves(() => returnToDiscover(own))).toBe(false);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: own.id } })).location).toBe("LIBRARY");
    });
});

describe("clearing Discover's albums", () => {
    it("moves the marker when an orphan no Discover record names goes back to the library", async () => {
        await album("orphan", "DISCOVER");
        expect(await markerMoves(() => clearOrphanedDiscoverAlbums())).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_alb_orphan` } })).location).toBe("LIBRARY");
    });
});

describe("the move of Discover downloads out of the library", () => {
    it("moves the marker when it moves an album, and not when it only lists (dry run)", async () => {
        await album("reloc", "LIBRARY");
        await discoverRecord("reloc");

        expect(await markerMoves(() => relocateDiscoverAlbums({ dryRun: true }))).toBe(false);
        expect(await markerMoves(() => relocateDiscoverAlbums({ dryRun: false }))).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_alb_reloc` } })).location).toBe("DISCOVER");
    });

    it("leaves the marker when there is nothing to move", async () => {
        await album("stay", "LIBRARY");
        expect(await markerMoves(() => relocateDiscoverAlbums({ dryRun: false }))).toBe(false);
    });
});

describe("the one-time sort of Discover albums", () => {
    beforeEach(async () => {
        await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null } });
        invalidateSystemSettingsCache();
    });

    it("moves the marker when a Discover album with no evidence joins the library", async () => {
        await album("sortin", "DISCOVER");
        expect(await markerMoves(() => sortDiscoverAlbums())).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_alb_sortin` } })).location).toBe("LIBRARY");
    });

    it("moves the marker when a library album a Discover download asked for goes back to Discover", async () => {
        await album("sortout", "LIBRARY");
        await discoverRecord("sortout");
        expect(await markerMoves(() => sortDiscoverAlbums())).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_alb_sortout` } })).location).toBe("DISCOVER");
    });

    it("leaves the marker when no album changes place", async () => {
        await album("sortstay", "DISCOVER");
        await discoverRecord("sortstay");
        await album("sortlib", "LIBRARY");
        expect(await markerMoves(() => sortDiscoverAlbums())).toBe(false);
    });
});

describe("pruning empty albums and artists", () => {
    it("moves the marker when an empty library album goes", async () => {
        await album("emptylib", "LIBRARY", false);
        expect(await markerMoves(() => pruneEmptyAlbumsAndArtists())).toBe(true);
        expect(await prisma.album.count({ where: { id: `${P}_alb_emptylib` } })).toBe(0);
    });

    it("leaves the marker when only an empty Discover album and an artist with no albums go", async () => {
        await album("emptydis", "DISCOVER", false);
        await prisma.artist.create({ data: { id: `${P}_art_bare`, name: `${P} artist bare`, normalizedName: `${P} artist bare`, identityKey: `${P}_ik_bare` } });
        expect(await markerMoves(() => pruneEmptyAlbumsAndArtists())).toBe(false);
        expect(await prisma.album.count({ where: { id: `${P}_alb_emptydis` } })).toBe(0);
        expect(await prisma.artist.count({ where: { id: `${P}_art_bare` } })).toBe(0);
    });
});
