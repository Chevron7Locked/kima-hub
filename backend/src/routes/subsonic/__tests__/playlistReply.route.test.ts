/**
 * createPlaylist answers with the playlist exactly as getPlaylist shows it (OpenSubsonic since 1.14.0), and the similar
 * songs routes answer an id they do not know with an empty list under their own name. Real database, real routers.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { playlistRouter } from "../playlists";
import { searchRouter } from "../search";

const MARK = "zz-sub-plreply";
const USER = `${MARK}-user`;
const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/", playlistRouter, searchRouter);
const ask = (path: string, query: Record<string, string | string[]>) =>
    request(app).get(path).query({ u: USER, f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

let songIds: string[] = [];

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
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
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    for (const n of [1, 2]) {
        const t = await prisma.track.create({
            data: { title: `${MARK} song ${n}`, albumId: album.id, trackNo: n, duration: 100 * n, mime: "FLAC", filePath: `/${MARK}/${n}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        songIds.push(t.id);
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("createPlaylist answers with what getPlaylist shows", async () => {
    const created = await ask("/createPlaylist.view", { name: `${MARK} list`, songId: songIds });
    const shown = await ask("/getPlaylist.view", { id: created.playlist.id });

    expect(created.playlist).toEqual(shown.playlist);
    expect(shown.playlist).toMatchObject({ name: `${MARK} list`, songCount: 2, duration: 300, owner: USER, public: false });
    expect(shown.playlist.entry.map((e: { id: string }) => e.id)).toEqual(songIds);
});

it.each([
    ["/getSimilarSongs.view", "similarSongs"],
    ["/getSimilarSongs2.view", "similarSongs2"],
])("%s answers an unknown id with an empty %s", async (path, key) => {
    const reply = await ask(path, { id: "no-such-id" });
    expect(reply[key]).toEqual({});
});
