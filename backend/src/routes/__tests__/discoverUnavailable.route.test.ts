/**
 * The week's unavailable albums (suggestions no download found) leave the list once they turn up: a suggestion of the
 * week downloaded the release, an album with its release id exists, or an album by that artist carries its title (a
 * bracketed part of the title such as "(Deluxe)" ignored). GET /discover/current hides those; POST
 * /discover/retry-unavailable deletes them instead of downloading them again. Both apply the same rule. Real database
 * and router; auth is passed through.
 */

jest.mock("../../middleware/auth", () => ({
    ...jest.requireActual("../../middleware/auth"),
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import { startOfWeek } from "date-fns";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";
import { resolveViewWeek, WEEK_STARTS_ON } from "../../lib/discoveryWeek";

const MARK = "zz-unavail";
let listener: string;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: listener, username: `${MARK}-listener`, role: "user" };
    next();
});
app.use("/discover", discoverRoutes);

const week = () => resolveViewWeek(startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }), null).weekStart;

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

const unavailable = (albumMbid: string, artistName: string, albumTitle: string) =>
    prisma.unavailableAlbum.create({
        data: { userId: listener, albumMbid, artistName, albumTitle, similarity: 0.5, tier: "medium", weekStartDate: week() },
    });

/** Four unavailable albums: three that have turned up since, and one still missing. */
async function seed() {
    const artist = await prisma.artist.create({ data: { name: `${MARK} Band`, identityKey: `${MARK}-band` } });
    await prisma.album.create({
        data: { rgMbid: `${MARK}-rg-owned`, identityKey: `${MARK}-a1`, title: `${MARK} Other Title`, primaryType: "Album", artistId: artist.id },
    });
    await prisma.album.create({
        data: { rgMbid: `${MARK}-rg-plain`, identityKey: `${MARK}-a2`, title: `${MARK} Plain`, primaryType: "Album", artistId: artist.id },
    });
    await prisma.discoveryAlbum.create({
        data: { userId: listener, rgMbid: `${MARK}-rg-suggested`, artistName: `${MARK} Band`, albumTitle: `${MARK} Suggested`, weekStartDate: week() },
    });
    await unavailable(`${MARK}-rg-suggested`, `${MARK} Band`, `${MARK} Suggested`);
    await unavailable(`${MARK}-rg-owned`, `${MARK} Band`, `${MARK} Renamed`);
    await unavailable(`${MARK}-rg-deluxe`, `${MARK} Band`, `${MARK} Plain (Deluxe)`);
    await unavailable(`${MARK}-rg-missing`, `${MARK} Band`, `${MARK} Missing`);
}

beforeAll(cleanup);
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await cleanup();
    listener = (await prisma.user.create({ data: { username: `${MARK}-listener`, passwordHash: "x" } })).id;
    await seed();
});

describe("unavailable albums that have turned up", () => {
    it("GET /current lists only the album still missing", async () => {
        const res = await request(app).get("/discover/current").expect(200);
        expect(res.body.unavailable.map((a: { albumId: string }) => a.albumId)).toEqual([`${MARK}-rg-missing`]);
    });

    it("POST /retry-unavailable deletes the ones that turned up and downloads nothing when none is left", async () => {
        await prisma.unavailableAlbum.deleteMany({ where: { userId: listener, albumMbid: `${MARK}-rg-missing` } });

        const res = await request(app).post("/discover/retry-unavailable").expect(200);

        expect(res.body).toMatchObject({ success: true, queued: 0 });
        expect(await prisma.unavailableAlbum.count({ where: { userId: listener } })).toBe(0);
        expect(await prisma.downloadJob.count({ where: { userId: listener } })).toBe(0);
    });
});

describe("an unavailable album a download is working on", () => {
    it("is left alone by a retry, even when it has turned up", async () => {
        await prisma.unavailableAlbum.deleteMany({ where: { userId: listener, albumMbid: { not: `${MARK}-rg-owned` } } });
        await prisma.downloadJob.create({
            data: { userId: listener, subject: `${MARK} Band - ${MARK} Renamed`, type: "album", status: "processing", targetMbid: `${MARK}-rg-owned` },
        });

        const res = await request(app).post("/discover/retry-unavailable").expect(200);

        expect(res.body).toMatchObject({ queued: 0, message: "The unavailable albums are already downloading" });
        expect(await prisma.unavailableAlbum.count({ where: { userId: listener } })).toBe(1);
    });
});

describe("a Discover clear that fails", () => {
    let createdSettings = false;
    beforeAll(async () => {
        if (!(await prisma.systemSettings.findUnique({ where: { id: "default" } }))) {
            await prisma.systemSettings.create({ data: { id: "default" } });
            createdSettings = true;
        }
    });
    afterAll(async () => {
        if (createdSettings) await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    });

    it("tells the listener it failed without the server's own error text", async () => {
        const refusal = jest.spyOn(prisma.discoveryAlbum, "findMany").mockRejectedValueOnce(new Error("internal detail"));
        try {
            const res = await request(app).delete("/discover/clear").expect(500);
            expect(res.body).toEqual({ error: "Failed to clear discovery playlist" });
        } finally {
            refusal.mockRestore();
        }
    });
});
