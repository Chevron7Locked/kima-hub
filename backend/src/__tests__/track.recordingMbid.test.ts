/** Track.recordingMbid stores the recording an AcoustID fingerprint matched. */

import { prisma } from "../utils/db";

jest.mock("../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const ARTIST = "art_recmbid";
const ALBUM = "alb_recmbid";
const TRACK = "trk_recmbid";

async function seedTrack(): Promise<void> {
    await prisma.artist.create({
        data: { id: ARTIST, name: "MBID Test Artist", identityKey: "a_recmbid" },
    });
    await prisma.album.create({
        data: { id: ALBUM, rgMbid: "rg_recmbid", artistId: ARTIST, title: "MBID Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: TRACK, albumId: ALBUM, title: "MBID Track", trackNo: 1, duration: 180,
            filePath: "/tmp/recmbid_test.flac", fileModified: new Date(), fileSize: 1000,
        },
    });
}

describe("Track.recordingMbid", () => {
    beforeAll(async () => {
        await seedTrack();
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id = $1`, TRACK);
        await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, ALBUM);
        await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, ARTIST);
    });

    it("declares a recordingMbid column on Track", async () => {
        const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'Track' AND column_name = 'recordingMbid'`,
        );
        expect(rows).toHaveLength(1);
    });

    it("accepts and stores a UUID recording MBID", async () => {
        const mbid = "8e45ac7e-27c5-4b72-9a1c-1c4b8f0d1234";
        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "Track" SET "recordingMbid" = $1 WHERE id = $2`,
                mbid, TRACK,
            ),
        ).resolves.toBe(1);

        const rows = await prisma.$queryRawUnsafe<{ recordingMbid: string }[]>(
            `SELECT "recordingMbid" FROM "Track" WHERE id = $1`, TRACK,
        );
        expect(rows[0].recordingMbid).toBe(mbid);
    });

    it("allows the column to stay null (no match recorded)", async () => {
        // A track whose fingerprint did not match must be able to hold no
        // recording MBID — the design never invents one.
        await prisma.$executeRawUnsafe(
            `UPDATE "Track" SET "recordingMbid" = NULL WHERE id = $1`, TRACK,
        );
        const rows = await prisma.$queryRawUnsafe<{ recordingMbid: string | null }[]>(
            `SELECT "recordingMbid" FROM "Track" WHERE id = $1`, TRACK,
        );
        expect(rows[0].recordingMbid).toBeNull();
    });
});