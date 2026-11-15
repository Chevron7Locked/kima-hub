/**
 * A Subsonic playlist keeps a song named more than once, each as its own entry in the order given. createPlaylist
 * (new and replacing), updatePlaylist (adding a song already there, removing by position) and the counts and durations
 * in getPlaylist and getPlaylists all work by entry. Real database, real router.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { playlistRouter } from "../playlists";

const MARK = "zz-sub-plrepeats";
const USER = `${MARK}-user`;
const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/", playlistRouter);
const ask = (path: string, query: Record<string, string | string[]>) =>
    request(app).get(path).query({ u: USER, f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

let songs: string[];

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

const entriesOf = async (playlistId: string) =>
    (await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } })).map((i) => i.trackId);
const idsOf = (reply: { playlist: { entry: Array<{ id: string }> } }) => reply.playlist.entry.map((e) => e.id);

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
            data: { title: `${MARK} song ${n}`, albumId: album.id, trackNo: n, duration: 100 * n, mime: "FLAC", filePath: `/${MARK}/${n}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        songs.push(t.id);
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("createPlaylist", () => {
    it("keeps a song named twice, in the order given", async () => {
        const [a, b] = songs;
        const created = await ask("/createPlaylist.view", { name: `${MARK} new`, songId: [a, b, a] });
        expect(idsOf(created)).toEqual([a, b, a]);
        expect(created.playlist.songCount).toBe(3);
        expect(await entriesOf(created.playlist.id)).toEqual([a, b, a]);
    });

    it("keeps a song named twice when it replaces a playlist's songs", async () => {
        const [a, b, c] = songs;
        const made = await ask("/createPlaylist.view", { name: `${MARK} replace`, songId: [c] });
        const replaced = await ask("/createPlaylist.view", { playlistId: made.playlist.id, songId: [b, a, b] });
        expect(idsOf(replaced)).toEqual([b, a, b]);
        expect(await entriesOf(made.playlist.id)).toEqual([b, a, b]);
    });
});

describe("updatePlaylist", () => {
    it("adds a song the playlist already holds as another entry", async () => {
        const [a, b] = songs;
        const made = await ask("/createPlaylist.view", { name: `${MARK} add`, songId: [a, b] });
        await ask("/updatePlaylist.view", { playlistId: made.playlist.id, songIdToAdd: [a, a] });
        expect(await entriesOf(made.playlist.id)).toEqual([a, b, a, a]);
    });

    it("removes the entry at the position given and leaves its repeat", async () => {
        const [a, b] = songs;
        const made = await ask("/createPlaylist.view", { name: `${MARK} remove`, songId: [a, b, a] });
        await ask("/updatePlaylist.view", { playlistId: made.playlist.id, songIndexToRemove: "0" });
        expect(await entriesOf(made.playlist.id)).toEqual([b, a]);
        await ask("/updatePlaylist.view", { playlistId: made.playlist.id, songIndexToRemove: "1" });
        expect(await entriesOf(made.playlist.id)).toEqual([b]);
    });
});

describe("counts and durations", () => {
    it("count every entry, in getPlaylist and in getPlaylists", async () => {
        const [a, b] = songs;
        const made = await ask("/createPlaylist.view", { name: `${MARK} counts`, songId: [a, b, a] });
        const shown = await ask("/getPlaylist.view", { id: made.playlist.id });
        expect(shown.playlist).toMatchObject({ songCount: 3, duration: 400 });
        expect(idsOf(shown)).toEqual([a, b, a]);
        const listed = await ask("/getPlaylists.view", {});
        const mine = listed.playlists.playlist.find((p: { id: string }) => p.id === made.playlist.id);
        expect(mine).toMatchObject({ songCount: 3, duration: 400 });
    });
});
