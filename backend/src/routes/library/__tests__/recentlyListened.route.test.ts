// Recently listened shows the artists of the listener's newest plays, leaving out Various Artists and Unknown Artist,
// which name no one. Real database; the router is mounted with a user on the request as the app's auth would put it.

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import tracksRouter from "../tracks";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { artistIdentityKey } from "../../../services/artistIdentity";
import { UNKNOWN_ARTIST, VARIOUS_ARTISTS_CANONICAL } from "../../../utils/artistNormalization";
import { mountAsServer } from "../../__tests__/helpers/serverMount";

const P = "zz-recent-listened";
const USER = `${P}-user`;
const app = () =>
    mountAsServer(
        express().use((req: any, _res, next) => { req.user = { id: USER, role: "user" }; next(); }),
        "/library",
        tracksRouter,
        "/api/library",
        { standIn: true },
    );

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

describe("the page is full", () => {
    const BUSY = `${P}-busy`;
    const asBusy = () =>
        express()
            .use((req: any, _res, next) => { req.user = { id: BUSY, role: "user" }; next(); })
            .use("/library", tracksRouter);
    // w has one old play from before the app recorded whether a song was heard (heard = false): it is still a listen.
    const FIRST = ["x", "y", "z", "w"];

    beforeAll(async () => {
        await prisma.user.create({ data: { id: BUSY, username: BUSY, passwordHash: "x" } });
        // x was played twenty times in the last hour; y and z once each, long before.
        for (const [i, key] of FIRST.entries()) {
            const artistId = `${P}-ar-${key}`;
            await prisma.artist.create({ data: { id: artistId, name: `${P} ${key}`, normalizedName: `${P} ${key}`, identityKey: `${P}-ik-${key}` } });
            made.push(artistId);
            const albumId = `${P}-al-${key}`;
            await prisma.album.create({
                data: { id: albumId, rgMbid: `${albumId}-rg`, artistId, identityKey: `${albumId}-ik`, title: albumId, primaryType: "Album", location: "LIBRARY", lastSynced: at(0) },
            });
            await prisma.track.create({
                data: { id: `${albumId}-t`, albumId, title: albumId, trackNo: 1, duration: 100, filePath: `${albumId}.flac`, fileModified: new Date(), fileSize: 1 },
            });
            const plays = key === "x" ? 20 : 1;
            await prisma.play.createMany({
                data: Array.from({ length: plays }, (_, j) => ({
                    id: `${albumId}-p${j}`, userId: BUSY, trackId: `${albumId}-t`, source: "LIBRARY" as const, heard: key !== "w",
                    // x's plays are 3 minutes apart, so each is a listen of its own (the song is 100 s long).
                    playedAt: key === "x" ? at(10 + j * 3) : at(1000 + i * 100),
                })),
            });
        }
        // A Discover song played most recently of all is no artist card.
        const artistId = `${P}-ar-d`;
        await prisma.artist.create({ data: { id: artistId, name: `${P} d`, normalizedName: `${P} d`, identityKey: `${P}-ik-d` } });
        made.push(artistId);
        await prisma.album.create({
            data: { id: `${P}-al-d`, rgMbid: `${P}-al-d-rg`, artistId, identityKey: `${P}-al-d-ik`, title: `${P}-al-d`, primaryType: "Album", location: "DISCOVER", lastSynced: at(0) },
        });
        await prisma.track.create({
            data: { id: `${P}-al-d-t`, albumId: `${P}-al-d`, title: "d", trackNo: 1, duration: 100, filePath: `${P}-al-d.flac`, fileModified: new Date(), fileSize: 1 },
        });
        await prisma.play.create({ data: { id: `${P}-al-d-p`, userId: BUSY, trackId: `${P}-al-d-t`, playedAt: at(1), source: "LIBRARY" } });
    });

    afterAll(async () => {
        await prisma.play.deleteMany({ where: { userId: BUSY } });
        await prisma.user.deleteMany({ where: { id: BUSY } });
    });

    const artistsAsked = async (limit: number) => {
        const res = await request(asBusy()).get(`/library/recently-listened?limit=${limit}`);
        expect(res.status).toBe(200);
        return (res.body.items as { type: string; name?: string }[]).filter((i) => i.type === "artist").map((i) => i.name);
    };

    it("holds as many artists as asked for when that many were listened to, however often one was", async () => {
        // The newest nine plays are all the busy artist's.
        expect(await artistsAsked(3)).toEqual([`${P} x`, `${P} y`, `${P} z`]);
    });

    it("counts a play that predates the heard flag as a listen", async () => {
        expect(await artistsAsked(4)).toEqual([`${P} x`, `${P} y`, `${P} z`, `${P} w`]);
    });

    it("keeps the most recent listen first and stops at the limit", async () => {
        expect(await artistsAsked(2)).toEqual([`${P} x`, `${P} y`]);
    });

    it("gives no card for a song that lives in Discover", async () => {
        expect(await artistsAsked(10)).not.toContain(`${P} d`);
    });
});
