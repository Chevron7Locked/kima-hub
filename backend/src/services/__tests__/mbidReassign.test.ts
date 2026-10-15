/**
 * The shared MBID reassignment helper's artist half and its error type. The album half moves rows
 * across several tables and is tested against the real database (mbidReassign.db.test.ts).
 */

import { prisma } from "../../utils/db";
import { DuplicateMbidError, reassignArtistMbid } from "../mbidReassign";

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
        discoveryAlbum: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn(),
        },
        $transaction: jest.fn(async (cb: any) => cb(prisma)),
    },
}));

const mockArtistUpdate = prisma.artist.update as jest.Mock;

const ARTIST_ID = "artist-456";
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
