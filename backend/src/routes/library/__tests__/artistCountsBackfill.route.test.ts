// An admin's recount ask is never dropped: asked while a recount runs, the reply says it is queued and the recount
// goes over the artists once more when it finishes (however many asks came, one more pass). Real router, real
// recount, real database and Redis; only the sign-in is stood in. A pass is seen by the artist count it opens with.
jest.mock("../../../middleware/auth", () => ({
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import artistsRouter from "../artists";
import { prisma } from "../../../utils/db";
import { isBackfillInProgress } from "../../../services/artistCountsService";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { mountAsServer } from "../../__tests__/helpers/serverMount";

const P = "zz-counts-backfill";
const app = mountAsServer(express().use(express.json()), "/library", artistsRouter, "/api/library", { standIn: true });
const ask = () => request(app).post("/library/artist-counts/backfill");

/** Waits for the running recount, and every pass it makes, to end. */
async function idle() {
    for (let i = 0; i < 400 && isBackfillInProgress(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(isBackfillInProgress()).toBe(false);
}

/** Adds this file's prefix to an artist query's filter, so the recount sees only this file's artists. */
const mine = (args: any) => ({ ...args, where: { AND: [args?.where ?? {}, { id: { startsWith: P } }] } });

const gatesOpen: (() => void)[] = [];

/**
 * Scopes the recount's walk to this file's artists and counts its passes (each one opens by counting every artist,
 * a call made with no filter). The recount walks every artist in the database and other suites fill it, so unscoped
 * its time would depend on them. The real queries still run.
 *
 * `hold` lists the recount's artist reads (1 = the first batch of the first pass, 2 = its second batch, and so on
 * across passes) to stop at until released. The case decides when asks arrive and when status is read, so what it
 * sees is fixed by construction, not by how fast the machine is.
 */
function scopeRecount(hold: number[] = []) {
    const realCount: any = prisma.artist.count.bind(prisma.artist);
    const realFindMany: any = prisma.artist.findMany.bind(prisma.artist);
    let passes = 0;
    let reads = 0;
    const gates = new Map(
        hold.map((read) => {
            let arrive!: () => void;
            let open!: () => void;
            const arrived = new Promise<void>((resolve) => (arrive = resolve));
            const opened = new Promise<void>((resolve) => (open = resolve));
            gatesOpen.push(open);
            return [read, { arrive, open, arrived, opened }] as const;
        })
    );
    jest.spyOn(prisma.artist, "count").mockImplementation(((args?: any) => {
        if (args === undefined) passes++;
        return realCount(mine(args));
    }) as any);
    jest.spyOn(prisma.artist, "findMany").mockImplementation((async (args?: any) => {
        const gate = gates.get(++reads);
        if (gate) {
            gate.arrive();
            await gate.opened;
        }
        return realFindMany(mine(args));
    }) as any);
    return {
        passes: () => passes,
        /** Resolves when the recount has reached read `read`, which it holds. */
        reached: (read: number) => gates.get(read)!.arrived,
        release: (read: number) => gates.get(read)!.open(),
    };
}

beforeAll(async () => {
    // One more than a batch of 100, so a pass reads two batches.
    await prisma.artist.createMany({
        data: Array.from({ length: 105 }, (_, i) => ({ id: `${P}-ar-${i}`, name: `${P}-${i}`, normalizedName: `${P}-${i}`, identityKey: `${P}-ik-${i}` })),
    });
});

afterEach(async () => {
    for (const open of gatesOpen.splice(0)) open();
    await idle();
    jest.restoreAllMocks();
});

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

it("starts a recount when none is running", async () => {
    const recount = scopeRecount();
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Backfill started", status: "processing" });
    await idle();
    expect(recount.passes()).toBe(1);
});

it("keeps asks made during a run: they are queued, and the run goes over the artists once more", async () => {
    const recount = scopeRecount([1]);
    const first = await ask();
    expect(first.body.status).toBe("processing");
    const [second, third] = await Promise.all([ask(), ask()]);
    for (const res of [second, third]) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: "Backfill queued: it runs once more when the current one finishes", status: "queued" });
    }
    recount.release(1);
    await idle();
    expect(recount.passes()).toBe(2);
});

it("reports a queued extra pass as its own pass, so progress inside a pass never goes backwards", async () => {
    // Holds the first batch of each pass and the second batch of the first, and reads status at each.
    const recount = scopeRecount([1, 2, 4]);
    const status = async () => (await request(app).get("/library/artist-counts/status")).body;

    expect((await ask()).body.status).toBe("processing");
    await recount.reached(1);
    expect(await status()).toMatchObject({ isRunning: true, pass: 1, processed: 0 });
    // Asked while the first pass is held, so it is certainly running.
    expect((await ask()).body.status).toBe("queued");

    recount.release(1);
    await recount.reached(2);
    expect(await status()).toMatchObject({ isRunning: true, pass: 1, processed: 100 });

    // The queued ask is answered as the second pass, which starts from zero under its own number.
    recount.release(2);
    await recount.reached(4);
    expect(await status()).toMatchObject({ isRunning: true, pass: 2, processed: 0 });

    recount.release(4);
    await idle();
    expect(recount.passes()).toBe(2);
    // Once it is over the status carries no pass.
    expect(await status()).toMatchObject({ isRunning: false, pass: 0 });
});
