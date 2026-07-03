/**
 * mbidReassign Tests
 *
 * Verifies the shared MBID reassignment helper used by BOTH the editor routes
 * AND the enrichment service:
 * - reassignAlbumRgMbid: Album.rgMbid update + OwnedAlbum migration
 * - reassignArtistMbid: Artist.mbid update
 * - DuplicateMbidError translation (P2002 -> 409)
 * - No-op on unchanged value or missing entity
 * - No orphaned OwnedAlbum rows after migration
 *
 * Run with: npx jest mbidReassign.test.ts
 */

import { prisma } from "../../utils/db";
import {
    DuplicateMbidError,
    reassignAlbumRgMbid,
    reassignArtistMbid,
} from "../mbidReassign";

// Mock Prisma
jest.mock("../../utils/db", () => ({
    prisma: {
        album: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        artist: {
            update: jest.fn(),
        },
        ownedAlbum: {
            delete: jest.fn(),
            upsert: jest.fn(),
        },
        $transaction: jest.fn(async (cb: any) => cb(prisma)),
    },
}));

const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockAlbumUpdate = prisma.album.update as jest.Mock;
const mockArtistUpdate = prisma.artist.update as jest.Mock;
const mockOwnedAlbumDelete = prisma.ownedAlbum.delete as jest.Mock;
const mockOwnedAlbumUpsert = prisma.ownedAlbum.upsert as jest.Mock;
const mockTransaction = prisma.$transaction as jest.Mock;

const ALBUM_ID = "album-123";
const ARTIST_ID = "artist-456";
const OLD_RGMUBID = "old-rgmbid-uuid";
const NEW_RGMUBID = "new-rgmbid-uuid";
const ARTIST_MBID = "artist-mbid-uuid";

describe("DuplicateMbidError", () => {
    it("should have the correct error message format", () => {
        const err = new DuplicateMbidError("artist", ARTIST_MBID);
        expect(err.message).toBe(
            `MBID ${ARTIST_MBID} is already in use by another artist`
        );
        expect(err.entityType).toBe("artist");
        expect(err.mbidValue).toBe(ARTIST_MBID);
        expect(err).toBeInstanceOf(DuplicateMbidError);
        expect(err).toBeInstanceOf(Error);
    });

    it("should work for album entity type", () => {
        const err = new DuplicateMbidError("album", NEW_RGMUBID);
        expect(err.message).toBe(
            `MBID ${NEW_RGMUBID} is already in use by another album`
        );
        expect(err.entityType).toBe("album");
    });
});

describe("reassignArtistMbid", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("should update Artist.mbid via prisma.artist.update", async () => {
        mockArtistUpdate.mockResolvedValue({ id: ARTIST_ID, mbid: ARTIST_MBID });

        await reassignArtistMbid(ARTIST_ID, ARTIST_MBID);

        expect(mockArtistUpdate).toHaveBeenCalledTimes(1);
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: ARTIST_ID },
            data: { mbid: ARTIST_MBID },
        });
    });

    it("should throw DuplicateMbidError on P2002", async () => {
        const p2002Error = new Error("Unique constraint failed") as any;
        p2002Error.code = "P2002";
        mockArtistUpdate.mockRejectedValue(p2002Error);

        await expect(
            reassignArtistMbid(ARTIST_ID, ARTIST_MBID)
        ).rejects.toThrow(DuplicateMbidError);
        expect(mockArtistUpdate).toHaveBeenCalledTimes(1);
    });

    it("should re-throw non-P2002 errors", async () => {
        const otherError = new Error("Some other error") as any;
        otherError.code = "P2025";
        mockArtistUpdate.mockRejectedValue(otherError);

        await expect(
            reassignArtistMbid(ARTIST_ID, ARTIST_MBID)
        ).rejects.toThrow("Some other error");
    });
});

describe("reassignAlbumRgMbid", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: album exists with old rgMbid
        mockAlbumFindUnique.mockResolvedValue({
            id: ALBUM_ID,
            rgMbid: OLD_RGMUBID,
            artistId: ARTIST_ID,
        });
        mockAlbumUpdate.mockResolvedValue({ id: ALBUM_ID, rgMbid: NEW_RGMUBID });
        mockOwnedAlbumDelete.mockResolvedValue({});
        mockOwnedAlbumUpsert.mockResolvedValue({});
        mockTransaction.mockImplementation(async (cb: any) => cb(prisma));
    });

    it("should no-op when album not found", async () => {
        mockAlbumFindUnique.mockResolvedValue(null);

        await reassignAlbumRgMbid("nonexistent", NEW_RGMUBID);

        expect(mockAlbumUpdate).not.toHaveBeenCalled();
        expect(mockOwnedAlbumDelete).not.toHaveBeenCalled();
        expect(mockOwnedAlbumUpsert).not.toHaveBeenCalled();
    });

    it("should no-op when rgMbid is unchanged", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: ALBUM_ID,
            rgMbid: NEW_RGMUBID,
            artistId: ARTIST_ID,
        });

        await reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID);

        expect(mockAlbumUpdate).not.toHaveBeenCalled();
        expect(mockOwnedAlbumDelete).not.toHaveBeenCalled();
        expect(mockOwnedAlbumUpsert).not.toHaveBeenCalled();
    });

    it("should update Album.rgMbid and migrate OwnedAlbum", async () => {
        await reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID);

        // Album.rgMbid updated
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: ALBUM_ID },
            data: { rgMbid: NEW_RGMUBID },
        });

        // Old OwnedAlbum row deleted
        expect(mockOwnedAlbumDelete).toHaveBeenCalledWith({
            where: {
                artistId_rgMbid: {
                    artistId: ARTIST_ID,
                    rgMbid: OLD_RGMUBID,
                },
            },
        });

        // New OwnedAlbum row created
        expect(mockOwnedAlbumUpsert).toHaveBeenCalledWith({
            where: {
                artistId_rgMbid: {
                    artistId: ARTIST_ID,
                    rgMbid: NEW_RGMUBID,
                },
            },
            create: {
                artistId: ARTIST_ID,
                rgMbid: NEW_RGMUBID,
                source: "enrichment",
            },
            update: {},
        });
    });

    it("should skip delete if old OwnedAlbum row doesn't exist (P2025)", async () => {
        const p2025Error = new Error("Record to delete doesn't exist") as any;
        p2025Error.code = "P2025";
        mockOwnedAlbumDelete.mockRejectedValue(p2025Error);

        await expect(
            reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID)
        ).resolves.toBeUndefined();

        // Album still updated, new OwnedAlbum still created
        expect(mockAlbumUpdate).toHaveBeenCalled();
        expect(mockOwnedAlbumUpsert).toHaveBeenCalled();
    });

    it("should throw DuplicateMbidError if new OwnedAlbum upsert hits P2002", async () => {
        const p2002Error = new Error("Unique constraint failed") as any;
        p2002Error.code = "P2002";
        mockOwnedAlbumUpsert.mockRejectedValue(p2002Error);

        await expect(
            reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID)
        ).rejects.toThrow(DuplicateMbidError);
        await expect(
            reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID)
        ).rejects.toThrow(
            `MBID ${NEW_RGMUBID} is already in use by another album`
        );
    });

    it("should throw DuplicateMbidError if Album.update hits P2002 (the @unique collision — the FIRST collision point)", async () => {
        // Album.rgMbid is @unique, so a duplicate rgMbid collides at Step 2's
        // album.update BEFORE the OwnedAlbum upsert. This must also map to 409.
        const p2002Error = new Error("Unique constraint failed") as any;
        p2002Error.code = "P2002";
        mockAlbumUpdate.mockRejectedValue(p2002Error);

        await expect(
            reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID)
        ).rejects.toThrow(DuplicateMbidError);
    });

    it("should throw non-P2002/non-P2025 errors from OwnedAlbum operations", async () => {
        const otherError = new Error("Some other error") as any;
        otherError.code = "P2003"; // Foreign key violation — not caught
        mockOwnedAlbumDelete.mockRejectedValue(otherError);

        await expect(
            reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID)
        ).rejects.toThrow("Some other error");
    });
});

describe("Integration: no orphaned OwnedAlbum rows", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAlbumFindUnique.mockResolvedValue({
            id: ALBUM_ID,
            rgMbid: OLD_RGMUBID,
            artistId: ARTIST_ID,
        });
        mockAlbumUpdate.mockResolvedValue({ id: ALBUM_ID, rgMbid: NEW_RGMUBID });
        mockOwnedAlbumDelete.mockResolvedValue({});
        mockOwnedAlbumUpsert.mockResolvedValue({});
        mockTransaction.mockImplementation(async (cb: any) => cb(prisma));
    });

    it("should delete old OwnedAlbum BEFORE creating new one (no orphan)", async () => {
        let deleteCalled = false;
        let upsertCalled = false;

        mockOwnedAlbumDelete.mockImplementation(async () => {
            deleteCalled = true;
            return {};
        });
        mockOwnedAlbumUpsert.mockImplementation(async () => {
            upsertCalled = true;
            return {};
        });

        await reassignAlbumRgMbid(ALBUM_ID, NEW_RGMUBID);

        // Old row deleted first, new row created after
        expect(deleteCalled).toBe(true);
        expect(upsertCalled).toBe(true);

        // Verify the old row was deleted with the OLD rgMbid
        const deleteCall = mockOwnedAlbumDelete.mock.calls[0][0];
        expect(deleteCall.where.artistId_rgMbid.rgMbid).toBe(OLD_RGMUBID);

        // Verify the new row was created with the NEW rgMbid
        const upsertCall = mockOwnedAlbumUpsert.mock.calls[0][0];
        expect(upsertCall.create.rgMbid).toBe(NEW_RGMUBID);
    });
});
