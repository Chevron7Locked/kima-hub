// A backfill an admin asks for stops with the server: once a shutdown has begun, the image backfill and the artist
// recount start no batch, so neither reads the database after it has closed. Real routers, real database; the image
// download is the only thing replaced, and the sign-in is stood in.
jest.mock("../../../services/imageStorage", () => ({
    ...jest.requireActual("../../../services/imageStorage"),
    downloadAndStoreImage: jest.fn(async () => null),
}));

import express from "express";
import request from "supertest";
import backfillRouter from "../backfill";
import artistsRouter from "../artists";
import { prisma } from "../../../utils/db";
import { isBackfillInProgress } from "../../../services/artistCountsService";
import { getImageBackfillProgress } from "../../../services/imageBackfill";
import { downloadAndStoreImage } from "../../../services/imageStorage";
import { useShutdownCheck } from "../../../utils/stopCheck";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { mountAsServer } from "../../__tests__/helpers/serverMount";

const P = "zz-backfill-stop";
const download = downloadAndStoreImage as jest.Mock;
const app = mountAsServer(
    mountAsServer(express().use(express.json()), "/library", backfillRouter, "/api/library", { standIn: true }),
    "/library",
    artistsRouter,
    "/api/library",
    { standIn: true },
);

async function idle() {
    for (let i = 0; i < 400 && (isBackfillInProgress() || getImageBackfillProgress().inProgress); i++) {
        await new Promise((r) => setTimeout(r, 25));
    }
}

beforeAll(async () => {
    await prisma.artist.create({
        data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: P, heroUrl: "http://example.invalid/a.jpg" },
    });
});

afterEach(async () => {
    await idle();
    useShutdownCheck(() => false);
    jest.restoreAllMocks();
    download.mockClear();
});

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
