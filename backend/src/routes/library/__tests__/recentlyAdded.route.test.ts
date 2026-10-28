// Recently added lists artists by their newest library album, as many as asked for, however many albums the newest
// artist added. Real database; the router is mounted with a user on the request as the app's auth would put it.

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import tracksRouter from "../tracks";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const P = "zz-recent-added";
const app = () =>
    express()
        .use((req: any, _res, next) => { req.user = { id: `${P}-user`, role: "user" }; next(); })
        .use("/library", tracksRouter);

const at = (minutesAgo: number) => new Date(Date.UTC(2031, 0, 1) - minutesAgo * 60_000);

async function album(artist: number, n: number, minutesAgo: number) {
    const id = `${P}-al-${artist}-${n}`;
    await prisma.album.create({
        data: { id, rgMbid: `${id}-rg`, artistId: `${P}-ar-${artist}`, identityKey: `${id}-ik`, title: id, primaryType: "Album", location: "LIBRARY", lastSynced: at(minutesAgo) },
    });
    await prisma.track.create({
        data: { id: `${id}-t`, albumId: id, title: id, trackNo: 1, duration: 100, filePath: `${id}.flac`, fileModified: new Date(), fileSize: 1 },
    });
}

beforeAll(async () => {
    for (let a = 0; a < 4; a++) {
        await prisma.artist.create({ data: { id: `${P}-ar-${a}`, name: `${P} ${a}`, normalizedName: `${P} ${a}`, identityKey: `${P}-ik-${a}` } });
    }
    // Artist 0 added 25 albums most recently; artists 1-3 one each, older, newest first.
    for (let n = 0; n < 25; n++) await album(0, n, n);
    for (let a = 1; a < 4; a++) await album(a, 0, 100 + a);
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

const names = async (query: string) =>
    ((await request(app()).get(`/library/recently-added${query}`)).body.artists as { name: string }[]).map((a) => a.name);

it("returns as many artists as asked, newest album first, past one artist's many albums", async () => {
    expect(await names("?limit=4")).toEqual([`${P} 0`, `${P} 1`, `${P} 2`, `${P} 3`]);
});

it("a bad or negative limit falls back to a sane page", async () => {
    expect(await names("?limit=-3")).toEqual([`${P} 0`]);
    expect((await names("?limit=abc")).slice(0, 4)).toEqual([`${P} 0`, `${P} 1`, `${P} 2`, `${P} 3`]);
});

it("each artist carries its library album count", async () => {
    const res = await request(app()).get("/library/recently-added?limit=2");
    expect(res.body.artists.map((a: { albumCount: number }) => a.albumCount)).toEqual([25, 1]);
});
