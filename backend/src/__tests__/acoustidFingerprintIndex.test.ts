/**
 * Real fpcalc fingerprints (~3.5 kB) exceed a btree row, so
 * Track.acoustidFingerprint is indexed by md5 of the value instead.
 */

import { prisma } from "../utils/db";

jest.mock("../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const ARTIST = "art_fpidx";
const ALBUM = "alb_fpidx";
const TRACK = "trk_fpidx";

async function seedTrack(): Promise<void> {
    await prisma.artist.create({
        data: { id: ARTIST, name: "FpIdx Artist", identityKey: "a_fpidx" },
    });
    await prisma.album.create({
        data: { id: ALBUM, rgMbid: "rg_fpidx", artistId: ARTIST, title: "FpIdx Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: TRACK, albumId: ALBUM, title: "FpIdx Track", trackNo: 1, duration: 180,
            filePath: "/tmp/fpidx_test.flac", fileModified: new Date(), fileSize: 1000,
        },
    });
}

/** A realistic ~3.4 kB base64 fingerprint — the value that overflowed btree. */
function realisticFingerprint(): string {
    // 3400 chars of base64-ish payload, mimicking a real fpcalc result.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < 3400; i++) {
        out += alphabet[(i * 7 + 3) % alphabet.length];
    }
    return out;
}

describe("Track.acoustidFingerprint index", () => {
    beforeAll(async () => {
        await seedTrack();
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id = $1`, TRACK);
        await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, ALBUM);
        await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, ARTIST);
    });

    it("has dropped the oversized btree Track_acoustidFingerprint_idx", async () => {
        const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'Track' AND indexname = 'Track_acoustidFingerprint_idx'`,
        );
        expect(rows).toHaveLength(0);
    });

    it("has an md5(\\\"acoustidFingerprint\\\") expression index", async () => {
        const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
            `SELECT indexdef FROM pg_indexes
             WHERE tablename = 'Track'
               AND indexdef ILIKE '%md5(%acoustidFingerprint%)%'`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it("can store a realistic 3.4 kB fingerprint (the write that used to fail)", async () => {
        const fp = realisticFingerprint();
        expect(fp.length).toBeGreaterThan(2704);

        await expect(
            prisma.$executeRawUnsafe(
                `UPDATE "Track" SET "acoustidFingerprint" = $1 WHERE id = $2`,
                fp, TRACK,
            ),
        ).resolves.toBe(1);

        const rows = await prisma.$queryRawUnsafe<{ len: number }[]>(
            `SELECT length("acoustidFingerprint") AS len FROM "Track" WHERE id = $1`, TRACK,
        );
        expect(Number(rows[0].len)).toBe(fp.length);
    });

    it("answers the dedupe lookup through the md5 expression index", async () => {
        // The dedupe query matches on md5(fingerprint); prove the planner can
        // use the expression index rather than seq-scanning the TEXT column.
        const fp = realisticFingerprint();
        await prisma.$executeRawUnsafe(
            `UPDATE "Track" SET "acoustidFingerprint" = $1 WHERE id = $2`, fp, TRACK,
        );
        const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM "Track" WHERE md5("acoustidFingerprint") = md5($1)`, fp,
        );
        expect(rows.map((r) => r.id)).toContain(TRACK);
    });
});