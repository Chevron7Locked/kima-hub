/**
 * POST /playlists with an `Idempotency-Key` header: a repeat of the same key by the same person returns the playlist the
 * first one made, so a retry after a lost answer does not leave a second playlist. A key is kept for 24 hours. With no
 * header the route behaves as it always did (the iOS app sends none). Real router and database, real tokens.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../../routes/playlists";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-playlist-create-key";
const app = mountAsServer(express().use(express.json()), "/playlists", playlistsRoutes, "/api/playlists");
const as = (userId: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "24h" })}`;

let userA: string;
let userB: string;

const create = (user: string, name: string, key?: string, isPublic = false) => {
    const req = request(app).post("/playlists").set("Authorization", as(user));
    if (key !== undefined) req.set("Idempotency-Key", key);
    return req.send({ name, isPublic });
};
const rows = (user: string) => prisma.playlist.findMany({ where: { userId: user, name: { startsWith: MARK } } });

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    userA = (await prisma.user.create({ data: { username: `${MARK}-a`, passwordHash: "x" } })).id;
    userB = (await prisma.user.create({ data: { username: `${MARK}-b`, passwordHash: "x" } })).id;
});

beforeEach(() => prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } }));

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("POST /playlists with an Idempotency-Key", () => {
    it("returns the playlist the first request made, and makes no second one", async () => {
        const first = await create(userA, `${MARK} late night`, "key-0000-aaaa");
        const again = await create(userA, `${MARK} late night`, "key-0000-aaaa");

        expect(first.status).toBe(200);
        expect(again.status).toBe(200);
        expect(again.body.id).toBe(first.body.id);
        expect(await rows(userA)).toHaveLength(1);
    });

    it("returns the first playlist even when the repeat carries another name", async () => {
        const first = await create(userA, `${MARK} one`, "key-0001-aaaa");
        const again = await create(userA, `${MARK} two`, "key-0001-aaaa", true);

        expect(again.body.id).toBe(first.body.id);
        expect(again.body.name).toBe(`${MARK} one`);
        expect(await rows(userA)).toHaveLength(1);
    });

    it("makes one playlist when the same key arrives twice at once", async () => {
        const [a, b] = await Promise.all([
            create(userA, `${MARK} race`, "key-0002-aaaa"),
            create(userA, `${MARK} race`, "key-0002-aaaa"),
        ]);

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.id).toBe(b.body.id);
        expect(await rows(userA)).toHaveLength(1);
    });

    it("keeps keys apart per person: another user's playlist is never returned", async () => {
        const a = await create(userA, `${MARK} mine`, "key-0003-aaaa");
        const b = await create(userB, `${MARK} theirs`, "key-0003-aaaa");

        expect(b.body.id).not.toBe(a.body.id);
        expect(b.body.userId).toBe(userB);
        expect(await rows(userA)).toHaveLength(1);
        expect(await rows(userB)).toHaveLength(1);
    });

    it("makes a different playlist for a different key", async () => {
        const a = await create(userA, `${MARK} x`, "key-0004-aaaa");
        const b = await create(userA, `${MARK} x`, "key-0004-bbbb");

        expect(b.body.id).not.toBe(a.body.id);
        expect(await rows(userA)).toHaveLength(2);
    });

    it("forgets a key after 24 hours", async () => {
        const first = await create(userA, `${MARK} old`, "key-0005-aaaa");
        const stale = new Date(Date.now() - 25 * 3600_000);
        await prisma.$executeRaw`UPDATE "Playlist" SET "createdAt" = ${stale} WHERE id = ${first.body.id}`;
        const before = (await prisma.playlist.findUniqueOrThrow({ where: { id: first.body.id } })).updatedAt;

        const again = await create(userA, `${MARK} new`, "key-0005-aaaa");

        expect(again.body.id).not.toBe(first.body.id);
        expect(await rows(userA)).toHaveLength(2);
        // Forgetting the old key does not touch the old playlist's own fields.
        const old = await prisma.playlist.findUniqueOrThrow({ where: { id: first.body.id } });
        expect(old.updatedAt).toEqual(before);
        expect(old.name).toBe(`${MARK} old`);
    });

    it("does not expose the key in the answer", async () => {
        const res = await create(userA, `${MARK} quiet`, "key-0006-aaaa");

        expect(res.body).not.toHaveProperty("idempotencyKey");
        expect((await create(userA, `${MARK} quiet`, "key-0006-aaaa")).body).not.toHaveProperty("idempotencyKey");
    });

    it("refuses a key longer than 128 characters", async () => {
        const res = await create(userA, `${MARK} long`, "k".repeat(129));

        expect(res.status).toBe(400);
        expect(await rows(userA)).toHaveLength(0);
    });
});

describe("POST /playlists with no Idempotency-Key", () => {
    it("makes a new playlist every time", async () => {
        const a = await create(userA, `${MARK} plain`);
        const b = await create(userA, `${MARK} plain`);

        expect(b.body.id).not.toBe(a.body.id);
        expect(await rows(userA)).toHaveLength(2);
    });
});
