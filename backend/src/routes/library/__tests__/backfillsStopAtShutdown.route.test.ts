// A backfill an admin asks for stops with the server: once a shutdown has begun, the image backfill and the artist
// recount start no batch, so neither reads the database after it has closed. Real routers, real database; the image
// download is the only thing replaced, and the sign-in is stood in.
jest.mock("../../../services/imageStorage", () => ({
    ...jest.requireActual("../../../services/imageStorage"),
    stageDownloadedImage: jest.fn(async () => null),
}));

import express from "express";
import request from "supertest";
import backfillRouter from "../backfill";
import artistsRouter from "../artists";
import { prisma } from "../../../utils/db";
import { isBackfillInProgress } from "../../../services/artistCountsService";
import { getImageBackfillProgress } from "../../../services/imageBackfill";
import { stageDownloadedImage } from "../../../services/imageStorage";
import { useShutdownCheck, whenRequestWorkEnded } from "../../../utils/stopCheck";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { mountAsServer } from "../../__tests__/helpers/serverMount";
import { scopeArtists } from "../../__tests__/helpers/scopeArtists";

const P = "zz-backfill-stop";
const download = stageDownloadedImage as jest.Mock;
const app = mountAsServer(
    mountAsServer(express().use(express.json()), "/library", backfillRouter, "/api/library", { standIn: true }),
    "/library",
    artistsRouter,
    "/api/library",
    { standIn: true },
);

const IDLE_LIMIT_MS = 10_000;
async function idle() {
    const until = Date.now() + IDLE_LIMIT_MS;
    while ((isBackfillInProgress() || getImageBackfillProgress().inProgress) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 25));
    }
    // A backfill that never ends fails here, as itself, and not as a later test's leftover.
    expect(isBackfillInProgress() || getImageBackfillProgress().inProgress).toBe(false);
}

beforeAll(async () => {
    await prisma.artist.create({
        data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: P, heroUrl: "http://example.invalid/a.jpg" },
    });
});

// Both walks see only this file's artist: unscoped they would cover every artist the other suites of a run have made.
beforeEach(() => scopeArtists(P));

afterEach(async () => {
    await idle();
    useShutdownCheck(() => false);
    jest.restoreAllMocks();
    download.mockClear();
    // Longer than idle waits, so a backfill that does not end does not fail as a hook that timed out first.
}, IDLE_LIMIT_MS + 5_000);

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

describe("POST /library/image-backfill/start", () => {
    it("downloads our artist's image when no shutdown has begun", async () => {
        const res = await request(app).post("/library/image-backfill/start");
        expect(res.status).toBe(200);
        await idle();
        expect(download.mock.calls.filter(([, id]) => id === `${P}-ar`)).toHaveLength(1);
    });

    it("starts no batch once a shutdown has begun", async () => {
        useShutdownCheck(() => true);
        const findMany = jest.spyOn(prisma.artist, "findMany");

        const res = await request(app).post("/library/image-backfill/start");
        await idle();

        expect(res.status).toBe(200);
        expect(findMany).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
    });
});

// The shutdown's drain waits for work a request started, not only for the catch-up work: the database stays open until
// the batch under way has ended.
describe("the shutdown's drain and a backfill an admin started", () => {
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    /** Something held until `release`, and a signal (`reached`) that the code under test has got to it. */
    const held = () => {
        let release!: () => void;
        let reach!: () => void;
        const done = new Promise<void>((resolve) => (release = resolve));
        const reached = new Promise<void>((resolve) => (reach = resolve));
        return { done, release, reach, reached };
    };
    async function drainsOnlyAfter(release: () => void) {
        let drained = false;
        const waiting = whenRequestWorkEnded().then(() => (drained = true));
        await flush();
        await flush();
        expect(drained).toBe(false);
        release();
        await waiting;
        expect(drained).toBe(true);
    }

    it("holds the drain while the image backfill's download is under way", async () => {
        const download_ = held();
        download.mockImplementationOnce(async () => {
            download_.reach();
            await download_.done;
            return null;
        });

        await request(app).post("/library/image-backfill/start").expect(200);
        await download_.reached;
        expect(download).toHaveBeenCalledTimes(1);

        await drainsOnlyAfter(download_.release);
    });

    it("holds the drain while the artist recount's batch is under way", async () => {
        const count = held();
        // Bound after beforeEach's scopeArtists, so this is the scoped count: the recount's own query stays scoped to P.
        const realCount = prisma.artist.count.bind(prisma.artist) as (...args: unknown[]) => Promise<number>;
        jest.spyOn(prisma.artist, "count").mockImplementationOnce((async (...args: unknown[]) => {
            count.reach();
            await count.done;
            return realCount(...args);
        }) as never);

        await request(app).post("/library/artist-counts/backfill").expect(200);
        await count.reached;

        await drainsOnlyAfter(count.release);
    });
});

describe("POST /library/artist-counts/backfill", () => {
    it("recounts the artists when no shutdown has begun", async () => {
        const findMany = jest.spyOn(prisma.artist, "findMany");

        await request(app).post("/library/artist-counts/backfill");
        await idle();

        expect(findMany).toHaveBeenCalled();
    });

    it("starts no batch once a shutdown has begun", async () => {
        useShutdownCheck(() => true);
        const findMany = jest.spyOn(prisma.artist, "findMany");

        const res = await request(app).post("/library/artist-counts/backfill");
        await idle();

        expect(res.status).toBe(200);
        expect(findMany).not.toHaveBeenCalled();
    });
});
