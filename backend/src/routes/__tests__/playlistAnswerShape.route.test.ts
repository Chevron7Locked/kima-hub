/**
 * What a playlist answer carries: an explicit list of named fields, the same for its owner and for another person who
 * sees it because it is public. No row column outside the list (the owner's id, the Spotify or mix link, the create
 * key) and no relation row (who hid it) reaches anyone. Real router and database, real tokens.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../../routes/playlists";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-playlist-answer-shape";
const app = mountAsServer(express().use(express.json()), "/playlists", playlistsRoutes, "/api/playlists");
const as = (userId: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "24h" })}`;

const PLAYLIST_FIELDS = ["id", "name", "isPublic", "reverseOrder", "createdAt", "updatedAt"];
const LIST_KEYS = [...PLAYLIST_FIELDS, "user", "items", "trackCount", "isOwner", "isHidden"].sort();
const DETAIL_KEYS = [
    ...PLAYLIST_FIELDS,
    "user",
    "items",
    "pendingTracks",
    "mergedItems",
    "trackCount",
    "pendingCount",
    "isOwner",
    "isHidden",
].sort();
const EDIT_KEYS = [...PLAYLIST_FIELDS].sort();

let owner: string;
let other: string;
let playlistId: string;

const keys = (body: object) => Object.keys(body).sort();

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    owner = (await prisma.user.create({ data: { username: `${MARK}-owner`, passwordHash: "x" } })).id;
    other = (await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: "x" } })).id;
    playlistId = (
        await prisma.playlist.create({
            data: {
                userId: owner,
                name: `${MARK} shared`,
                isPublic: true,
                spotifyPlaylistId: "spotify-private-link",
                idempotencyKey: "key-shape-0001",
            },
        })
    ).id;
    await prisma.hiddenPlaylist.create({ data: { userId: other, playlistId } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe.each([
    ["its owner", () => owner],
    ["another person", () => other],
])("a public playlist as %s sees it", (_who, viewer) => {
    it("lists only the named fields", async () => {
        const res = await request(app).get("/playlists").set("Authorization", as(viewer()));

        const listed = (res.body as Array<{ id: string }>).find((p) => p.id === playlistId);
        expect(listed).toBeDefined();
        expect(keys(listed!)).toEqual(LIST_KEYS);
        expect((listed as unknown as { user: object }).user).toEqual({ username: `${MARK}-owner` });
    });

    it("opens with only the named fields", async () => {
        const res = await request(app).get(`/playlists/${playlistId}`).set("Authorization", as(viewer()));

        expect(res.status).toBe(200);
        expect(keys(res.body)).toEqual(DETAIL_KEYS);
        expect(res.body.user).toEqual({ username: `${MARK}-owner` });
    });
});

it("shows the owner their playlist as theirs, and the other person as someone else's", async () => {
    const mine = await request(app).get(`/playlists/${playlistId}`).set("Authorization", as(owner));
    const theirs = await request(app).get(`/playlists/${playlistId}`).set("Authorization", as(other));

    expect([mine.body.isOwner, theirs.body.isOwner]).toEqual([true, false]);
    expect([mine.body.isHidden, theirs.body.isHidden]).toEqual([false, true]);
});

it("answers an edit with only the named fields", async () => {
    const put = await request(app).put(`/playlists/${playlistId}`).set("Authorization", as(owner)).send({ name: `${MARK} renamed` });
    const patch = await request(app).patch(`/playlists/${playlistId}`).set("Authorization", as(owner)).send({ isPublic: true });

    expect(put.status).toBe(200);
    expect(keys(put.body)).toEqual(EDIT_KEYS);
    expect(put.body.name).toBe(`${MARK} renamed`);
    expect(keys(patch.body)).toEqual(EDIT_KEYS);
});

it("answers a create with only the named fields, with or without a key", async () => {
    const plain = await request(app).post("/playlists").set("Authorization", as(owner)).send({ name: `${MARK} plain` });
    const keyed = await request(app)
        .post("/playlists")
        .set("Authorization", as(owner))
        .set("Idempotency-Key", "key-shape-0002")
        .send({ name: `${MARK} keyed` });
    const again = await request(app)
        .post("/playlists")
        .set("Authorization", as(owner))
        .set("Idempotency-Key", "key-shape-0002")
        .send({ name: `${MARK} keyed` });

    for (const res of [plain, keyed, again]) {
        expect(res.status).toBe(200);
        expect(keys(res.body)).toEqual(EDIT_KEYS);
    }
    expect(again.body.id).toBe(keyed.body.id);
});
