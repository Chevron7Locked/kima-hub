/**
 * The Discover settings (GET/PATCH /discover/config): a listener with none yet starts at the schema's defaults, 10 songs
 * a week; the slider's size round-trips; a first save stores numbers whatever form they arrive in; a value the route
 * cannot store is refused with 400, never a 500. Real database and router; auth is passed through.
 */

jest.mock("../../middleware/auth", () => ({
    ...jest.requireActual("../../middleware/auth"),
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";

const MARK = "zz-discover-config";
let listener: string;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: listener, username: `${MARK}-listener`, role: "user" };
    next();
});
app.use("/discover", discoverRoutes);

const cleanup = () => prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });

beforeAll(cleanup);
afterAll(cleanup);

beforeEach(async () => {
    await cleanup();
    listener = (await prisma.user.create({ data: { username: `${MARK}-listener`, passwordHash: "x" } })).id;
});

const stored = () => prisma.userDiscoverConfig.findUnique({ where: { userId: listener } });

describe("Discover settings", () => {
    it("refuses an on/off value that is not true or false, storing nothing", async () => {
        const res = await request(app).patch("/discover/config").send({ enabled: "no" });
        expect(res.status).toBe(400);
        expect(await stored()).toBeNull();
    });

    it("refuses a size off the slider's steps", async () => {
        const res = await request(app).patch("/discover/config").send({ playlistSize: 7 });
        expect(res.status).toBe(400);
        expect(await stored()).toBeNull();
    });

    it("a first save stores numbers sent as text", async () => {
        const res = await request(app)
            .patch("/discover/config")
            .send({ playlistSize: "15", maxRetryAttempts: "4", exclusionMonths: "3", downloadRatio: "1.5" });
        expect(res.status).toBe(200);
        expect(await stored()).toMatchObject({
            playlistSize: 15, maxRetryAttempts: 4, exclusionMonths: 3, downloadRatio: 1.5, enabled: true,
        });
    });

    it("a listener with no settings yet starts at 10 songs, and so does a row the database fills in", async () => {
        const res = await request(app).get("/discover/config");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            playlistSize: 10, maxRetryAttempts: 3, exclusionMonths: 6, downloadRatio: 1.3, enabled: true,
        });

        await prisma.userDiscoverConfig.delete({ where: { userId: listener } });
        await prisma.userDiscoverConfig.create({ data: { userId: listener } });
        expect((await stored())!.playlistSize).toBe(10);
    });

    it("the slider's size round-trips and leaves the other settings alone", async () => {
        await request(app).patch("/discover/config").send({ downloadRatio: 1.8 }).expect(200);
        await request(app).patch("/discover/config").send({ playlistSize: 25 }).expect(200);

        const res = await request(app).get("/discover/config");
        expect(res.body).toMatchObject({ playlistSize: 25, downloadRatio: 1.8, enabled: true });
    });
});
