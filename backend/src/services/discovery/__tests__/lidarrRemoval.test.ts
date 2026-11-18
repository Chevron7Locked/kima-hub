/**
 * Discover deletes Lidarr files only for what it fetched. One album goes when Discover's own records name it (by the
 * Lidarr id Discover got back, or the MusicBrainz id it asked for) and nothing in the user's library, liked or requested
 * holds it, whatever the artist's tag says. A whole artist goes only while it carries the Discover tag. Each kept album
 * says which check kept it. Only Kima tags artists: the cleanup takes the tag off only for a listener's claim, and puts
 * it back on an artist its records show is Discover's.
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
        getTrackFileCount: jest.fn(),
    },
}));

import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import { discoveryArtistVerdict, ensureDiscoverTag, removeDiscoveryAlbum, removeDiscoveryArtist } from "../lidarrRemoval";
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

    it.each([
        ["Kima cannot read Discover's tag", () => lidarr.getOrCreateDiscoveryTag.mockResolvedValue(null)],
        ["Lidarr fails reading Discover's tag", () => lidarr.getOrCreateDiscoveryTag.mockRejectedValue(new Error("tag read failed"))],
    ])("deletes Discover's album when %s, as the tag only guards a whole artist", async (_case, arrange) => {
        await discovered("temp-x", "ACTIVE", 7);
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-real"));
        arrange();

        expect(await removeDiscoveryAlbum(7, "temp-x")).toEqual({ removed: true, reason: null });
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(7, true);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
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

    it("deletes only Discover's album under an untagged artist that also holds an album Discover did not fetch", async () => {
        await discovered("rg-asked", "DELETED");
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-asked"), lidarrAlbum("rg-users-own", 10, 8)]);

        expect(await removeDiscoveryAlbum(7, "rg-asked")).toEqual({ removed: true, reason: null });
        expect(lidarr.deleteAlbumById).toHaveBeenCalledTimes(1);
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(7, true);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
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

    it("leaves the artist it was given untouched when it puts the tag back", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);
        const artist = lidarrArtist([]);

        expect(await ensureDiscoverTag(artist, TAG)).toBe("tagged");

        expect(lidarr.addTagsToArtist).toHaveBeenCalledWith(5, [TAG]);
        expect(artist.tags).toEqual([]);
    });

    it("leaves the tag off an artist a listener liked an album of", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "temp-old", artistName: "Interpol", artistMbid: "artist-mbid", albumTitle: "Old", weekStartDate: new Date("2026-09-21"), status: "LIKED" },
        });
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-a", 10, 31));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);

        expect(await removeDiscoveryAlbum(31, "temp-a")).toEqual({ removed: true, reason: null });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.addTagsToArtist).not.toHaveBeenCalled();
    });

    it("deletes the album when Lidarr will not take the tag back", async () => {
        await discovered("temp-a", "ACTIVE", 31);
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-a", 10, 31));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);
        lidarr.addTagsToArtist.mockResolvedValue(false);

        expect(await removeDiscoveryAlbum(31, "temp-a")).toEqual({ removed: true, reason: null });
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(31, true);
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

        expect(await removeDiscoveryAlbum(31, "temp-a")).toEqual({ removed: true, reason: null });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
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

    it("says Lidarr no longer has an album, so the caller can tell it from a refusal", async () => {
        lidarr.getAlbum.mockResolvedValue(null);

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept).toEqual({
            removed: false,
            gone: true,
            reason: "Lidarr no longer knows this album, so its files may still be on disk; delete them by hand",
        });
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

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
        expect(lidarr.deleteArtistById).toHaveBeenCalledWith(5, true);
    });

    it("deletes an artist whose albums Discover recorded only by Lidarr id, their files untagged", async () => {
        await discovered("temp-a", "DELETED", 31);
        await discovered("temp-b", "DELETED", 32);
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31), lidarrAlbum("rg-b", 10, 32)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("keeps an artist whose album Discover recorded by Lidarr id when a listener liked it", async () => {
        await discovered("temp-a", "DELETED", 31);
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "temp-liked", artistName: "Other", albumTitle: "Album", weekStartDate: new Date("2026-10-05"), status: "LIKED", lidarrAlbumId: 31 },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-a", 10, 31)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist with files Discover has no record of, and its tag: only a listener's claim takes the tag off", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-unrecorded", 10, 8)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("takes the tag off an artist a listener liked an album of", async () => {
        await discovered("rg-1", "LIKED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.removeDiscoveryTagByMbid).toHaveBeenCalledWith("artist-mbid");
    });

    it("leaves an artist and its tag alone while a listener's current week holds one of its albums", async () => {
        await discovered("rg-1", "ACTIVE");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
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

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).not.toHaveBeenCalled();
    });

    it("leaves an artist alone while a current suggestion names it only by name, its album not yet in Lidarr", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: "rg-arriving", artistName: "interpol", artistMbid: null, albumTitle: "Arriving", weekStartDate: new Date("2026-10-26"), status: "ACTIVE" },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
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

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
    });

    it("keeps an untagged artist", async () => {
        expect(await removeDiscoveryArtist(lidarrArtist([]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist with a liked Discover album", async () => {
        await discovered("rg-1", "LIKED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist the library holds", async () => {
        await inLibrary("rg-owned");
        lidarr.getAlbumsByArtistId.mockResolvedValue([]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("lets Lidarr forget an artist with no files without deleting its folder", async () => {
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-empty", 0)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
        expect(lidarr.deleteArtistById).toHaveBeenCalledWith(5, false);
    });

    it("keeps an artist whose album with files the listener asked for themselves", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - rg-1", type: "album", status: "completed", targetMbid: "rg-1", metadata: {} },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("keeps an artist whose album with files is marked as a listener's", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.artist.create({
            data: { id: ARTIST, name: "Interpol", mbid: null, identityKey: artistIdentityKey("Interpol") },
        });
        await prisma.ownedAlbum.create({ data: { artistId: ARTIST, rgMbid: "rg-1", source: "native_scan" } });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        await prisma.ownedAlbum.deleteMany({ where: { artistId: ARTIST } });
    });
});

describe("removeDiscoveryArtist and what Lidarr cannot say", () => {
    const noCount = (foreignAlbumId: string, id: number) => ({ id, artistId: 5, title: "Album", foreignAlbumId }) as any;

    it("asks Lidarr for the files of an album it gives no file count for, then deletes Discover's artist", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([noCount("rg-1", 7), noCount("rg-empty", 8)]);
        lidarr.getTrackFileCount.mockImplementation(async (albumId: number) => (albumId === 7 ? 10 : 0));

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
        expect(lidarr.getTrackFileCount).toHaveBeenCalledWith(7);
        expect(lidarr.deleteArtistById).toHaveBeenCalledWith(5, true);
    });

    it("keeps an artist whose album with no file count turns out to hold files Discover has no record of", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), noCount("rg-users-own", 8)]);
        lidarr.getTrackFileCount.mockResolvedValue(4);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("lets Lidarr forget an artist once it says the album with no file count holds no files", async () => {
        lidarr.getAlbumsByArtistId.mockResolvedValue([noCount("rg-empty", 8)]);
        lidarr.getTrackFileCount.mockResolvedValue(0);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
        expect(lidarr.deleteArtistById).toHaveBeenCalledWith(5, false);
    });

    it("reports a failure, never a delete, when Lidarr cannot list an album's files", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([noCount("rg-1", 7)]);
        lidarr.getTrackFileCount.mockRejectedValue(new Error("Request failed with status code 500"));

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "failed", reason: "Request failed with status code 500" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("forgets Discover's finished Lidarr download records of an artist it deleted, but not one of an album Kima scanned", async () => {
        await discovered("rg-1", "DELETED");
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "completed" },
        });
        const job = (targetMbid: string, artistMbid: string, lidarrAlbumId: number | null) =>
            prisma.downloadJob.create({
                data: { userId: USER, subject: `Interpol - ${targetMbid}`, type: "album", status: "completed", targetMbid, artistMbid, lidarrAlbumId, discoveryBatchId: batch.id },
            });
        await job("rg-1", "artist-mbid", 7);
        await job("rg-9", "other-artist-mbid", 9);
        // Soulseek fetched this one, so Lidarr's delete did not touch its files.
        await job("rg-slsk", "artist-mbid", null);
        // Kima scanned this one: its files are still Kima's to clear, and the record shows it is Discover's.
        await job("rg-scanned", "artist-mbid", 8);
        await prisma.artist.create({ data: { id: ARTIST, name: "Interpol", mbid: "artist-mbid", identityKey: artistIdentityKey("Interpol") } });
        await prisma.album.create({ data: { rgMbid: "rg-scanned", artistId: ARTIST, title: "Scanned", primaryType: "Album", location: "DISCOVER" } });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
        const left = await prisma.downloadJob.findMany({ where: { userId: USER }, select: { targetMbid: true }, orderBy: { targetMbid: "asc" } });
        expect(left).toEqual([{ targetMbid: "rg-9" }, { targetMbid: "rg-scanned" }, { targetMbid: "rg-slsk" }]);
    });

    it("still reports an artist Lidarr deleted as removed when its download records cannot be forgotten", async () => {
        await discovered("rg-1", "DELETED");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);
        const findMany = prisma.downloadJob.findMany.bind(prisma.downloadJob);
        const spy = jest.spyOn(prisma.downloadJob, "findMany").mockImplementation(((args: any) =>
            args?.where?.lidarrAlbumId ? Promise.reject(new Error("connection lost")) : findMany(args)) as any);
        try {
            expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "removed" });
            expect(lidarr.deleteArtistById).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it("keeps Discover's download records of an artist Lidarr would not delete", async () => {
        await discovered("rg-1", "DELETED");
        const batch = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-26"), targetSongCount: 10, status: "completed" },
        });
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - rg-1", type: "album", status: "completed", targetMbid: "rg-1", artistMbid: "artist-mbid", discoveryBatchId: batch.id },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1")]);
        lidarr.deleteArtistById.mockResolvedValue({ success: false, message: "Lidarr said no" });

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "failed", reason: "Lidarr said no" });
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(1);
    });

    it("keeps an artist with Discover's files while a listener's own request for it is still downloading", async () => {
        await discovered("rg-1", "DELETED");
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Next", type: "album", status: "processing", artistMbid: "artist-mbid", metadata: {} },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-next", 0, 8)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).toHaveBeenCalledWith("artist-mbid");
    });

    it("keeps an artist with no files while a listener's own request for it is open", async () => {
        await prisma.downloadJob.create({
            data: { userId: USER, subject: "Interpol - Next", type: "album", status: "pending", artistMbid: "artist-mbid", metadata: {} },
        });
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-next", 0)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "kept" });
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
    });

    it("reports a failure with Lidarr's reason when Lidarr refuses the delete, never a keep", async () => {
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-empty", 0)]);
        lidarr.deleteArtistById.mockResolvedValue({ success: false, message: "timeout of 30000ms exceeded" });

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "failed", reason: "timeout of 30000ms exceeded" });
    });

    it("reports a failure when Lidarr cannot be asked about the artist's albums", async () => {
        lidarr.getAlbumsByArtistId.mockRejectedValue(new Error("connect ECONNREFUSED"));

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toEqual({ outcome: "failed", reason: "connect ECONNREFUSED" });
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
