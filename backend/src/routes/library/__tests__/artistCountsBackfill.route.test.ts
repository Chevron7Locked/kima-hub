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

const P = "zz-counts-backfill";
const app = express().use(express.json()).use("/library", artistsRouter);
const ask = () => request(app).post("/library/artist-counts/backfill");

/** Waits for the running recount, and every pass it makes, to end. */
async function idle() {
    for (let i = 0; i < 400 && isBackfillInProgress(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(isBackfillInProgress()).toBe(false);
}

/** How many passes a recount made: each one opens by counting every artist. */
const passes = (count: jest.SpyInstance) => count.mock.calls.filter(([args]) => args === undefined).length;

beforeAll(async () => {
    // A pass pauses between batches of 100 artists, so a few hundred rows keep it running while the asks arrive.
    await prisma.artist.createMany({
        data: Array.from({ length: 450 }, (_, i) => ({ id: `${P}-ar-${i}`, name: `${P}-${i}`, normalizedName: `${P}-${i}`, identityKey: `${P}-ik-${i}` })),
    });
});

afterEach(async () => {
    await idle();
    jest.restoreAllMocks();
});

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

it("starts a recount when none is running", async () => {
    const count = jest.spyOn(prisma.artist, "count");
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Backfill started", status: "processing" });
    await idle();
    expect(passes(count)).toBe(1);
});

it("keeps asks made during a run: they are queued, and the run goes over the artists once more", async () => {
    const count = jest.spyOn(prisma.artist, "count");
    const first = await ask();
    expect(first.body.status).toBe("processing");
    const [second, third] = await Promise.all([ask(), ask()]);
    for (const res of [second, third]) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: "Backfill queued: it runs once more when the current one finishes", status: "queued" });
    }
    await idle();
    expect(passes(count)).toBe(2);
});

it("reports a queued extra pass as its own pass, so progress inside a pass never goes backwards", async () => {
    // Polled while the run and its extra pass go on: (pass, processed) for every answer that says it is running.
    const seen: { pass: number; processed: number }[] = [];
    let polling = true;
    const poll = (async () => {
        while (polling) {
            const body = (await request(app).get("/library/artist-counts/status")).body;
            if (body.isRunning) seen.push({ pass: body.pass, processed: body.processed });
            await new Promise((r) => setTimeout(r, 25));
        }
    })();

    expect((await ask()).body.status).toBe("processing");
    // Asked straight away, while the first pass (450 artists, paused between batches) is still counting.
    expect((await ask()).body.status).toBe("queued");
    await idle();
    polling = false;
    await poll;

    expect(seen.length).toBeGreaterThan(2);
    // The ask is answered as the second pass, and each pass starts from zero under its own number.
    expect(new Set(seen.map((s) => s.pass))).toEqual(new Set([1, 2]));
    for (let i = 1; i < seen.length; i++) {
        if (seen[i].pass === seen[i - 1].pass) expect(seen[i].processed).toBeGreaterThanOrEqual(seen[i - 1].processed);
        else expect(seen[i].pass).toBe(seen[i - 1].pass + 1);
    }
    // Once it is over the status carries no pass.
    expect((await request(app).get("/library/artist-counts/status")).body).toMatchObject({ isRunning: false, pass: 0 });
}, 30_000);
