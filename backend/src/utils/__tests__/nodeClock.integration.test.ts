/**
 * A raw statement that stamps a timestamp column such as `updatedAt` or `missingSince` stamps from this process's clock, as Prisma does for its own
 * writes: the scan compares those columns with its own start time, and the database's clock (a container's can be
 * milliseconds ahead of the host's) must not move that comparison. Real suite database.
 */
import { prisma } from "../db";
import { nodeClock } from "../nodeClock";

const artistId = "nodeclock-artist";

beforeEach(async () => {
    await prisma.artist.create({
        data: { id: artistId, name: "nodeclock artist", normalizedName: "nodeclock artist", mbid: "nodeclock-mbid", identityKey: "nodeclock-key" },
    });
});
afterEach(async () => {
    jest.useRealTimers();
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = '${artistId}'`);
});
afterAll(() => prisma.$disconnect());

describe("nodeClock", () => {
    it("stamps the time this process says it is, to the millisecond, whatever the database's clock reads", async () => {
        jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick", "queueMicrotask"], now: new Date("2031-02-03T04:05:06.789Z") });

        await prisma.$executeRaw`UPDATE "Artist" SET "lastSynced" = ${nodeClock()} WHERE id = ${artistId}`;

        const stamped = await prisma.artist.findUniqueOrThrow({ where: { id: artistId }, select: { lastSynced: true } });
        expect(stamped.lastSynced.toISOString()).toBe("2031-02-03T04:05:06.789Z");
    });

    it("stamps one given moment, so two columns of one statement agree", async () => {
        const at = new Date("2032-01-01T00:00:00.123Z");

        await prisma.$executeRaw`UPDATE "Artist" SET "lastEnriched" = ${nodeClock(at)}, "lastSynced" = ${nodeClock(at)} WHERE id = ${artistId}`;

        const row = await prisma.artist.findUniqueOrThrow({ where: { id: artistId }, select: { lastEnriched: true, lastSynced: true } });
        expect(row.lastEnriched?.toISOString()).toBe("2032-01-01T00:00:00.123Z");
        expect(row.lastSynced?.toISOString()).toBe("2032-01-01T00:00:00.123Z");
    });
});
