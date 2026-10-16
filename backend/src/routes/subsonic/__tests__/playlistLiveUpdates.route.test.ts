/**
 * A playlist made, changed or deleted through a Subsonic app reaches its owner's open Kima devices as a live
 * `playlist:updated` event, as the web app's own changes do; a delete is marked as one. A request that changes
 * nothing tells nobody, and one naming a song that does not exist answers "not found" and leaves the playlist as it
 * was. Real database, real router and event bus; the listener subscribes the way a connected device does.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { eventBus, type SSEEvent } from "../../../services/eventBus";
import { playlistRouter } from "../playlists";

const PREFIX = "subsonic-playlist-live-test";
const NOT_FOUND = 70;
let userId: string;
let songs: string[];
const heard: SSEEvent[] = [];
let stopListening: () => void;

const app = express();
app.use((req, _res, next) => {
    (req as any).user = { id: userId };
    next();
});
app.use("/rest", playlistRouter);

const announced = () => heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload);
const reply = (res: request.Response) => res.body["subsonic-response"];

async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

beforeAll(async () => {
    await cleanup();
    userId = (await prisma.user.create({ data: { username: `${PREFIX}-user`, passwordHash: "x", role: "user" } })).id;
    const artist = await prisma.artist.create({ data: { name: `${PREFIX} Artist`, identityKey: `${PREFIX}-artist` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${PREFIX}-rg`, identityKey: `${PREFIX}-album`, primaryType: "Album", title: `${PREFIX} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    songs = [];
    for (let i = 0; i < 3; i += 1) {
        const track = await prisma.track.create({
            data: { title: `${PREFIX} Song ${i}`, albumId: album.id, trackNo: i + 1, duration: 100, filePath: `/${PREFIX}/${i}.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        songs.push(track.id);
    }
    stopListening = eventBus.subscribe(userId, { send: (event) => (heard.push(event), true) });
});

afterAll(async () => {
    stopListening();
    await cleanup();
});

beforeEach(() => {
    heard.length = 0;
});

describe("Subsonic playlist changes reach the owner's devices", () => {
    let playlistId: string;

    it("creating", async () => {
        const res = await request(app).get(`/rest/createPlaylist.view?f=json&name=${PREFIX}-list`);
        expect(res.status).toBe(200);
        playlistId = reply(res).playlist.id;
        expect(announced()).toEqual([{ playlistId, deleted: false }]);
    });

    it("replacing its songs", async () => {
        const res = await request(app).get(`/rest/createPlaylist.view?f=json&playlistId=${playlistId}&songId=${songs[0]}&songId=${songs[1]}`);
        expect(reply(res).status).toBe("ok");
        expect(announced()).toEqual([{ playlistId, deleted: false }]);
    });

    it("renaming", async () => {
        const res = await request(app).get(`/rest/updatePlaylist.view?f=json&playlistId=${playlistId}&name=${PREFIX}-renamed`);
        expect(res.status).toBe(200);
        expect(announced()).toEqual([{ playlistId, deleted: false }]);
    });

    it("adding and removing songs", async () => {
        const res = await request(app).get(`/rest/updatePlaylist.view?f=json&playlistId=${playlistId}&songIdToAdd=${songs[2]}&songIndexToRemove=0`);
        expect(reply(res).status).toBe("ok");
        expect(announced()).toEqual([{ playlistId, deleted: false }]);
        const items = await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
        expect(items.map((i) => i.trackId)).toEqual([songs[1], songs[2]]);
    });

    it("an update that changes nothing tells nobody", async () => {
        const res = await request(app).get(`/rest/updatePlaylist.view?f=json&playlistId=${playlistId}&songIndexToRemove=99`);
        expect(reply(res).status).toBe("ok");
        expect(announced()).toEqual([]);
    });

    it("an update naming a song that does not exist is refused whole: the name stays, nobody is told", async () => {
        const res = await request(app).get(`/rest/updatePlaylist.view?f=json&playlistId=${playlistId}&name=${PREFIX}-half&songIdToAdd=no-such-song`);
        expect(reply(res).error.code).toBe(NOT_FOUND);
        expect((await prisma.playlist.findUnique({ where: { id: playlistId } }))?.name).toBe(`${PREFIX}-renamed`);
        expect(announced()).toEqual([]);
    });

    it("replacing songs with one that does not exist is refused: the songs stay", async () => {
        const res = await request(app).get(`/rest/createPlaylist.view?f=json&playlistId=${playlistId}&songId=no-such-song`);
        expect(reply(res).error.code).toBe(NOT_FOUND);
        expect(await prisma.playlistItem.count({ where: { playlistId } })).toBe(2);
        expect(announced()).toEqual([]);
    });

    it("creating with a song that does not exist makes no playlist", async () => {
        const res = await request(app).get(`/rest/createPlaylist.view?f=json&name=${PREFIX}-ghost&songId=${songs[0]}&songId=no-such-song`);
        expect(reply(res).error.code).toBe(NOT_FOUND);
        expect(await prisma.playlist.count({ where: { name: `${PREFIX}-ghost` } })).toBe(0);
        expect(announced()).toEqual([]);
    });

    it("replacing an empty playlist's songs with none tells nobody", async () => {
        const empty = reply(await request(app).get(`/rest/createPlaylist.view?f=json&name=${PREFIX}-empty`)).playlist.id;
        heard.length = 0;

        const res = await request(app).get(`/rest/createPlaylist.view?f=json&playlistId=${empty}`);

        expect(reply(res).status).toBe("ok");
        expect(announced()).toEqual([]);
        await prisma.playlist.delete({ where: { id: empty } });
    });

    it("replacing a playlist's songs with none, clearing it", async () => {
        const res = await request(app).get(`/rest/createPlaylist.view?f=json&playlistId=${playlistId}`);
        expect(reply(res).status).toBe("ok");
        expect(await prisma.playlistItem.count({ where: { playlistId } })).toBe(0);
        expect(announced()).toEqual([{ playlistId, deleted: false }]);
    });

    it("deleting, marked as deleted", async () => {
        const res = await request(app).get(`/rest/deletePlaylist.view?f=json&id=${playlistId}`);
        expect(res.status).toBe(200);
        expect(announced()).toEqual([{ playlistId, deleted: true }]);
    });
});
