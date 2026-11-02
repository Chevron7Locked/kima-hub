// Recently added lists artists by their newest library album, as many as asked for, however many albums the newest
// artist added. Real database; the router is mounted with a user on the request as the app's auth would put it.

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import tracksRouter from "../tracks";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { artistIdentityKey } from "../../../services/artistIdentity";
import { UNKNOWN_ARTIST, VARIOUS_ARTISTS_CANONICAL } from "../../../utils/artistNormalization";

const P = "zz-recent-added";
const app = () =>
    express()
        .use((req: any, _res, next) => { req.user = { id: `${P}-user`, role: "user" }; next(); })
        .use("/library", tracksRouter);

const at = (minutesAgo: number) => new Date(Date.UTC(2031, 0, 1) - minutesAgo * 60_000);

async function album(artist: number | string, n: number, minutesAgo: number) {
    const id = `${P}-al-${artist}-${n}`;
    const artistId = typeof artist === "number" ? `${P}-ar-${artist}` : artist;
    await prisma.album.create({
        data: { id, rgMbid: `${id}-rg`, artistId, identityKey: `${id}-ik`, title: id, primaryType: "Album", location: "LIBRARY", lastSynced: at(minutesAgo) },
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

/** The placeholder rows (Various Artists, Unknown Artist): the database's own if it has them, else made here. */
const placeholders: { id: string; made: boolean }[] = [];
async function placeholder(name: string) {
    const identityKey = artistIdentityKey(name);
    const found = await prisma.artist.findUnique({ where: { identityKey }, select: { id: true } });
    const id = found?.id ?? `${P}-ph-${placeholders.length}`;
    if (!found) await prisma.artist.create({ data: { id, name, normalizedName: name.toLowerCase(), identityKey } });
    placeholders.push({ id, made: !found });
    return id;
}

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { in: placeholders.filter((p) => p.made).map((p) => p.id) } } });
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

it("leaves out Various Artists and Unknown Artist, which name no one", async () => {
    // Compilations and untagged albums added after everything else: newest, yet not shown.
    await album(await placeholder(VARIOUS_ARTISTS_CANONICAL), 0, -10);
    await album(await placeholder(UNKNOWN_ARTIST), 0, -20);
    expect(await names("?limit=4")).toEqual([`${P} 0`, `${P} 1`, `${P} 2`, `${P} 3`]);
});
