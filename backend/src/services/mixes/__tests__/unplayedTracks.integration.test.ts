/**
 * unplayedTrackIds against a real Postgres, on a table written in bulk and never analysed (no ANALYZE, so Postgres
 * has no row counts, as right after a library scan): 20,000 tracks, 300,000 plays on the first 10,000. The read must
 * return the right ids and finish within 5 s, which a per-track rescan of Play (`plays: { none: {} }`) would not.
 */
import { prisma } from "../../../utils/db";
import { unplayedTrackIds } from "../helpers";

jest.setTimeout(120_000);

const PREFIX = "unp_";
const TRACKS = 20_000;
const PLAYED = 10_000;
const PLAYS_PER_PLAYED = 30;
const MISSING_FROM = 15_000; // tracks 15000.. have a missing file
const USER = `${PREFIX}user`;
const id = (i: number) => `${PREFIX}trk_${String(i).padStart(6, "0")}`;

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: `${PREFIX}user`, username: `${PREFIX}user`, passwordHash: "x" } });
    await prisma.artist.create({
        data: { id: `${PREFIX}art`, name: "Unplayed Artist", normalizedName: "unplayed artist", identityKey: `${PREFIX}ak` },
    });
    await prisma.album.create({
        data: { id: `${PREFIX}alb`, rgMbid: `${PREFIX}rg`, artistId: `${PREFIX}art`, identityKey: `${PREFIX}ik`, title: "Unplayed Album", primaryType: "Album" },
    });
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "missingSince", "updatedAt")
        SELECT ${PREFIX + "trk_"} || lpad(i::text, 6, '0'), ${PREFIX + "alb"}, 'Unplayed Track ' || i, 1, 200,
               '/tmp/' || ${PREFIX} || i || '.flac', now(), 1000,
               CASE WHEN i >= ${MISSING_FROM} THEN now() END, now()
        FROM generate_series(0, ${TRACKS - 1}) AS i`;
    await prisma.$executeRaw`
        INSERT INTO "Play" (id, "userId", "trackId")
        SELECT ${PREFIX} || 'play_' || i || '_' || k, ${PREFIX + "user"}, ${PREFIX + "trk_"} || lpad(i::text, 6, '0')
        FROM generate_series(0, ${PLAYED - 1}) AS i, generate_series(1, ${PLAYS_PER_PLAYED}) AS k`;
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("unplayedTrackIds on a bulk-written, never-analysed table", () => {
    it("returns every unplayed track, in id order, in seconds", async () => {
        const t0 = Date.now();
        const ids = await unplayedTrackIds({ userId: USER });
        const ms = Date.now() - t0;
        expect(ids).toEqual(Array.from({ length: TRACKS - PLAYED }, (_, k) => id(PLAYED + k)));
        expect(ms).toBeLessThan(5_000);
    });

    it("leaves out tracks whose file is missing when asked", async () => {
        const t0 = Date.now();
        const ids = await unplayedTrackIds({ userId: USER, excludeMissing: true });
        const ms = Date.now() - t0;
        expect(ids).toEqual(Array.from({ length: MISSING_FROM - PLAYED }, (_, k) => id(PLAYED + k)));
        expect(ms).toBeLessThan(5_000);
    });

    it("counts only this listener's plays: another user's play of a song leaves it unplayed", async () => {
        await prisma.user.create({ data: { id: `${PREFIX}user2`, username: `${PREFIX}user2`, passwordHash: "x" } });
        await prisma.play.create({ data: { id: `${PREFIX}extra`, userId: `${PREFIX}user2`, trackId: id(PLAYED) } });
        const mine = await unplayedTrackIds({ userId: USER });
        expect(mine[0]).toBe(id(PLAYED));
        expect(mine).toHaveLength(TRACKS - PLAYED);
        const theirs = await unplayedTrackIds({ userId: `${PREFIX}user2` });
        expect(theirs).not.toContain(id(PLAYED));
        expect(theirs).toHaveLength(TRACKS - 1);
    });
});
