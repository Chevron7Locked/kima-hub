// A recount asked for while one runs is not dropped: the running recount runs once more when it finishes, however
// many were asked for. Real database; the artist's counts are read back from its row.
import { prisma } from "../../utils/db";
import { backfillAllArtistCounts, isBackfillInProgress, updateArtistCounts } from "../artistCountsService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-recount";
// Sorts before every other artist id, so the running recount has counted it by the end of its first batch.
const ARTIST = `0${P}-ar`;

async function addAlbum(n: number) {
    await prisma.album.create({
        data: {
            id: `${P}-al-${n}`, rgMbid: `${P}-rg-${n}`, artistId: ARTIST, identityKey: `${P}-ik-${n}`, title: `${P} ${n}`,
            primaryType: "Album", location: "LIBRARY",
            tracks: { create: { id: `${P}-t-${n}`, title: `${P} ${n}`, trackNo: 1, duration: 100, filePath: `${P}-${n}.flac`, fileModified: new Date(), fileSize: 1 } },
        },
    });
}

beforeAll(async () => {
    await prisma.artist.create({ data: { id: ARTIST, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    await addAlbum(0);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await closeEngineConnections();
});

const counted = async () => (await prisma.artist.findUniqueOrThrow({ where: { id: ARTIST } })).libraryAlbumCount;

it("counts again an artist that changed after the running recount passed it, and asks only once more for any number of requests", async () => {
    let change: Promise<unknown> | undefined;
    const asked: Promise<{ processed: number; errors: number }>[] = [];
    // The song's insert is not part of what the recount waits for, so on a slow machine the next pass could start before
    // the song is in. The recount's next read waits for it: the artist changes while the first pass is still running.
    const realFindMany: any = prisma.artist.findMany.bind(prisma.artist);
    const findMany = jest.spyOn(prisma.artist, "findMany").mockImplementation((async (args: any) => {
        await change;
        return realFindMany(args);
    }) as any);
    const running = backfillAllArtistCounts(() => {
        // The first batch is done, so the artist is counted. A song arrives, and the scan asks for a recount three times.
        if (change) return;
        change = addAlbum(1);
        for (let i = 0; i < 3; i++) asked.push(backfillAllArtistCounts());
    });
    expect(isBackfillInProgress()).toBe(true);
    const total = await prisma.artist.count();
    const result = await running;
    await change;
    await Promise.all(asked);
    findMany.mockRestore();

    expect(await counted()).toBe(2);
    expect(isBackfillInProgress()).toBe(false);
    // Two passes over the artists (the run and the one more run), not four.
    expect(result.processed).toBeGreaterThanOrEqual(total * 2);
    expect(result.processed).toBeLessThan(total * 3);
});

it("runs once, with no second pass, when nothing was asked for meanwhile", async () => {
    const total = await prisma.artist.count();
    const result = await backfillAllArtistCounts();
    expect(result.processed).toBe(total);
});

it("recounting an artist that is gone is nothing to do, not an error", async () => {
    await expect(updateArtistCounts(`${P}-never-existed`)).resolves.toBeUndefined();
});
