/**
 * Discover deletes Lidarr files only for what it fetched: the album id must match
 * the MBID Discover asked for, the artist must carry the Discover tag, and nothing
 * may be in the user's library or liked.
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
const lidarrAlbum = (foreignAlbumId: string, trackFileCount = 10) =>
    ({ id: 7, artistId: 5, title: "Album", foreignAlbumId, statistics: { trackFileCount } }) as any;

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
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.album.deleteMany({ where: { artistId: ARTIST } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const discovered = (rgMbid: string, status: "ACTIVE" | "LIKED" = "ACTIVE") =>
    prisma.discoveryAlbum.create({
        data: {
            userId: USER, rgMbid, artistName: "Interpol", artistMbid: "artist-mbid",
            albumTitle: rgMbid, weekStartDate: new Date("2026-09-28"), status,
        },
    });

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
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));

        const outcome = await removeDiscoveryAlbum(7, "rg-asked");
        expect(outcome.removed).toBe(true);
        expect(outcome.reason).toBeNull();
        expect(lidarr.deleteAlbumById).toHaveBeenCalledWith(7, true);
    });

    it("only unmonitors an album whose MBID is not the one Discover asked for", async () => {
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-live-version"));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
        expect(kept.reason).toBe("Lidarr's record is not the album Discover fetched");
        expect(lidarr.deleteAlbumById).not.toHaveBeenCalled();
        expect(lidarr.unmonitorAlbum).toHaveBeenCalledWith(7);
    });

    it("keeps the files of an artist without the Discover tag", async () => {
        lidarr.getAlbum.mockResolvedValue(lidarrAlbum("rg-asked"));
        lidarr.getArtistById.mockResolvedValue(lidarrArtist([]));

        const kept = await removeDiscoveryAlbum(7, "rg-asked");
        expect(kept.removed).toBe(false);
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
        await discovered("rg-1");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-empty", 0)]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(true);
        expect(lidarr.deleteArtistById).toHaveBeenCalledWith(5, true);
    });

    it("keeps an artist with files Discover did not fetch and drops its tag", async () => {
        await discovered("rg-1");
        lidarr.getAlbumsByArtistId.mockResolvedValue([lidarrAlbum("rg-1"), lidarrAlbum("rg-users-own")]);

        expect(await removeDiscoveryArtist(lidarrArtist([TAG]))).toBe(false);
        expect(lidarr.deleteArtistById).not.toHaveBeenCalled();
        expect(lidarr.removeDiscoveryTagByMbid).toHaveBeenCalledWith("artist-mbid");
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
});
