/**
 * A playlist can hold the same song more than once, each copy its own item. Reading lists every copy in rank order,
 * removing by item id takes out one copy while removing by song id (what the iOS app sends) takes out all of them,
 * moving works on one copy, and a public share shows each copy. Adding a song the playlist already holds is still
 * skipped and reported as a duplicate. Real router and database, auth via JWT.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistRoutes from "../playlists";
import { prisma } from "../../utils/db";
import { loadPublicPlaylist } from "../../services/publicShare";
import { markUnavailable } from "../../services/playlistService";
import type { SSEEvent } from "../../services/eventBus";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { cleanupMarked, listenTo, playlistAnnouncements, seedSongs } from "./helpers/liveEvents";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-playlist-repeats";
const app = mountAsServer(express().use(express.json()), "/playlists", playlistRoutes, "/api/playlists");
const as = (userId: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;

let owner: string;
let songs: string[];
let heard: SSEEvent[];
let stop: () => void;

/** A playlist holding the given songs in order, a song listed twice held twice. */
async function playlistWith(name: string, order: string[]): Promise<string> {
    const playlist = await prisma.playlist.create({
        data: { userId: owner, name: `${MARK} ${name}`, items: { create: order.map((trackId, i) => ({ trackId, sort: i, rank: String.fromCharCode(97 + i) })) } },
    });
    return playlist.id;
}
const itemsOf = (playlistId: string) => prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
const held = async (playlistId: string) => (await itemsOf(playlistId)).map((i) => i.trackId);

beforeAll(async () => {
    await cleanupMarked(MARK);
    owner = (await prisma.user.create({ data: { username: `${MARK}-owner`, passwordHash: "x" } })).id;
    songs = await seedSongs(MARK, 3, { libraryAlbumCount: 1 });
    ({ heard, stop } = listenTo(owner));
});

afterAll(async () => {
    stop();
    await cleanupMarked(MARK);
    await closeEngineConnections();
});

beforeEach(() => {
    heard.length = 0;
});

describe("reading a playlist with a repeated song", () => {
    it("lists every copy as its own item, in rank order, and counts them", async () => {
        const [a, b] = songs;
        const id = await playlistWith("read", [a, b, a]);
        const res = await request(app).get(`/playlists/${id}`).set("Authorization", as(owner));
        expect(res.status).toBe(200);
        expect(res.body.items.map((i: { track: { id: string } }) => i.track.id)).toEqual([a, b, a]);
        expect(new Set(res.body.items.map((i: { id: string }) => i.id)).size).toBe(3);
        expect(res.body.trackCount).toBe(3);
        expect(res.body.mergedItems).toHaveLength(3);
    });

    it("lists the playlist with its count of items", async () => {
        const [a] = songs;
        const id = await playlistWith("count", [a, a]);
        const res = await request(app).get("/playlists").set("Authorization", as(owner));
        const listed = res.body.find((p: { id: string }) => p.id === id);
        expect(listed.trackCount).toBe(2);
    });

    it("marks every copy of a song that is no longer playable", async () => {
        const [a, b] = songs;
        const id = await playlistWith("gone", [a, b, a]);
        await prisma.track.update({ where: { id: a }, data: { missingSince: new Date() } });
        try {
            const marked = await markUnavailable(await itemsOf(id));
            expect(marked.map((i) => i.unavailable)).toEqual([true, false, true]);
        } finally {
            await prisma.track.update({ where: { id: a }, data: { missingSince: null } });
        }
    });

    it("shows every copy on a public share", async () => {
        const [a, b] = songs;
        const id = await playlistWith("shared", [a, b, a]);
        const shown = await loadPublicPlaylist(id);
        expect(shown!.items).toHaveLength(3);
        expect(new Set(shown!.items.map((i) => i.id)).size).toBe(3);
    });
});

describe("removing one copy of a repeated song", () => {
    it("by item id takes out that copy only, and tells the owner's devices", async () => {
        const [a, b] = songs;
        const id = await playlistWith("remove-item", [a, b, a]);
        const [first] = await itemsOf(id);
        const res = await request(app).delete(`/playlists/${id}/items/${first.id}`).set("Authorization", as(owner));
        expect(res.status).toBe(200);
        expect(res.body.removed).toBe(1);
        expect(await held(id)).toEqual([b, a]);
        expect(playlistAnnouncements(heard).map((p) => p.playlistId)).toEqual([id]);
    });

    it("by song id, as the iOS app sends it, takes out every copy", async () => {
        const [a, b] = songs;
        const id = await playlistWith("remove-song", [a, b, a]);
        const res = await request(app).delete(`/playlists/${id}/items/${a}`).set("Authorization", as(owner));
        expect(res.status).toBe(200);
        expect(res.body.removed).toBe(2);
        expect(await held(id)).toEqual([b]);
    });

    it("answers 404 for an id that names neither an item nor a song in the playlist", async () => {
        const [a, b] = songs;
        const id = await playlistWith("remove-none", [a]);
        const res = await request(app).delete(`/playlists/${id}/items/${b}`).set("Authorization", as(owner));
        expect(res.status).toBe(404);
        expect(await held(id)).toEqual([a]);
    });

    it("does not take out an item of another playlist", async () => {
        const [a, b] = songs;
        const mine = await playlistWith("remove-mine", [a]);
        const theirs = await playlistWith("remove-theirs", [b, a]);
        const [theirItem] = await itemsOf(theirs);
        const res = await request(app).delete(`/playlists/${mine}/items/${theirItem.id}`).set("Authorization", as(owner));
        expect(res.status).toBe(404);
        expect(await held(theirs)).toEqual([b, a]);
        expect(await held(mine)).toEqual([a]);
    });
});

describe("moving one copy of a repeated song", () => {
    it("moves only the copy named by its item id", async () => {
        const [a, b] = songs;
        const id = await playlistWith("move", [a, b, a]);
        const [, , last] = await itemsOf(id);
        const res = await request(app)
            .patch(`/playlists/${id}/items/${last.id}/move`)
            .set("Authorization", as(owner))
            .send({ afterItemId: null });
        expect(res.status).toBe(200);
        expect(await held(id)).toEqual([a, a, b]);
        expect((await itemsOf(id))[0].id).toBe(last.id);
    });
});

describe("adding a song again on purpose (allowRepeats)", () => {
    const add = (id: string, body: object) =>
        request(app).post(`/playlists/${id}/items`).set("Authorization", as(owner)).send(body);

    it("adds a second copy of one song at the end, and says nothing was skipped", async () => {
        const [a, b] = songs;
        const id = await playlistWith("again-one", [a, b]);
        const res = await add(id, { trackId: a, allowRepeats: true });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ added: 1, duplicated: false, duplicates: 0 });
        expect(await held(id)).toEqual([a, b, a]);
        expect(playlistAnnouncements(heard)).not.toHaveLength(0);
    });

    it("adds every song asked for, the ones already there and the new ones, in the order sent", async () => {
        const [a, b, c] = songs;
        const id = await playlistWith("again-many", [a, b]);
        const res = await add(id, { trackIds: [c, a], allowRepeats: true });
        expect(res.body).toMatchObject({ added: 2, duplicates: 0 });
        expect(await held(id)).toEqual([a, b, c, a]);
    });

    it("still skips by default, and allowRepeats: false is the default", async () => {
        const [a, b] = songs;
        const id = await playlistWith("again-off", [a, b]);
        expect((await add(id, { trackId: a })).body).toMatchObject({ added: 0, duplicated: true, duplicates: 1 });
        expect((await add(id, { trackId: a, allowRepeats: false })).body).toMatchObject({ added: 0, duplicates: 1 });
        expect(await held(id)).toEqual([a, b]);
    });

    it("still turns away a song that is not playable", async () => {
        const [a, b] = songs;
        const id = await playlistWith("again-gone", [a, b]);
        await prisma.track.update({ where: { id: a }, data: { missingSince: new Date() } });
        try {
            const res = await add(id, { trackIds: [a, b], allowRepeats: true });
            expect(res.body).toMatchObject({ added: 1, rejected: [a] });
            expect(await held(id)).toEqual([a, b, b]);
        } finally {
            await prisma.track.update({ where: { id: a }, data: { missingSince: null } });
        }
    });

    it("refuses an allowRepeats that is not true or false", async () => {
        const [a] = songs;
        const id = await playlistWith("again-bad", [a]);
        const res = await add(id, { trackId: a, allowRepeats: "yes" });
        expect(res.status).toBe(400);
        expect(await held(id)).toEqual([a]);
    });
});

describe("adding a song the playlist already holds", () => {
    it("is skipped and reported as a duplicate, as before", async () => {
        const [a, b] = songs;
        const id = await playlistWith("add", [a, b]);
        const res = await request(app).post(`/playlists/${id}/items`).set("Authorization", as(owner)).send({ trackId: a });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ added: 0, duplicated: true, duplicates: 1 });
        expect(await held(id)).toEqual([a, b]);
    });

    it("leaves a repeat already in the playlist alone when more songs are added", async () => {
        const [a, b, c] = songs;
        const id = await playlistWith("add-more", [a, b, a]);
        const res = await request(app).post(`/playlists/${id}/items/batch`).set("Authorization", as(owner)).send({ trackIds: [a, c] });
        expect(res.status).toBe(200);
        expect(await held(id)).toEqual([a, b, a, c]);
    });
});
