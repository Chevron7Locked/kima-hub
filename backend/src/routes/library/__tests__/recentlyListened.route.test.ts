// Recently listened shows the artists of the listener's newest plays, leaving out Various Artists and Unknown Artist,
// which name no one. Real database; the router is mounted with a user on the request as the app's auth would put it.

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import tracksRouter from "../tracks";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { artistIdentityKey } from "../../../services/artistIdentity";
import { UNKNOWN_ARTIST, VARIOUS_ARTISTS_CANONICAL } from "../../../utils/artistNormalization";

const P = "zz-recent-listened";
const USER = `${P}-user`;
const app = () =>
    express()
        .use((req: any, _res, next) => { req.user = { id: USER, role: "user" }; next(); })
        .use("/library", tracksRouter);

const at = (minutesAgo: number) => new Date(Date.UTC(2031, 0, 1) - minutesAgo * 60_000);

/** The placeholder rows: the database's own if it has them, else made here (and removed after). */
const made: string[] = [];
async function artistRow(name: string, id: string) {
    const identityKey = artistIdentityKey(name);
    const found = await prisma.artist.findUnique({ where: { identityKey }, select: { id: true } });
    if (found) return found.id;
    await prisma.artist.create({ data: { id, name, normalizedName: name.toLowerCase(), identityKey } });
    made.push(id);
    return id;
}

async function playedAlbum(artistId: string, key: string, minutesAgo: number) {
    const id = `${P}-al-${key}`;
    await prisma.album.create({
        data: { id, rgMbid: `${id}-rg`, artistId, identityKey: `${id}-ik`, title: id, primaryType: "Album", location: "LIBRARY", lastSynced: at(0) },
    });
    await prisma.track.create({
        data: { id: `${id}-t`, albumId: id, title: id, trackNo: 1, duration: 100, filePath: `${id}.flac`, fileModified: new Date(), fileSize: 1 },
    });
    await prisma.play.create({ data: { id: `${id}-p`, userId: USER, trackId: `${id}-t`, playedAt: at(minutesAgo), source: "LIBRARY" } });
}

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    const real = await artistRow(`${P} Real`, `${P}-ar-real`);
    // The compilation and the untagged album were played after the real artist's album.
    await playedAlbum(real, "real", 30);
    await playedAlbum(await artistRow(VARIOUS_ARTISTS_CANONICAL, `${P}-ar-va`), "va", 10);
    await playedAlbum(await artistRow(UNKNOWN_ARTIST, `${P}-ar-unknown`), "unknown", 20);
});

afterAll(async () => {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { in: made } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("leaves out Various Artists and Unknown Artist, which name no one", async () => {
    const res = await request(app()).get("/library/recently-listened?limit=10");
    expect(res.status).toBe(200);
    const names = (res.body.items as { type: string; name?: string }[]).filter((i) => i.type === "artist").map((i) => i.name);
    expect(names).toEqual([`${P} Real`]);
});
