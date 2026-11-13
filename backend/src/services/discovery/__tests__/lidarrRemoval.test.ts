/**
 * Discover deletes Lidarr files only for what it fetched: the artist must carry the
 * Discover tag, Discover's own records must name the Lidarr album (by the Lidarr id
 * Discover got back, or the MusicBrainz id it asked for), and nothing may be in the
 * user's library, liked or requested. Each kept album says which check kept it.
 */

jest.mock("../../lidarr", () => ({
    lidarrService: {
        isEnabled: jest.fn(),
        getAlbum: jest.fn(),
        getArtistById: jest.fn(),
        getAlbumsByArtistId: jest.fn(),
        getOrCreateDiscoveryTag: jest.fn(),
        unmonitorAlbum: jest.fn(),
        deleteAlbumById: jest.fn(),
        deleteArtistById: jest.fn(),
        removeDiscoveryTagByMbid: jest.fn(),
    },
}));

import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import { removeDiscoveryAlbum, removeDiscoveryArtist } from "../lidarrRemoval";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { artistIdentityKey } from "../../artistIdentity";

const USER = "lr_user";
const ARTIST = "lr_artist";
const TAG = 22;
const lidarr = lidarrService as jest.Mocked<typeof lidarrService>;

const lidarrArtist = (tags: number[]) =>
    ({ id: 5, artistName: "Interpol", foreignArtistId: "artist-mbid", tags }) as any;
const lidarrAlbum = (foreignAlbumId: string, trackFileCount = 10, id = 7) =>
    ({ id, artistId: 5, title: "Album", foreignAlbumId, statistics: { trackFileCount } }) as any;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
});

beforeEach(() => {
    jest.clearAllMocks();
    lidarr.isEnabled.mockResolvedValue(true);
    lidarr.getOrCreateDiscoveryTag.mockResolvedValue(TAG);
    lidarr.getArtistById.mockResolvedValue(lidarrArtist([TAG]));
    lidarr.deleteArtistById.mockResolvedValue({ success: true, message: "" });
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.album.deleteMany({ where: { artistId: ARTIST } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const discovered = (rgMbid: string, status: "ACTIVE" | "LIKED" | "DELETED" = "ACTIVE", lidarrAlbumId: number | null = null) =>
    prisma.discoveryAlbum.create({
        data: {
            userId: USER, rgMbid, artistName: "Interpol", artistMbid: "artist-mbid",
            albumTitle: rgMbid, weekStartDate: new Date("2026-09-28"), status, lidarrAlbumId,
        },
    });

const NO_RECORD = "Kima has no record of Discover fetching this album";

const inLibrary = async (rgMbid: string) => {
    await prisma.artist.create({
        data: { id: ARTIST, name: "Interpol", mbid: "artist-mbid", identityKey: artistIdentityKey("Interpol") },
    });
    await prisma.album.create({
        data: { rgMbid, artistId: ARTIST, title: "Owned", primaryType: "Album", location: "LIBRARY" },
    });
};

describe("removeDiscoveryAlbum", () => {
    it("deletes the files of the album Discover asked for", async () => {
        await discovered("rg-asked", "DELETED");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const outcome = await removeDiscoveryAlbum(7, "rg-asked");
        expect(outcome.removed).toBe(true);
        expect(outcome.reason).toBeNull();
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(7, true);
    });

    it("only unmonitors an album Discover recorded neither by Lidarr id nor by MusicBrainz id", async () => {
        await discovered("rg-asked", "ACTIVE", 99);
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-live-version"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(kept.reason).toBe(NO_RECORD);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
        expect(lidarr.unmonitorAlbum).toHaveBeenCalledWith(7);
    });

    it("keeps (unmonitors, never deletes) an album under a tagged artist when no Discover record names it", async () => {
        // The tag marks the artist; a listener can add their own album to a tagged artist in Lidarr.
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(kept.reason).toBe(NO_RECORD);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
        expect(lidarr.unmonitorAlbum).toHaveBeenCalledWith(7);
    });

    it("deletes an album whose untagged files left a placeholder id, by the Lidarr id Discover recorded", async () => {
        // Lidarr wrote no release-group tag, so the scan and the suggestion hold temp-… while Lidarr holds the real id.
        await discovered("temp-1792991402890-0.92", "ACTIVE", 7);
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));

        const outcome = await removeDiscoveryAlbum(7, "temp-1792991402890-0.92");
        expect(outcome).toEqual({ removed: true, reason: null });
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(7, true);
    });

    it("deletes an album when only Discover's download job recorded its Lidarr id", async () => {
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "completed" },
        });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Album", type: "album", status: "completed", targetMbid: "rg-other", lidarrAlbumId: 7, discoveryBatchId: batch.id },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));

        const outcome = await removeDiscoveryAlbum(7, "temp-x");
        expect(outcome.removed).toBe(true);
    });

    it("does not count a listener's own download of that Lidarr album as Discover's record", async () => {
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Album", type: "album", status: "completed", targetMbid: "rg-real", lidarrAlbumId: 7, metadata: {} },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));

        const kept = await removeDiscoveryAlbum(7, "temp-x");
        expect(kept.removed).toBe(false);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("keeps an album the library holds under Lidarr's id when the suggestion has only a placeholder", async () => {
        await discovered("temp-x", "ACTIVE", 7);
        await inLibrary("rg-real");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));

        const kept = await removeDiscoveryAlbum(7, "temp-x");
        expect(kept).toEqual({ removed: false, reason: "The library holds this album" });
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("keeps an album a listener requested under Lidarr's id when the suggestion has only a placeholder", async () => {
        await discovered("temp-x", "ACTIVE", 7);
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Album", type: "album", status: "completed", targetMbid: "rg-real", metadata: {} },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));

        const kept = await removeDiscoveryAlbum(7, "temp-x");
        expect(kept).toEqual({ removed: false, reason: "A listener has made this album theirs" });
    });

    it("keeps an album a listener liked when only the Lidarr id names it", async () => {
        await discovered("temp-x", "ACTIVE", 7);
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "temp-y", artistName: "Interpol", albumTitle: "Album", weekStartDate: new Date("2026-10-05"), status: "LIKED", lidarrAlbumId: 7 },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));

        const kept = await removeDiscoveryAlbum(7, "temp-x");
        expect(kept).toEqual({ removed: false, reason: "A listener has made this album theirs" });
    });

    it("keeps an album a listener's own download recorded only by its Lidarr id", async () => {
        await discovered("temp-x", "ACTIVE", 7);
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Album", type: "album", status: "completed", lidarrAlbumId: 7, metadata: {} },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));

        const kept = await removeDiscoveryAlbum(7, "temp-x");
        expect(kept).toEqual({ removed: false, reason: "A listener has made this album theirs" });
    });

    it("says so when Kima could not read Discover's tag from Lidarr", async () => {
        await discovered("temp-x", "ACTIVE", 7);
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));
        lidarr.getOrCreateDiscoveryTag.mockResolvedValue(null);

        const kept = await removeDiscoveryAlbum(7, "temp-x");
        expect(kept).toEqual({ removed: false, reason: "Kima could not read Discover's tag from Lidarr" });
    });

    it("deletes the files when only a Discover download job (no suggestion) names the album", async () => {
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "completed" },
        });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Album", type: "album", status: "completed", targetMbid: "rg-asked", artistMbid: "artist-mbid", discoveryBatchId: batch.id },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const outcome = await removeDiscoveryAlbum(7, "rg-asked");
        expect(outcome.removed).toBe(true);
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(7, true);
    });

    it("keeps the files of an artist without the Discover tag", async () => {
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept).toEqual({ removed: false, reason: "Lidarr's artist does not carry Discover's tag" });
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("keeps the files of an album the library holds", async () => {
        await inLibrary("rg-asked");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("keeps the files of a library album recorded under another id the caller knows", async () => {
        await inLibrary("rg-other");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked", { rgMbids: ["rg-asked", "rg-other"] });
        expect(kept.removed).toBe(false);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("keeps the files of a library album that matches only by artist and title, in any case", async () => {
        await inLibrary("rg-unrelated");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked", { artistName: "INTERPOL", albumTitle: "owned" });
        expect(kept.removed).toBe(false);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("keeps an album Lidarr no longer has, since its files may still be on disk", async () => {
        lidarr.getAlbum.mockResolvedValue(null);

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(kept.reason).toBe(
            "Lidarr no longer knows this album, so its files may still be on disk; delete them by hand"
        );
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("reports the message when Lidarr cannot be reached", async () => {
        lidarr.getAlbum.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:80"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(kept.reason).toBe(
            "Lidarr could not be reached or answered with an error: connect ECONNREFUSED 127.0.0.1:80"
        );
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("does nothing while Lidarr is off", async () => {
        lidarr.isEnabled.mockResolvedValue(false);

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(kept.reason).toBe("Lidarr is turned off");
        expect(lidarr.getAlbum).not.toHaveBeenCalled();
    });
});

describe("removeDiscoveryArtist", () => {
    it("deletes an artist whose every album with files came from Discover", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-empty", 0)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(true);
        expect(lidarr.deleteArtistById).toHaveBeenCalledWith(5, true);
    });

    it("deletes an artist whose albums Discover recorded only by Lidarr id, their files untagged", async () => {
        await discovered("temp-a", "DELETED", 31);
        await discovered("temp-b", "DELETED", 32);
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31), lidarrAlbum("rg-b", 10, 32)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(true);
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("keeps an artist whose album Discover recorded by Lidarr id when a listener liked it", async () => {
        await discovered("temp-a", "DELETED", 31);
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "temp-liked", artistName: "Other", albumTitle: "Album", weekStartDate: new Date("2026-10-05"), status: "LIKED", lidarrAlbumId: 31 },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist with files Discover did not fetch and drops its tag", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-users-own")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).toHaveBeenCalledWith("artist-mbid");
    });

    it("leaves an artist and its tag alone while a listener's current week holds one of its albums", async () => {
        await discovered("rg-1", "ACTIVE");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("leaves an artist and its tag alone while a Discover batch is still downloading its album", async () => {
        await discovered("rg-1", "DELETED");
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "downloading" },
        });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Next", type: "album", status: "processing", targetMbid: "rg-next", artistMbid: "artist-mbid", discoveryBatchId: batch.id },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("leaves an artist alone while a current suggestion names it only by name, its album not yet in Lidarr", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "rg-arriving", artistName: "interpol", artistMbid: null, albumTitle: "Arriving", weekStartDate: new Date("2026-10-26"), status: "ACTIVE" },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("deletes once the batch that was downloading its album has finished", async () => {
        await discovered("rg-1", "DELETED");
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "completed" },
        });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Album", type: "album", status: "completed", targetMbid: "rg-1", artistMbid: "artist-mbid", discoveryBatchId: batch.id },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(true);
    });

    it("keeps an untagged artist", async () => {
        expect(await removeDiscoveryArtist(lidarrArtist([]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist with a liked Discover album", async () => {
        await discovered("rg-1", "LIKED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist the library holds", async () => {
        await inLibrary("rg-owned");
        lidarr.getAlbumsByArtistId.mockResolvedValue([]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("lets Lidarr forget an artist with no files without deleting its folder", async () => {
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-empty", 0)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(true);
        expect(lidarr.deleteArtistById).toHaveBeenCalledWith(5, false);
    });

    it("keeps an artist whose album with files the listener asked for themselves", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - rg-1", type: "album", status: "completed", targetMbid: "rg-1", metadata: {} },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist whose album with files is marked as a listener's", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.artist.create({
            data: { id: ARTIST, name: "Interpol", mbid: null, identityKey: artistIdentityKey("Interpol") },
        });
        await prisma.ownedAlbum.create({ data: { artistId: ARTIST, rgMbid: "rg-1", source: "native_scan" } });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        await prisma.ownedAlbum.deleteMany({ where: { artistId: ARTIST } });
    });
});

describe("removeDiscoveryArtist and what Lidarr cannot say", () => {
    it("keeps an artist Lidarr gives no file count for", async () => {
        lidarr.getAlbumsByArtistId.mockResolvedValue([{ id: 7, artistId: 5, title: "Album", foreignAlbumId: "rg-1" }] as any);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist with no files while a listener's own request for it is open", async () => {
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Next", type: "album", status: "pending", artistMbid: "artist-mbid", metadata: {} },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-next", 0)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });
});

describe("removeDiscoveryAlbum and a listener's own claim", () => {
    it("keeps an album the listener asked for themselves, Discover's record or not", async () => {
        await discovered("rg-asked");
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Album", type: "album", status: "processing", targetMbid: "rg-asked", metadata: {} },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });
});
