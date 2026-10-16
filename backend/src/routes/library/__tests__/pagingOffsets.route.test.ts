/**
 * The library's list routes read a page's start from the request: a negative or non-number offset is the first page,
 * never a database error answered as 500. Real routers and database; only the signed-in user is injected, as the
 * parent router would.
 */
jest.mock("../../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from "express";
import request from "supertest";
import albums from "../albums";
import artists from "../artists";
import tracks from "../tracks";
import { libraryRouter } from "../../subsonic/library";
import { prisma } from "../../../utils/db";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const P = "zz-paging";
const app = express();
app.use((req: any, _res, next) => {
    req.user = { id: `${P}-user`, username: `${P}-user`, role: "admin" };
    next();
});
app.use("/library", albums, artists, tracks);
app.use("/rest", libraryRouter);

beforeAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: `${P}-user` } });
    await prisma.user.create({ data: { id: `${P}-user`, username: `${P}-user`, passwordHash: "x", role: "admin" } });
    await prisma.artist.create({ data: { id: `${P}-art`, name: "Paging Artist", identityKey: P, libraryAlbumCount: 1 } });
    await prisma.album.create({
        data: { id: `${P}-alb`, rgMbid: `${P}-rg`, artistId: `${P}-art`, title: "Paging Album", primaryType: "Album", location: "LIBRARY" },
    });
    await prisma.track.create({
        data: { id: `${P}-trk`, albumId: `${P}-alb`, title: "Paging Song", trackNo: 1, duration: 200, filePath: `/${P}.flac`, fileModified: new Date(), fileSize: 1000 },
    });
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: `${P}-user` } });
    await closeEngineConnections();
});

it.each(["/library/albums?filter=all", "/library/artists?filter=all", "/library/tracks"])(
    "%s reads offset=-5 and offset=abc as the first page",
    async (path) => {
        const first = await request(app).get(path);
        expect(first.status).toBe(200);
        for (const offset of ["-5", "abc"]) {
            const res = await request(app).get(`${path}&offset=${offset}`.replace("tracks&", "tracks?"));
            expect(res.status).toBe(200);
            expect(res.body).toEqual(first.body);
        }
    },
);

it("Subsonic getAlbumList2 reads a negative or junk size and offset as the defaults", async () => {
    const res = await request(app).get("/rest/getAlbumList2.view").query({ type: "alphabeticalByName", size: "-3", offset: "-5", f: "json" });
    expect(res.status).toBe(200);
    expect(res.body["subsonic-response"].status).toBe("ok");
    const junk = await request(app).get("/rest/getAlbumList2.view").query({ type: "alphabeticalByName", size: "abc", offset: "abc", f: "json" });
    expect(junk.status).toBe(200);
    expect(junk.body["subsonic-response"].status).toBe("ok");
});
