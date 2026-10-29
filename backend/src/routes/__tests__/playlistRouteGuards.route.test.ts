/**
 * The playlists router's guards and inputs, on the real database and router with real tokens: a page number never
 * fails the list, adding in bulk checks the owner the same way on both add routes, a pending song is answered the same
 * way on every route that names one, and the bulk-remove route is gone (no client used it).
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../playlists";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const MARK = "zz-playlist-guards";
const app = express().use(express.json()).use("/playlists", playlistsRoutes);
const as = (userId: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;

let owner: string;
let other: string;
let admin: string;
let trackId: string;
let playlistId: string;
let otherPlaylistId: string;
let pendingId: string;

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    owner = (await prisma.user.create({ data: { username: `${MARK}-owner`, passwordHash: "x" } })).id;
    other = (await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: "x" } })).id;
    admin = (await prisma.user.create({ data: { username: `${MARK}-admin`, passwordHash: "x", role: "admin" } })).id;
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    trackId = (await prisma.track.create({
        data: { title: `${MARK} Song`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${MARK}/1.flac`, fileModified: new Date(), fileSize: 1 },
    })).id;
    playlistId = (await prisma.playlist.create({ data: { userId: owner, name: `${MARK} mine` } })).id;
    otherPlaylistId = (await prisma.playlist.create({ data: { userId: owner, name: `${MARK} mine too` } })).id;
    pendingId = (await prisma.playlistPendingTrack.create({
        data: { playlistId, spotifyArtist: "A", spotifyTitle: "T", spotifyAlbum: "Al", sort: 0, rank: "a0" },
    })).id;
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("GET /playlists", () => {
    it.each(["-1", "0", "abc", "99999999999", "1" + "0".repeat(25), "1e400"])("answers page %p with a list, never a server error", async (page) => {
        const res = await request(app).get(`/playlists?page=${page}`).set("Authorization", as(owner));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it("treats a page below one as the first page", async () => {
        const first = await request(app).get("/playlists?page=1").set("Authorization", as(owner));
        const below = await request(app).get("/playlists?page=-4").set("Authorization", as(owner));
        expect(below.body.map((p: { id: string }) => p.id)).toEqual(first.body.map((p: { id: string }) => p.id));
    });
});

describe("adding songs", () => {
    it.each(["items", "items/batch"])("POST /:id/%s refuses someone else's playlist and a missing one", async (path) => {
        const body = { trackIds: [trackId] };
        expect((await request(app).post(`/playlists/${playlistId}/${path}`).set("Authorization", as(other)).send(body)).status).toBe(403);
        expect((await request(app).post(`/playlists/nope/${path}`).set("Authorization", as(owner)).send(body)).status).toBe(404);
    });

    it("POST /:id/items/batch adds and lists the songs it added", async () => {
        const res = await request(app).post(`/playlists/${otherPlaylistId}/items/batch`).set("Authorization", as(owner)).send({ trackIds: [trackId, "missing"] });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ added: 1, skippedExisting: 0, skippedInvalid: 1 });
        expect(res.body.items.map((i: { trackId: string }) => i.trackId)).toEqual([trackId]);
    });

    it("POST /:id/items/batch takes at most 500", async () => {
        const res = await request(app).post(`/playlists/${playlistId}/items/batch`).set("Authorization", as(owner)).send({ trackIds: Array.from({ length: 501 }, (_, i) => `t${i}`) });
        expect(res.status).toBe(400);
    });
});

describe("a pending song", () => {
    const routes = (pl: string, pt: string) => [
        request(app).delete(`/playlists/${pl}/pending/${pt}`),
        request(app).get(`/playlists/${pl}/pending/${pt}/preview/stream`),
    ];

    it("is not found under another playlist or by another id", async () => {
        for (const req of [...routes(otherPlaylistId, pendingId), ...routes(playlistId, "nope")]) {
            expect((await req.set("Authorization", as(owner))).status).toBe(404);
        }
    });

    it("is refused to someone else", async () => {
        for (const req of routes(playlistId, pendingId)) {
            expect((await req.set("Authorization", as(other))).status).toBe(403);
        }
    });

    it("retry-all refuses someone else's playlist, and a missing one", async () => {
        // An admin passes the download gate, so the refusal is the playlist's own.
        const res = await request(app).post(`/playlists/${playlistId}/pending/retry-all`).set("Authorization", as(admin));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Access denied");
        expect((await request(app).post("/playlists/nope/pending/retry-all").set("Authorization", as(admin))).status).toBe(404);
    });
});

describe("DELETE /:id/items", () => {
    it("is gone: songs are removed one at a time", async () => {
        const res = await request(app).delete(`/playlists/${playlistId}/items`).set("Authorization", as(owner)).send({ trackIds: [trackId] });
        expect(res.status).toBe(404);
    });
});
