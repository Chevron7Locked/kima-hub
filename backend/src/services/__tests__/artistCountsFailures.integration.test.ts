// An artist whose recount fails still counts as looked at: progress is the artists attempted (counted plus failed), so a
// recount with a failure still reaches 100%, and never goes past it when artists arrive mid-run. Real database, with
// the recount's reads scoped to this file's artists.
import { prisma } from "../../utils/db";
import { backfillAllArtistCounts, getBackfillProgress } from "../artistCountsService";
import { scopeArtists } from "../../routes/__tests__/helpers/scopeArtists";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-recfail";
const ids = ["a", "b", "c"].map((k) => `${P}-${k}`);
const FAILS = `${P}-b`;

const addArtist = (id: string) => prisma.artist.create({ data: { id, name: id, normalizedName: id, identityKey: `ik-${id}` } });

beforeAll(async () => {
    for (const id of ids) await addArtist(id);
});

beforeEach(() => scopeArtists(P));

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.artist.deleteMany({ where: { id: `${P}-late` } });
});

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

function failForOneArtist() {
    const realUpdateMany: any = prisma.artist.updateMany.bind(prisma.artist);
    jest.spyOn(prisma.artist, "updateMany").mockImplementation(((args: any) =>
        args?.where?.id === FAILS ? Promise.reject(new Error("write failed")) : realUpdateMany(args)) as any);
}

it("reports artists attempted, failures included, so a recount with a failure still reaches 100%", async () => {
    // The failed artist is logged twice, where it fails and where the recount reports it.
    const logged = expectLog("error");
    failForOneArtist();
    const seen: Array<{ attempted: number; total: number; percent: number; processed: number; errors: number }> = [];
    const result = await backfillAllArtistCounts((attempted, total) => {
        void getBackfillProgress().then((s) => seen.push({ attempted, total, percent: s.percent, processed: s.processed, errors: s.errors }));
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ processed: 2, errors: 1 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(FAILS), expect.any(Error));
    // The one batch holds all three artists; the status keeps successes and failures apart and still reads as done.
    expect(seen).toEqual([{ attempted: 3, total: 3, percent: 100, processed: 2, errors: 1 }]);
});

it("never reports more than 100% when artists arrive after the total was read", async () => {
    // The recount reads its total first. An artist added right after that read is found by its batches but not in the total.
    const readTotal: any = prisma.artist.count.bind(prisma.artist);
    jest.spyOn(prisma.artist, "count").mockImplementationOnce((async (args?: any) => {
        const total = await readTotal(args);
        await addArtist(`${P}-late`);
        return total;
    }) as any);
    const seen: Array<{ attempted: number; total: number; percent: number }> = [];
    await backfillAllArtistCounts((attempted, total) => {
        void getBackfillProgress().then((s) => seen.push({ attempted, total, percent: s.percent }));
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen.at(-1)).toEqual({ attempted: 4, total: 3, percent: 100 });
});
