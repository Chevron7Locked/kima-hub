/**
 * The shared MBID reassignment helper's artist half and its error type, on the real database. The album half moves
 * rows across several tables (mbidReassign.db.test.ts).
 */

import { prisma } from "../../utils/db";
import { DuplicateMbidError, reassignArtistMbid } from "../mbidReassign";

const P = "zz-mbidReassign";
const ARTIST_ID = `${P}-artist-456`;
const OTHER_ARTIST_ID = `${P}-artist-789`;
const NEW_RGMBID = "new-rgmbid-uuid";
const ARTIST_MBID = "artist-mbid-uuid";

async function wipe() {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}
async function seedArtist(id: string, mbid: string | null = null) {
    await prisma.artist.create({ data: { id, name: id, identityKey: id, mbid } });
}
beforeAll(wipe);
beforeEach(async () => {
    await wipe();
    await seedArtist(ARTIST_ID);
});
afterAll(wipe);

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
        const err = new DuplicateMbidError("album", NEW_RGMBID);
        expect(err.message).toBe(
            `MBID ${NEW_RGMBID} is already in use by another album`
        );
        expect(err.entityType).toBe("album");
    });
});

describe("reassignArtistMbid", () => {
    afterEach(() => jest.restoreAllMocks());

    it("stores the new mbid on the artist", async () => {
        await reassignArtistMbid(ARTIST_ID, ARTIST_MBID);

        expect((await prisma.artist.findUnique({ where: { id: ARTIST_ID } }))?.mbid).toBe(ARTIST_MBID);
    });

    it("should throw DuplicateMbidError when another artist holds the mbid, and change nothing", async () => {
        await seedArtist(OTHER_ARTIST_ID, ARTIST_MBID);

        await expect(reassignArtistMbid(ARTIST_ID, ARTIST_MBID)).rejects.toThrow(DuplicateMbidError);

        expect((await prisma.artist.findUnique({ where: { id: ARTIST_ID } }))?.mbid).toBeNull();
    });

    it("should re-throw non-P2002 errors", async () => {
        jest.spyOn(prisma.artist, "update").mockRejectedValueOnce(
            Object.assign(new Error("Some other error"), { code: "P2025" }) as never,
        );

        await expect(reassignArtistMbid(ARTIST_ID, ARTIST_MBID)).rejects.toThrow("Some other error");
    });
});
