/**
 * Discover deletes Lidarr files only for what it fetched: the artist must carry the
 * Discover tag, Discover's own records must name the Lidarr album (by the Lidarr id
 * Discover got back, or the MusicBrainz id it asked for), and nothing may be in the
 * user's library, liked or requested. Each kept album says which check kept it. Only
 * Kima tags artists: the cleanup takes the tag off only for a listener's claim, and
 * puts it back on an artist its records show is Discover's.
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
        addTagsToArtist: jest.fn(),
    },
}));

import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import { discoveryArtistVerdict, removeDiscoveryAlbum, removeDiscoveryArtist } from "../lidarrRemoval";
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
    lidarr.addTagsToArtist.mockResolvedValue(true);
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

    it("keeps the files of an artist without the Discover tag that holds an album Discover did not fetch", async () => {
        await discovered("rg-asked", "DELETED");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-asked"), lidarrAlbum("rg-users-own", 10, 8)]);

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept).toEqual({ removed: false, reason: "Lidarr's artist does not carry Discover's tag" });
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
        expect(lidarr.addTagsToArtist).not.toHaveBeenCalled();
    });

    it("puts back the tag an earlier cleanup took off a Discover artist, then deletes the album", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        await discovered("temp-b", "DELETED", 32);
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-a", 10, 31));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31), lidarrAlbum("rg-b", 10, 32), lidarrAlbum("rg-none", 0, 33)]);

        const outcome = await removeDiscoveryAlbum(31, "temp-a");
        expect(lidarr.addTagsToArtist).toHaveBeenCalledWith(5, [TAG]);
        expect(outcome).toEqual({ removed: true, reason: null });
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(31, true);
    });

    it("leaves the tag off an artist a listener liked an album of", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "temp-old", artistName: "Interpol", artistMbid: "artist-mbid", albumTitle: "Old", weekStartDate: new Date("2026-09-21"), status: "LIKED" },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-a", 10, 31));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);

        const kept = await removeDiscoveryAlbum(31, "temp-a");
        expect(kept).toEqual({ removed: false, reason: "Lidarr's artist does not carry Discover's tag" });
        expect(lidarr.addTagsToArtist).not.toHaveBeenCalled();
    });

    it("keeps the files when Lidarr will not take the tag back", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-a", 10, 31));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);
        lidarr.addTagsToArtist.mockResolvedValue(false);

        const kept = await removeDiscoveryAlbum(31, "temp-a");
        expect(kept).toEqual({ removed: false, reason: "Lidarr would not take Discover's tag back on this artist" });
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("puts no tag back for an album a listener asked for themselves", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - A", type: "album", status: "completed", lidarrAlbumId: 31, metadata: {} },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-a", 10, 31));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);

        const kept = await removeDiscoveryAlbum(31, "temp-a");
        expect(kept).toEqual({ removed: false, reason: "A listener has made this album theirs" });
        expect(lidarr.addTagsToArtist).not.toHaveBeenCalled();
    });

    it("puts no tag back on an artist with a listener's request still downloading", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Next", type: "album", status: "processing", artistMbid: "artist-mbid", metadata: {} },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-a", 10, 31));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31), lidarrAlbum("rg-next", 0, 34)]);

        const kept = await removeDiscoveryAlbum(31, "temp-a");
        expect(kept).toEqual({ removed: false, reason: "Lidarr's artist does not carry Discover's tag" });
        expect(lidarr.addTagsToArtist).not.toHaveBeenCalled();
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

        const kept = await removeDiscoveryAlbum(7, "rg-asked", { artistName: "INTERPOL", artistMbid: "artist-mbid", albumTitle: "owned" });
        expect(kept.removed).toBe(false);
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it("does not take a namesake's library album, matching only by artist and title, as the one Discover fetched", async () => {
        await discovered("rg-asked", "DELETED");
        await inLibrary("rg-unrelated");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const outcome = await removeDiscoveryAlbum(7, "rg-asked", { artistName: "Interpol", artistMbid: "another-artist-mbid", albumTitle: "owned" });
        expect(outcome.removed).toBe(true);
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(7, true);
    });

    it.each([[null], ["temp-1792991402890-0.92"]])("keeps the files of a library album matching by artist and title when Discover's artist id is %s", async (id) => {
        await discovered("rg-asked", "DELETED");
        await inLibrary("rg-unrelated");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked", { artistName: "Interpol", artistMbid: id, albumTitle: "owned" });
        expect(kept).toEqual({ removed: false, reason: "The library holds this album" });
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
    });

    it.each([[null], ["temp-1792991402890-0.92"]])("keeps the files of a library album matching by artist and title when the library artist id is %s", async (libraryId) => {
        await discovered("rg-asked", "DELETED");
        await inLibrary("rg-unrelated");
        await prisma.artist.update({ where: { id: ARTIST }, data: { mbid: libraryId } });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked", { artistName: "Interpol", artistMbid: "artist-mbid", albumTitle: "owned" });
        expect(kept).toEqual({ removed: false, reason: "The library holds this album" });
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

    it("keeps an artist with files Discover has no record of, and its tag: only a listener's claim takes the tag off", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-unrecorded", 10, 8)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("takes the tag off an artist a listener liked an album of", async () => {
        await discovered("rg-1", "LIKED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
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

    it("does not hold an artist in use for a same-name suggestion that carries another artist's MusicBrainz id", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "rg-namesake", artistName: "Interpol", artistMbid: "other-artist-mbid", albumTitle: "Namesake", weekStartDate: new Date("2026-10-26"), status: "ACTIVE" },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await discoveryArtistVerdict(lidarrArtist([TAG]))).toBe("delete");
    });

    it("still holds an artist in use for a same-name suggestion whose artist id is a temp- placeholder", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "rg-arriving", artistName: "Interpol", artistMbid: "temp-123", albumTitle: "Arriving", weekStartDate: new Date("2026-10-26"), status: "ACTIVE" },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await discoveryArtistVerdict(lidarrArtist([TAG]))).toBe("in use");
    });

    it("holds an artist in use for a suggestion carrying its MusicBrainz id, whatever name the suggestion spells", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "rg-arriving", artistName: "Interpol (alt spelling)", artistMbid: "artist-mbid", albumTitle: "Arriving", weekStartDate: new Date("2026-10-26"), status: "ACTIVE" },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await discoveryArtistVerdict(lidarrArtist([TAG]))).toBe("in use");
    });

    it("does not hold an artist in use for a running download of a same-name artist with another MusicBrainz id", async () => {
        await discovered("rg-1", "DELETED");
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "downloading" },
        });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Namesake", type: "album", status: "processing", targetMbid: "rg-namesake", artistMbid: "other-artist-mbid", metadata: { artistName: "Interpol" }, discoveryBatchId: batch.id },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await discoveryArtistVerdict(lidarrArtist([TAG]))).toBe("delete");
    });

    it.each([[null], ["temp-123"]])("still holds an artist in use for a running download of its name whose artist id is %s", async (artistMbid) => {
        await discovered("rg-1", "DELETED");
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "downloading" },
        });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Arriving", type: "album", status: "processing", targetMbid: "rg-arriving", artistMbid, metadata: { artistName: "interpol" }, discoveryBatchId: batch.id },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await discoveryArtistVerdict(lidarrArtist([TAG]))).toBe("in use");
    });

    it.each([[null], ["temp-123"]])("keeps an artist as a listener's when a kept album's suggestion had artist id %s and the artist's name", async (artistMbid) => {
        await discovered("rg-1", "DELETED");
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "rg-kept", artistName: "INTERPOL", artistMbid, albumTitle: "Kept", weekStartDate: new Date("2026-10-26"), status: "LIKED" },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await discoveryArtistVerdict(lidarrArtist([TAG]))).toBe("theirs");
    });

    it("does not count a kept album of a same-name artist with another MusicBrainz id as this artist's", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "rg-namesake", artistName: "Interpol", artistMbid: "other-artist-mbid", albumTitle: "Namesake", weekStartDate: new Date("2026-10-26"), status: "MOVED" },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await discoveryArtistVerdict(lidarrArtist([TAG]))).toBe("delete");
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
    it("keeps an artist Lidarr gives no file count for, and its tag", async () => {
        lidarr.getAlbumsByArtistId.mockResolvedValue([{ id: 7, artistId: 5, title: "Album", foreignAlbumId: "rg-1" }] as any);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("keeps an artist with Discover's files while a listener's own request for it is still downloading", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Next", type: "album", status: "processing", artistMbid: "artist-mbid", metadata: {} },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-next", 0, 8)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).toHaveBeenCalledWith("artist-mbid");
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
