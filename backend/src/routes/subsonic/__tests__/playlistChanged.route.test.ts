/**
 * A Subsonic client that reads a playlist's `changed` time to decide whether to fetch it again must see every write to
 * the playlist's songs: replacing all of them, adding, removing. The playlist row's `updatedAt` moves in the same
 * transaction as the item writes, as the web playlist writes do. A call that writes nothing leaves it alone.
 * Real database, real router.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { rankForPosition } from "../../../utils/lexoRank";
import { playlistRouter } from "../playlists";

const MARK = "zz-sub-plchanged";
const USER = `${MARK}-user`;
const LONG_AGO = new Date("2020-01-01T00:00:00Z");
const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/", playlistRouter);
const call = (view: string, query: Record<string, unknown>) =>
    request(app).get(`/${view}.view`).query({ u: USER, f: "json", ...query }).expect(200);

let songs: string[];

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

/** A playlist holding `count` songs whose last change was long ago. */
async function oldPlaylist(count: number) {
    const playlist = await prisma.playlist.create({ data: { userId: USER, name: `${MARK} list`, updatedAt: LONG_AGO } });
    for (let i = 0; i < count; i += 1) {
        await prisma.playlistItem.create({ data: { playlistId: playlist.id, trackId: songs[i], sort: i, rank: rankForPosition(i) } });
    }
    await prisma.playlist.update({ where: { id: playlist.id }, data: { updatedAt: LONG_AGO } });
    return playlist.id;
}
const changedAt = async (id: string) => (await prisma.playlist.findUniqueOrThrow({ where: { id } })).updatedAt.getTime();

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist`, libraryAlbumCount: 1 } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    songs = [];
    for (const n of [1, 2, 3]) {
        const t = await prisma.track.create({
            data: { title: `${MARK} song ${n}`, albumId: album.id, trackNo: n, duration: 100, mime: "FLAC", filePath: `/${MARK}/${n}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        songs.push(t.id);
    }
});

afterEach(async () => {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("a playlist's changed time moves with every write to its songs", () => {
    it("when a replace gives different songs", async () => {
        const id = await oldPlaylist(2);
        await call("createPlaylist", { playlistId: id, songId: [songs[2]] });
        expect(await changedAt(id)).toBeGreaterThan(LONG_AGO.getTime());
    });

    it("when a replace gives the same songs, since every entry is rewritten", async () => {
        const id = await oldPlaylist(2);
        await call("createPlaylist", { playlistId: id, songId: [songs[0], songs[1]] });
        expect(await changedAt(id)).toBeGreaterThan(LONG_AGO.getTime());
    });

    it("when a replace empties the playlist", async () => {
        const id = await oldPlaylist(2);
        await call("createPlaylist", { playlistId: id });
        expect(await changedAt(id)).toBeGreaterThan(LONG_AGO.getTime());
    });

    it("when a song is added", async () => {
        const id = await oldPlaylist(1);
        await call("updatePlaylist", { playlistId: id, songIdToAdd: [songs[2]] });
        expect(await changedAt(id)).toBeGreaterThan(LONG_AGO.getTime());
    });

    it("when a song is removed", async () => {
        const id = await oldPlaylist(2);
        await call("updatePlaylist", { playlistId: id, songIndexToRemove: [0] });
        expect(await changedAt(id)).toBeGreaterThan(LONG_AGO.getTime());
    });

    it("when only the name changes", async () => {
        const id = await oldPlaylist(1);
        await call("updatePlaylist", { playlistId: id, name: `${MARK} renamed` });
        expect(await changedAt(id)).toBeGreaterThan(LONG_AGO.getTime());
    });
});

describe("a call that writes nothing", () => {
    it("leaves the changed time alone when a replace of an empty playlist gives no songs", async () => {
        const id = await oldPlaylist(0);
        await call("createPlaylist", { playlistId: id });
        expect(await changedAt(id)).toBe(LONG_AGO.getTime());
    });

    it("leaves it alone when the index to remove is past the end", async () => {
        const id = await oldPlaylist(1);
        await call("updatePlaylist", { playlistId: id, songIndexToRemove: [5] });
        expect(await changedAt(id)).toBe(LONG_AGO.getTime());
    });
});
