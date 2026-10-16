/**
 * Every change to a playlist reaches its owner's other open devices as a live `playlist:updated` event, which makes
 * their playlist list and that playlist refetch: creating, renaming, adding and removing songs, moving one, hiding,
 * unhiding and deleting. Nobody else hears it, and a request that changes nothing (or is refused) tells nobody. Real
 * database, real router and event bus; auth via JWT, as the app would; the listener subscribes the way a connected
 * device does.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../playlists";
import { prisma } from "../../utils/db";
import { eventBus, type SSEEvent } from "../../services/eventBus";

const MARK = "zz-playlist-live";

const app = express();
app.use(express.json());
app.use("/playlists", playlistsRoutes);

const tokenFor = (userId: string, username: string) =>
    jwt.sign({ userId, username, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "1h" });

let owner: { id: string; username: string };
let other: { id: string; username: string };
let trackIds: string[];
const heard: Record<string, SSEEvent[]> = {};
const unsubscribe: Array<() => void> = [];

async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    owner = await prisma.user.create({ data: { username: `${MARK}-owner`, passwordHash: "test" } });
    other = await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: "test" } });
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist`, libraryAlbumCount: 1 } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    trackIds = [];
    for (let i = 0; i < 2; i += 1) {
        const track = await prisma.track.create({
            data: { title: `${MARK} Song ${i}`, albumId: album.id, trackNo: i + 1, duration: 100, filePath: `/${MARK}/${i}.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        trackIds.push(track.id);
    }
    for (const user of [owner, other]) {
        heard[user.id] = [];
        unsubscribe.push(eventBus.subscribe(user.id, { send: (event) => (heard[user.id].push(event), true) }));
    }
});

afterAll(async () => {
    unsubscribe.forEach((stop) => stop());
    await cleanup();
});

beforeEach(() => {
    heard[owner.id].length = 0;
    heard[other.id].length = 0;
});

const asOwner = () => `Bearer ${tokenFor(owner.id, owner.username)}`;

/** The playlist ids the owner's other devices were told about. */
const announced = () => heard[owner.id].filter((e) => e.type === "playlist:updated").map((e) => e.payload.playlistId);

/** A playlist of the owner's, made directly, holding the given songs in order. */
async function playlistWith(songs: string[]): Promise<string> {
    const playlist = await prisma.playlist.create({
        data: { userId: owner.id, name: `${MARK} list`, items: { create: songs.map((trackId, i) => ({ trackId, sort: i, rank: "ab"[i] })) } },
    });
    return playlist.id;
}

describe("a playlist change reaches the owner's other devices", () => {
    it("creating", async () => {
        const res = await request(app).post("/playlists").set("Authorization", asOwner()).send({ name: `${MARK} list` });
        expect(res.status).toBe(200);
        expect(announced()).toEqual([res.body.id]);
    });

    it("renaming, by PATCH and by PUT", async () => {
        const id = await playlistWith([]);
        expect((await request(app).patch(`/playlists/${id}`).set("Authorization", asOwner()).send({ name: `${MARK} renamed` })).status).toBe(200);
        expect((await request(app).put(`/playlists/${id}`).set("Authorization", asOwner()).send({ name: `${MARK} renamed again` })).status).toBe(200);
        expect(announced()).toEqual([id, id]);
        expect(heard[owner.id].every((e) => e.payload.deleted === false)).toBe(true);
    });

    it("adding songs, one and in a batch", async () => {
        const id = await playlistWith([]);
        expect((await request(app).post(`/playlists/${id}/items`).set("Authorization", asOwner()).send({ trackId: trackIds[0] })).status).toBe(200);
        expect((await request(app).post(`/playlists/${id}/items/batch`).set("Authorization", asOwner()).send({ trackIds: [trackIds[1]] })).status).toBe(200);
        expect(announced()).toEqual([id, id]);
    });

    it("moving a song", async () => {
        const id = await playlistWith(trackIds);
        const items = await prisma.playlistItem.findMany({ where: { playlistId: id }, orderBy: { rank: "asc" } });
        const res = await request(app).patch(`/playlists/${id}/items/${items[1].id}/move`).set("Authorization", asOwner()).send({ afterItemId: null });
        expect(res.status).toBe(200);
        expect(announced()).toEqual([id]);
    });

    it("removing songs, one and several", async () => {
        const id = await playlistWith(trackIds);
        expect((await request(app).delete(`/playlists/${id}/items/${trackIds[0]}`).set("Authorization", asOwner())).status).toBe(200);
        expect((await request(app).delete(`/playlists/${id}/items`).set("Authorization", asOwner()).send({ trackIds: [trackIds[1]] })).status).toBe(200);
        expect(announced()).toEqual([id, id]);
    });

    it("removing a song still waiting to be found", async () => {
        const id = await playlistWith([]);
        const pending = await prisma.playlistPendingTrack.create({
            data: { playlistId: id, spotifyArtist: "Nobody", spotifyTitle: "Not Yet", spotifyAlbum: "Somewhere", sort: 0, rank: "a" },
        });
        expect((await request(app).delete(`/playlists/${id}/pending/${pending.id}`).set("Authorization", asOwner())).status).toBe(200);
        expect(announced()).toEqual([id]);
    });

    it("hiding and unhiding", async () => {
        const id = await playlistWith([]);
        expect((await request(app).post(`/playlists/${id}/hide`).set("Authorization", asOwner())).status).toBe(200);
        expect((await request(app).delete(`/playlists/${id}/hide`).set("Authorization", asOwner())).status).toBe(200);
        expect(announced()).toEqual([id, id]);
    });

    it("deleting, marked as deleted so no device asks for it again", async () => {
        const id = await playlistWith([]);
        expect((await request(app).delete(`/playlists/${id}`).set("Authorization", asOwner())).status).toBe(200);
        expect(announced()).toEqual([id]);
        expect(heard[owner.id][0].payload.deleted).toBe(true);
    });

    afterEach(() => {
        // Another user's devices hear none of it.
        expect(heard[other.id]).toEqual([]);
    });
});

describe("a request that changes nothing tells nobody", () => {
    it("hiding a playlist already hidden", async () => {
        const id = await playlistWith([]);
        expect((await request(app).post(`/playlists/${id}/hide`).set("Authorization", asOwner())).status).toBe(200);
        expect((await request(app).post(`/playlists/${id}/hide`).set("Authorization", asOwner())).status).toBe(200);
        expect(announced()).toEqual([id]);
    });

    it("unhiding a playlist that was not hidden", async () => {
        const id = await playlistWith([]);
        expect((await request(app).delete(`/playlists/${id}/hide`).set("Authorization", asOwner())).status).toBe(200);
        expect(announced()).toEqual([]);
    });

    it("adding songs already on the playlist, one and in a batch", async () => {
        const id = await playlistWith(trackIds);
        expect((await request(app).post(`/playlists/${id}/items`).set("Authorization", asOwner()).send({ trackId: trackIds[0] })).status).toBe(200);
        expect((await request(app).post(`/playlists/${id}/items/batch`).set("Authorization", asOwner()).send({ trackIds })).status).toBe(200);
        expect(announced()).toEqual([]);
    });

    it("a change refused to someone who does not own the playlist", async () => {
        const id = await playlistWith([]);
        const asOther = `Bearer ${tokenFor(other.id, other.username)}`;
        expect((await request(app).put(`/playlists/${id}`).set("Authorization", asOther).send({ name: `${MARK} taken` })).status).toBe(403);
        expect((await request(app).delete(`/playlists/${id}`).set("Authorization", asOther)).status).toBe(403);
        expect(announced()).toEqual([]);
        expect(heard[other.id]).toEqual([]);
    });

    it("a change to a playlist that does not exist", async () => {
        expect((await request(app).put(`/playlists/no-such-playlist`).set("Authorization", asOwner()).send({ name: `${MARK} x` })).status).toBe(404);
        expect((await request(app).delete(`/playlists/no-such-playlist`).set("Authorization", asOwner())).status).toBe(404);
        expect(announced()).toEqual([]);
    });
});
