/**
 * Subsonic's `recent` and `frequent` album lists read listens, as the stats pages do: plays of a song fold into one listen
 * while it could still be playing. An album replayed in a burst is one listen, not five, and `recent` orders by the
 * newest listen. Real database, real router; only Subsonic auth is injected, as the parent router would.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { libraryRouter } from "../library";

const P = "zz-albumlisten";
const USER = `${P}-user`;
const ARTIST = `${P}-ar`;
const burst = `${P}-burst`; // one song, five plays seconds apart: one listen
const spread = `${P}-spread`; // one song, two plays a day apart: two listens
const DAY = 24 * 3600 * 1000;

const app = express();
app.use((req: any, _res, next) => {
    req.user = { id: USER, username: USER, role: "user" };
    next();
});
app.use("/", libraryRouter);

const list = async (type: string) => {
    const res = await request(app).get("/getAlbumList2.view").query({ f: "json", type, size: "500" });
    expect(res.status).toBe(200);
    const albums: Array<{ id: string }> = res.body["subsonic-response"].albumList2.album ?? [];
    return albums.map((a) => a.id).filter((id) => id.startsWith(P));
};

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({ data: { id: ARTIST, name: P, normalizedName: P, identityKey: `${P}-ik`, libraryAlbumCount: 2 } });
    for (const id of [burst, spread]) {
        await prisma.album.create({
            data: { id, rgMbid: `${id}-rg`, artistId: ARTIST, identityKey: id, title: `${P} ${id}`, primaryType: "Album", location: "LIBRARY" },
        });
        await prisma.track.create({
            data: { id: `${id}-t`, albumId: id, title: `${P} ${id}`, trackNo: 1, duration: 200, mime: "FLAC", filePath: `/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
    const now = Date.now();
    // Five plays ten seconds apart, the newest a minute ago.
    for (let i = 0; i < 5; i++) {
        await prisma.play.create({ data: { userId: USER, trackId: `${burst}-t`, playedAt: new Date(now - 60_000 - i * 10_000) } });
    }
    // Two plays a day apart, the newest two days ago.
    for (let i = 0; i < 2; i++) {
        await prisma.play.create({ data: { userId: USER, trackId: `${spread}-t`, playedAt: new Date(now - 2 * DAY - i * DAY) } });
    }
});

afterAll(async () => {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.$disconnect();
});

describe("the album lists that read plays", () => {
    it("count listens in frequent: a burst of repeats is one listen, so two real listens come first", async () => {
        expect(await list("frequent")).toEqual([spread, burst]);
    });

    it("order recent by the newest listen", async () => {
        expect(await list("recent")).toEqual([burst, spread]);
    });
});
