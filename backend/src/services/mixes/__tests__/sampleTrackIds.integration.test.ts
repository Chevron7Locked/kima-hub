/**
 * sampleTrackIds on a real Postgres: a draw of `take` distinct playable songs matching a Prisma filter, uniformly at
 * random, without the database handing the server every matching id.
 */
import { prisma } from "../../../utils/db";
import { getEffectiveDecadeWhereClause } from "../../../utils/dateFilters";
import { sampleTrackIds } from "../helpers";

jest.setTimeout(120_000);

const PREFIX = "smp_";
const ALBUMS = 30;
const PER_ALBUM = 50;
const tid = (album: number, n: number) => `${PREFIX}trk_${album}_${n}`;
const mine = { id: { startsWith: PREFIX } };

async function cleanup() {
    await prisma.track.deleteMany({ where: mine });
    await prisma.album.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${PREFIX}art`, name: "Sample Artist", identityKey: `${PREFIX}ak` } });
    // Album 0 is a Discover suggestion; album 1 holds only missing and corrupt songs; albums 10 and 20 are the
    // 1980s (a rare filter: 100 of the 1400 playable songs); the rest are plain library albums.
    await prisma.album.createMany({
        data: Array.from({ length: ALBUMS }, (_, b) => ({
            id: `${PREFIX}alb_${b}`, rgMbid: `${PREFIX}rg_${b}`, artistId: `${PREFIX}art`, identityKey: `${PREFIX}ik_${b}`,
            title: `Sample Album ${b}`, primaryType: "Album",
            location: b === 0 ? "DISCOVER" : "LIBRARY",
            year: b === 10 || b === 20 ? 1985 : 2005,
        })),
    });
    await prisma.track.createMany({
        data: Array.from({ length: ALBUMS * PER_ALBUM }, (_, i) => {
            const album = Math.floor(i / PER_ALBUM);
            const n = i % PER_ALBUM;
            return {
                id: tid(album, n), albumId: `${PREFIX}alb_${album}`, title: `Sample Track ${album}-${n}`, trackNo: n + 1, duration: 200,
                filePath: `/tmp/${tid(album, n)}.flac`, fileModified: new Date(), fileSize: 1000,
                missingSince: album === 1 && n % 2 === 0 ? new Date() : null,
                corrupt: album === 1 && n % 2 === 1,
            };
        }),
    });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

const PLAYABLE = (ALBUMS - 2) * PER_ALBUM;

/** This file's playable songs matching a filter, read the plain way. */
const playableIds = async (album: object = {}) =>
    new Set(
        (
            await prisma.track.findMany({
                where: { ...mine, missingSince: null, corrupt: false, album: { location: "LIBRARY", ...album } },
                select: { id: true },
            })
        ).map((t) => t.id)
    );

describe("sampleTrackIds", () => {
    it("is `take` distinct playable songs, never a Discover, missing or corrupt one", async () => {
        const playable = await playableIds();
        expect(playable.size).toBe(PLAYABLE);
        for (let i = 0; i < 20; i++) {
            const ids = await sampleTrackIds({ where: mine, take: 100 });
            expect(ids).toHaveLength(100);
            expect(new Set(ids).size).toBe(100);
            for (const id of ids) expect(playable.has(id)).toBe(true);
        }
    });

    it("is every playable match when fewer than take match", async () => {
        const playable = await playableIds();
        const all = await sampleTrackIds({ where: mine, take: PLAYABLE + 500 });
        expect(all).toHaveLength(PLAYABLE);
        expect(new Set(all)).toEqual(playable);
    });

    it("keeps to the filter, and fills the draw when the filter matches few songs", async () => {
        const eighties = await playableIds(getEffectiveDecadeWhereClause(1980));
        expect(eighties.size).toBe(2 * PER_ALBUM);
        for (let i = 0; i < 10; i++) {
            const ids = await sampleTrackIds({ where: { ...mine, album: getEffectiveDecadeWhereClause(1980) }, take: 30 });
            expect(ids).toHaveLength(30);
            expect(new Set(ids).size).toBe(30);
            for (const id of ids) expect(eighties.has(id)).toBe(true);
        }
        const few = await sampleTrackIds({ where: { ...mine, title: "Sample Track 10-5" }, take: 30 });
        expect(few).toEqual([tid(10, 5)]);
    });

    it("draws differently each call and reaches the whole match over many draws, not the first rows", async () => {
        const a = await sampleTrackIds({ where: mine, take: 100 });
        const b = await sampleTrackIds({ where: mine, take: 100 });
        expect(a).not.toEqual(b);

        const seen = new Set<string>();
        for (let i = 0; i < 30; i++) for (const id of await sampleTrackIds({ where: mine, take: 100 })) seen.add(id);
        // 30 draws of 100 from 1400: about 1400 * (1 - (1 - 100/1400)^30) = 1250 distinct expected.
        expect(seen.size).toBeGreaterThan(1000);
        // The last songs by id are not favoured either.
        expect([...seen].filter((id) => id > tid(25, 0)).length).toBeGreaterThan(100);
    });

    it("does not read every matching id to draw a few", async () => {
        let read = 0;
        const raw = prisma.$queryRaw.bind(prisma) as unknown as (...args: unknown[]) => Promise<unknown[]>;
        const rawSpy = jest.spyOn(prisma, "$queryRaw").mockImplementation((async (...args: unknown[]) => {
            const rows = await raw(...args);
            read += rows.length;
            return rows;
        }) as never);
        const find = prisma.track.findMany.bind(prisma.track) as unknown as (args: unknown) => Promise<unknown[]>;
        const findSpy = jest.spyOn(prisma.track, "findMany").mockImplementation((async (args: unknown) => {
            const rows = await find(args);
            read += rows.length;
            return rows;
        }) as never);
        try {
            const ids = await sampleTrackIds({ where: mine, take: 20 });
            expect(ids).toHaveLength(20);
            // The 1400 matching ids are not all read: a draw of 20 reads a few times that.
            expect(read).toBeLessThan(20 * 20);
        } finally {
            rawSpy.mockRestore();
            findSpy.mockRestore();
        }
    });
});
