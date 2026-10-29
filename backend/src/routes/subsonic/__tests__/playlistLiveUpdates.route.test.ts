/**
 * A playlist made, changed or deleted through a Subsonic app reaches its owner's open Kima devices as a live
 * `playlist:updated` event, as the web app's own changes do; a delete is marked as one. A request that changes
 * nothing tells nobody, and one naming a song that does not exist answers "not found" and leaves the playlist as it
 * was. Real database, real router and event bus; the listener subscribes the way a connected device does.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import type { SSEEvent } from "../../../services/eventBus";
import { cleanupMarked, listenTo, playlistAnnouncements, seedSongs } from "../../__tests__/helpers/liveEvents";
import { playlistRouter } from "../playlists";

const PREFIX = "subsonic-playlist-live-test";
const NOT_FOUND = 70;
let userId: string;
let songs: string[];
let heard: SSEEvent[];
let stopListening: () => void;

const app = express();
app.use((req, _res, next) => {
    (req as any).user = { id: userId };
    next();
});
app.use("/rest", playlistRouter);

const announced = () => playlistAnnouncements(heard);
const reply = (res: request.Response) => res.body["subsonic-response"];

beforeAll(async () => {
    await cleanupMarked(PREFIX);
    userId = (await prisma.user.create({ data: { username: `${PREFIX}-user`, passwordHash: "x", role: "user" } })).id;
    songs = await seedSongs(PREFIX, 3);
    const listener = listenTo(userId);
    heard = listener.heard;
    stopListening = listener.stop;
});

afterAll(async () => {
    stopListening();
    await cleanupMarked(PREFIX);
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
