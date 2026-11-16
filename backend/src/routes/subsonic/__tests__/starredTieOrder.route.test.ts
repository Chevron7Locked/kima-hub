/**
 * Songs liked at the same instant (a bulk like) list in the same order on every call: newest like first, ties by song
 * id. Real database, real router.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { starredRouter } from "../starred";

const MARK = "zz-sub-starred-tie";
const USER = `${MARK}-user`;
const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/", starredRouter);

async function cleanup() {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist`, libraryAlbumCount: 1 } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-al`, identityKey: `${MARK}-al`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY", year: 2020 },
    });
    const likedAt = new Date();
    // Created in the reverse of id order, so an unordered tie would come back in insertion order.
    for (const n of [3, 2, 1]) {
        const track = await prisma.track.create({
            data: { id: `${MARK}-t${n}`, title: `${MARK} ${n}`, albumId: album.id, trackNo: n, duration: 100, mime: "FLAC", filePath: `/${MARK}/${n}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: track.id, likedAt } });
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

// Express routes a call whatever its letter case, so the key follows the route that answered, not the path's text.
it("answers getStarred2 under starred2 however its name is cased, and the legacy getStarred under starred", async () => {
    const v2 = await request(app).get("/getstarred2.view").query({ u: USER, f: "json" }).expect(200).then((r) => r.body["subsonic-response"]);
    expect(v2.starred2).toBeDefined();
    const legacy = await request(app).get("/getStarred.view").query({ u: USER, f: "json" }).expect(200).then((r) => r.body["subsonic-response"]);
    expect(legacy.starred).toBeDefined();
    expect(legacy.starred2).toBeUndefined();
});

it("songs liked at the same instant list by song id", async () => {
    const body = await request(app).get("/getStarred2.view").query({ u: USER, f: "json" }).expect(200).then((r) => r.body["subsonic-response"]);
    const ids = (body.starred2.song ?? []).map((s: { id: string }) => s.id).filter((id: string) => id.startsWith(MARK));
    expect(ids).toEqual([`${MARK}-t1`, `${MARK}-t2`, `${MARK}-t3`]);
});
