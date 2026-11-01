/**
 * The liked-album move and the suggestion clear, against the real test database. Lidarr is off, and no Discover
 * album here has a Lidarr id, so every clear takes the Soulseek path.
 */
import { discoveryAlbumLifecycle } from "../discoveryAlbumLifecycle";
import { clearSuggestion } from "../discoverClearing";
import { prisma } from "../../../utils/db";
import { useLidarr } from "../../../__tests__/helpers/lidarrSettings";

const P = "dlife";
const USER = "dlife_user";
const WEEK = new Date(Date.UTC(2026, 9, 19));

async function cleanup() {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.discoveryTrack.deleteMany({ where: { discoveryAlbum: { userId: USER } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

async function discoverAlbum() {
    await prisma.artist.create({ data: { id: `${P}_art`, name: `${P} artist`, normalizedName: `${P} artist`, identityKey: `${P}_ik` } });
    await prisma.album.create({
        data: { id: `${P}_alb`, rgMbid: `${P}_rg`, artistId: `${P}_art`, identityKey: `${P}_ak`, title: `${P} Album`, primaryType: "Album", year: 2024, location: "DISCOVER" },
    });
    // Discover's own download record, as createDiscoveryDownloadJob writes it: without it the album is not Discover's to delete.
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: WEEK, targetSongCount: 10, status: "completed" } });
    await prisma.downloadJob.create({
        data: { userId: USER, subject: `${P} artist - ${P} Album`, type: "album", targetMbid: `${P}_rg`, status: "completed", discoveryBatchId: batch.id, metadata: { currentSource: "soulseek", downloadType: "discovery", artistName: `${P} artist`, albumTitle: `${P} Album` } },
    });
    // The song's file is outside the music root, so a clear refuses to touch it.
    await prisma.track.create({
        data: { id: `${P}_t`, albumId: `${P}_alb`, title: "song", trackNo: 1, duration: 100, filePath: `../${P}-nowhere/01.flac`, fileModified: new Date(), fileSize: 1 },
    });
}

const suggest = (status: "ACTIVE" | "LIKED") =>
    prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: `${P}_rg`, artistName: `${P} artist`, albumTitle: `${P} Album`, weekStartDate: WEEK, status },
    });

beforeAll(async () => {
    await cleanup();
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});
beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await useLidarr("", { lidarrEnabled: false });
});

describe("moveLikedAlbumToLibrary", () => {
    it("moves the DISCOVER album to the library, marks it liked, and the suggestion MOVED", async () => {
        await discoverAlbum();
        const suggestion = await suggest("LIKED");

        expect(await discoveryAlbumLifecycle.moveLikedAlbumToLibrary(suggestion)).toBe(true);

        expect((await prisma.album.findUnique({ where: { id: `${P}_alb` } }))?.location).toBe("LIBRARY");
        expect(await prisma.ownedAlbum.count({ where: { artistId: `${P}_art`, rgMbid: `${P}_rg`, source: "discovery_liked" } })).toBe(1);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: suggestion.id } }))?.status).toBe("MOVED");
    });

    it("reports that nothing moved when no scanned album matches, and still marks the suggestion MOVED", async () => {
        const suggestion = await suggest("LIKED");
        expect(await discoveryAlbumLifecycle.moveLikedAlbumToLibrary(suggestion)).toBe(false);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: suggestion.id } }))?.status).toBe("MOVED");
    });

    it("never moves a library album that only shares the release-group id's name", async () => {
        await discoverAlbum();
        await prisma.album.update({ where: { id: `${P}_alb` }, data: { location: "LIBRARY" } });
        const suggestion = await suggest("LIKED");
        expect(await discoveryAlbumLifecycle.moveLikedAlbumToLibrary(suggestion)).toBe(false);
        expect(await prisma.ownedAlbum.count({ where: { artistId: `${P}_art` } })).toBe(0);
    });
});

describe("clearSuggestion", () => {
    it("deletes the album, its songs and its Discover records, and marks the suggestion DELETED", async () => {
        await discoverAlbum();
        const suggestion = await suggest("ACTIVE");
        await prisma.discoveryTrack.create({ data: { discoveryAlbumId: suggestion.id, trackId: `${P}_t`, fileName: "01.flac", filePath: "x" } });

        expect(await clearSuggestion(suggestion)).toEqual({ outcome: "cleared" });

        expect(await prisma.album.count({ where: { id: `${P}_alb` } })).toBe(0);
        expect(await prisma.track.count({ where: { id: `${P}_t` } })).toBe(0);
        expect(await prisma.discoveryTrack.count({ where: { discoveryAlbumId: suggestion.id } })).toBe(0);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: suggestion.id } }))?.status).toBe("DELETED");
    });

    it("leaves the album alone when a like took the suggestion first", async () => {
        await discoverAlbum();
        const suggestion = await suggest("ACTIVE");
        await prisma.discoveryAlbum.update({ where: { id: suggestion.id }, data: { status: "LIKED" } });

        expect(await clearSuggestion(suggestion)).toEqual({ outcome: "skipped" });
        expect(await prisma.album.count({ where: { id: `${P}_alb` } })).toBe(1);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: suggestion.id } }))?.status).toBe("LIKED");
    });

    it("keeps everything and puts the suggestion back to ACTIVE when Lidarr (turned off) does not delete", async () => {
        await discoverAlbum();
        const suggestion = await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: `${P}_rg`, artistName: `${P} artist`, albumTitle: `${P} Album`, weekStartDate: WEEK, status: "ACTIVE", lidarrAlbumId: 77 },
        });

        const result = await clearSuggestion(suggestion);
        expect(result).toMatchObject({ outcome: "kept", failure: { reason: "Lidarr is turned off" } });
        expect(await prisma.album.count({ where: { id: `${P}_alb` } })).toBe(1);
        expect(await prisma.track.count({ where: { id: `${P}_t` } })).toBe(1);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: suggestion.id } }))?.status).toBe("ACTIVE");
    });
});
