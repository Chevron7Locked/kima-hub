/**
 * A transaction that lost to another one is run again after a short random wait, and a conflict on every run reaches
 * the caller as the conflict itself. The conflicts are real, produced on the suite database: a Repeatable Read
 * transaction whose row changed under it (serialization failure), and two transactions that each hold the row the
 * other wants (deadlock).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { retryOnConflict } from "../dbConflict";
import { untilLockWait } from "../../__tests__/helpers/lockWait";

jest.setTimeout(60_000);

const TX = { timeout: 30_000, maxWait: 30_000 };
const P = "roc";
const artistId = (n: number) => `${P}a${n}`;

beforeEach(async () => {
    await prisma.artist.createMany({
        data: [1, 2].map((n) => ({ id: artistId(n), name: `${P} artist ${n}`, normalizedName: `${P} artist ${n}`, mbid: `${P}-mbid-${n}`, identityKey: `${P}-key-${n}` })),
    });
});
afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
});
afterAll(() => prisma.$disconnect());

/**
 * One run of a transaction that finds its row changed under it, the way another writer's commit does, unless
 * `conflicts` says this run goes through.
 */
function serializationRun(conflicts: (run: number) => boolean) {
    const started: number[] = [];
    const run = () =>
        prisma.$transaction(
            async (tx) => {
                started.push(Date.now());
                await tx.$queryRawUnsafe(`SELECT id FROM "Artist" WHERE id = $1`, artistId(1));
                if (conflicts(started.length)) {
                    await prisma.$executeRawUnsafe(`UPDATE "Artist" SET name = 'changed under it' WHERE id = $1`, artistId(1));
                }
                await tx.artist.update({ where: { id: artistId(1) }, data: { name: `${P} written by run ${started.length}` } });
                return started.length;
            },
            { ...TX, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
    return { run, started };
}

describe("retryOnConflict", () => {
    it("runs again after a real serialization failure and returns what the second run returns", async () => {
        const { run, started } = serializationRun((n) => n === 1);

        expect(await retryOnConflict(run, { runs: 3 })).toBe(2);

        expect(started).toHaveLength(2);
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: artistId(1) } })).name).toBe(`${P} written by run 2`);
    });

    it("runs again after a real deadlock", async () => {
        let runs = 0;
        const victimRun = () =>
            retryOnConflict(
                () =>
                    prisma.$transaction(async (tx) => {
                        runs++;
                        await tx.$executeRawUnsafe(`UPDATE "Artist" SET name = name || '' WHERE id = $1`, artistId(2));
                        await tx.$executeRawUnsafe(`UPDATE "Artist" SET name = name || '' WHERE id = $1`, artistId(1));
                        return runs;
                    }, TX),
                { runs: 2 },
            );

        let victim!: Promise<number>;
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`UPDATE "Artist" SET name = name || '' WHERE id = $1`, artistId(1));
            victim = victimRun();
            await untilLockWait(`UPDATE "Artist"`);
            await tx.$executeRawUnsafe(`UPDATE "Artist" SET name = name || '' WHERE id = $1`, artistId(2));
        }, TX);

        expect(await victim).toBe(2);
    });

    it("throws the conflict itself, not nothing, when every run meets one", async () => {
        const { run, started } = serializationRun(() => true);

        const error = await retryOnConflict(run, { runs: 3 }).catch((e: unknown) => e);

        expect(started).toHaveLength(3);
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((error as { code?: string }).code).toBe("P2034");
    });

    it("does not run again at all when it is given one run", async () => {
        const { run, started } = serializationRun(() => true);

        await expect(retryOnConflict(run, { runs: 1 })).rejects.toMatchObject({ code: "P2034" });

        expect(started).toHaveLength(1);
    });

    it("throws any other failure at once", async () => {
        const run = jest.fn().mockRejectedValue(new Error("connection reset"));

        await expect(retryOnConflict(run, { runs: 3 })).rejects.toThrow("connection reset");

        expect(run).toHaveBeenCalledTimes(1);
    });

    it("returns the first run's value without waiting when nothing conflicts", async () => {
        const run = jest.fn().mockResolvedValue("ok");
        const dice = jest.spyOn(Math, "random");

        expect(await retryOnConflict(run, { runs: 3 })).toBe("ok");

        expect(run).toHaveBeenCalledTimes(1);
        expect(dice).not.toHaveBeenCalled();
    });

    // The wait is 50 to 200 ms, so two transactions that lost to each other do not start again in step.
    it.each([
        { roll: 0, least: 45, most: 1500 },
        { roll: 0.999, least: 190, most: 2000 },
    ])("waits a short random moment between runs (dice $roll)", async ({ roll, least, most }) => {
        jest.spyOn(Math, "random").mockReturnValue(roll);
        const { run, started } = serializationRun((n) => n === 1);

        await retryOnConflict(run, { runs: 2 });

        const waited = started[1] - started[0];
        expect(waited).toBeGreaterThanOrEqual(least);
        expect(waited).toBeLessThan(most);
    });

    it("tells the caller each lost run, for its log, and waits after none that it throws on", async () => {
        const { run } = serializationRun(() => true);
        const lost: Array<{ run: number; runs: number; waitMs: number }> = [];

        await retryOnConflict(run, {
            runs: 3,
            onLostRun: ({ run: n, runs, waitMs }) => lost.push({ run: n, runs, waitMs }),
        }).catch(() => undefined);

        expect(lost.map((l) => l.run)).toEqual([1, 2]);
        for (const l of lost) {
            expect(l.runs).toBe(3);
            expect(l.waitMs).toBeGreaterThanOrEqual(50);
            expect(l.waitMs).toBeLessThan(200);
        }
    });
});
