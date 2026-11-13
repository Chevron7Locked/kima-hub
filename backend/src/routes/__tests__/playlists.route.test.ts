/**
 * Playlist reads and mutations check ownership: a non-owner gets 403 and the playlist is left as it was.
 * Real router and database, real tokens.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../../routes/playlists";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-playlists-route";
const app = mountAsServer(express().use(express.json()), "/playlists", playlistsRoutes, "/api/playlists");
const as = (userId: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "24h" })}`;

let userA: string;
let userB: string;
let privateId: string;
let publicId: string;
let bPrivateId: string;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
}

const nameOf = async (id: string) => (await prisma.playlist.findUnique({ where: { id } }))?.name;

beforeAll(async () => {
    await cleanup();
    userA = (await prisma.user.create({ data: { username: `${MARK}-a`, passwordHash: "x" } })).id;
    userB = (await prisma.user.create({ data: { username: `${MARK}-b`, passwordHash: "x" } })).id;
    privateId = (await prisma.playlist.create({ data: { userId: userA, name: `${MARK} A private` } })).id;
    publicId = (await prisma.playlist.create({ data: { userId: userA, name: `${MARK} A public`, isPublic: true } })).id;
    bPrivateId = (await prisma.playlist.create({ data: { userId: userB, name: `${MARK} B private` } })).id;
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("authentication enforcement", () => {
    it("returns 401 on all playlist routes without a token", async () => {
        const endpoints = [
            () => request(app).get("/playlists"),
            () => request(app).get(`/playlists/${privateId}`),
            () => request(app).post("/playlists").send({ name: "test" }),
            () => request(app).put(`/playlists/${privateId}`).send({ name: "x" }),
            () => request(app).delete(`/playlists/${privateId}`),
        ];

        for (const req of endpoints) {
            expect((await req()).status).toBe(401);
        }
        expect(await nameOf(privateId)).toBe(`${MARK} A private`);
    });
});

describe("GET /playlists/:id access control", () => {
    it("returns 403, not 404, when User B requests User A's private playlist", async () => {
        // 404 would hide that the playlist exists and mask the access check.
        const res = await request(app).get(`/playlists/${privateId}`).set("Authorization", as(userB));

        expect(res.status).toBe(403);
        expect(res.body.error).toBeDefined();
    });

    it("returns 200 when User A requests their own private playlist", async () => {
        const res = await request(app).get(`/playlists/${privateId}`).set("Authorization", as(userA));

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(privateId);
        expect(res.body.isOwner).toBe(true);
    });

    it("returns 200 when any user requests a public playlist", async () => {
        const res = await request(app).get(`/playlists/${publicId}`).set("Authorization", as(userB));

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(publicId);
        expect(res.body.isOwner).toBe(false);
    });
});

describe("PUT /playlists/:id ownership enforcement", () => {
    it("returns 403 and leaves the playlist alone when User B updates User A's playlist", async () => {
        const res = await request(app).put(`/playlists/${privateId}`).set("Authorization", as(userB)).send({ name: "Hijacked" });

        expect(res.status).toBe(403);
        expect(await nameOf(privateId)).toBe(`${MARK} A private`);
    });

    it("allows User A to update their own playlist", async () => {
        const res = await request(app).put(`/playlists/${privateId}`).set("Authorization", as(userA)).send({ name: `${MARK} A renamed` });

        expect(res.status).toBe(200);
        expect(res.body.name).toBe(`${MARK} A renamed`);
        expect(await nameOf(privateId)).toBe(`${MARK} A renamed`);
    });
});

describe("DELETE /playlists/:id ownership enforcement", () => {
    it("returns 403 and keeps the playlist when User B deletes User A's playlist", async () => {
        const res = await request(app).delete(`/playlists/${publicId}`).set("Authorization", as(userB));

        expect(res.status).toBe(403);
        expect(await prisma.playlist.findUnique({ where: { id: publicId } })).not.toBeNull();
    });

    it("allows User A to delete their own playlist", async () => {
        const id = (await prisma.playlist.create({ data: { userId: userA, name: `${MARK} A doomed` } })).id;

        const res = await request(app).delete(`/playlists/${id}`).set("Authorization", as(userA));

        expect(res.status).toBe(200);
        expect(await prisma.playlist.findUnique({ where: { id } })).toBeNull();
    });
});

describe("GET /playlists data isolation", () => {
    it("lists the caller's own and public playlists, never another user's private one", async () => {
        const res = await request(app).get("/playlists?limit=100").set("Authorization", as(userB));

        expect(res.status).toBe(200);
        const mine = (res.body as { id: string; isOwner: boolean }[]).filter((p) => [privateId, publicId, bPrivateId].includes(p.id));
        expect(mine.map((p) => p.id).sort()).toEqual([publicId, bPrivateId].sort());
        expect(mine.find((p) => p.id === bPrivateId)?.isOwner).toBe(true);
        expect(mine.find((p) => p.id === publicId)?.isOwner).toBe(false);
    });
});
