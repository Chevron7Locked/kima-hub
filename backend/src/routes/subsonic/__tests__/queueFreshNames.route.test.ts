/**
 * A saved queue entry carries the song's title, artist and album as they were when it was saved; what a client is shown
 * is how they are now, so an edit of a title, an artist's display name or an album's cover reaches a queue saved before
 * it. The stored queue is left as saved. Real routers and database; only Subsonic auth is injected.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { queueRouter } from "../queue";

const P = "zz-qfn";
const USER = `${P}-user`;
const COVER_VERSION = "c3c3c3c3c3";

const app = express();
app.use((req: any, _res, next) => {
    req.user = { id: USER, username: USER, role: "user" };
    next();
});
app.use("/", queueRouter);

const get = async (path: string) => {
    const res = await request(app).get(path).query({ f: "json" });
    expect(res.status).toBe(200);
    return res.body["subsonic-response"];
};

async function cleanup() {
    await prisma.playbackState.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

const stale = (id: string) => ({
    id,
    title: "Old Title",
    displayTitle: null,
    duration: 100,
    artist: { id: `${P}-ar`, name: "Old Artist" },
    album: { id: `${P}-al`, title: "Old Album", coverArt: null },
});

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: "Old Artist", identityKey: `${P}-ar` } });
    await prisma.album.create({ data: { id: `${P}-al`, artistId: `${P}-ar`, rgMbid: `${P}-rg`, primaryType: "Album", title: "Old Album", location: "LIBRARY" } });
    for (const [name, missing] of [["a", false], ["b", false], ["gone", true]] as const) {
        await prisma.track.create({
            data: {
                id: `${P}-${name}`, albumId: `${P}-al`, title: "Old Title", trackNo: 1, duration: 100, filePath: `/tmp/${P}-${name}.flac`,
                fileModified: new Date(), fileSize: 1, missingSince: missing ? new Date() : null,
            },
        });
    }
    await prisma.playbackState.create({
        data: {
            userId: USER, playbackType: "track", trackId: `${P}-a`, currentIndex: 0,
            queue: [stale(`${P}-a`), stale(`${P}-gone`), stale(`${P}-b`)],
        },
    });
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("a saved queue after the songs were edited", () => {
    beforeEach(async () => {
        await prisma.track.update({ where: { id: `${P}-a` }, data: { title: "File Title", displayTitle: "Edited Title" } });
        await prisma.track.update({ where: { id: `${P}-b` }, data: { title: "Other File Title" } });
        await prisma.artist.update({ where: { id: `${P}-ar` }, data: { displayName: "Edited Artist" } });
        await prisma.album.update({
            where: { id: `${P}-al` },
            data: { title: "Edited Album", coverUrl: `native:albums/${P}-al.jpg?v=${COVER_VERSION}` },
        });
    });

    const shown = [
        { "@_id": `${P}-a`, "@_title": "Edited Title" },
        { "@_id": `${P}-b`, "@_title": "Other File Title" },
    ];

    it.each([
        ["getPlayQueue", "/getPlayQueue.view", "playQueue"],
        ["getPlayQueueByIndex", "/getPlayQueueByIndex.view", "playQueueByIndex"],
    ])("%s names each song, artist and album as they are now, and leaves out the song that is gone", async (_name, path, key) => {
        const entries = (await get(path))[key].entry as Array<Record<string, unknown>>;
        expect(entries.map((e) => [e.id, e.title])).toEqual(shown.map((s) => [s["@_id"], s["@_title"]]));
        for (const e of entries) {
            expect(e).toMatchObject({ artist: "Edited Artist", album: "Edited Album", coverArt: `${P}-al_${COVER_VERSION}` });
        }
    });

    it("leaves what is stored as it was saved", async () => {
        await get("/getPlayQueue.view");
        const stored = (await prisma.playbackState.findUniqueOrThrow({ where: { userId: USER } })).queue as Array<{ id: string; title: string }>;
        expect(stored.map((e) => [e.id, e.title])).toEqual([`${P}-a`, `${P}-gone`, `${P}-b`].map((id) => [id, "Old Title"]));
    });
});
