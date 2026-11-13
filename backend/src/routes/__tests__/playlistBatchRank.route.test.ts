/**
 * POST /playlists/:id/items/batch inserts through the shared rank allocator.
 * `rank` is unique per playlist, and a local createMany with skipDuplicates
 * would keep only the first track. Real router and database, real tokens.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistRoutes from "../playlists";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-playlist-batch-rank";
const app = mountAsServer(express().use(express.json()), "/playlists", playlistRoutes, "/api/playlists");
const as = (userId: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;

let owner: string;
let other: string;
let trackIds: string[];

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

const newPlaylist = async (name: string, userId = owner) =>
    (await prisma.playlist.create({ data: { userId, name: `${MARK} ${name}` } })).id;
const items = (playlistId: string) => prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });

beforeAll(async () => {
    await cleanup();
    owner = (await prisma.user.create({ data: { username: `${MARK}-owner`, passwordHash: "x" } })).id;
    other = (await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: "x" } })).id;
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    trackIds = [];
    for (const n of [1, 2, 3]) {
        trackIds.push((await prisma.track.create({
            data: { title: `${MARK} Song ${n}`, albumId: album.id, trackNo: n, duration: 100, filePath: `/${MARK}/${n}.flac`, fileModified: new Date(), fileSize: 1 },
        })).id);
    }
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("POST /playlists/:id/items/batch", () => {
    it("keeps every song of one request, each with its own rank, in the order sent", async () => {
        const id = await newPlaylist("order");
        const sent = [trackIds[2], trackIds[0], trackIds[1]];

        const res = await request(app).post(`/playlists/${id}/items/batch`).set("Authorization", as(owner)).send({ trackIds: sent });

        expect(res.status).toBe(200);
        expect(res.body.added).toBe(3);
        expect(res.body.items.map((i: { trackId: string }) => i.trackId)).toEqual(sent);
        const rows = await items(id);
        expect(rows.map((r) => r.trackId)).toEqual(sent);
        expect(new Set(rows.map((r) => r.rank)).size).toBe(3);
    });

    it("reports the allocator counts, including rejects as skippedInvalid", async () => {
        const id = await newPlaylist("counts");
        await prisma.playlistItem.create({ data: { playlistId: id, trackId: trackIds[1], rank: "a0", sort: 0 } });

        const res = await request(app)
            .post(`/playlists/${id}/items/batch`)
            .set("Authorization", as(owner))
            .send({ trackIds: [trackIds[0], trackIds[1], `${MARK}-no-such-track`] });

        expect(res.status).toBe(200);
        expect(res.body.added).toBe(1);
        expect(res.body.skippedExisting).toBe(1);
        expect(res.body.skippedInvalid).toBe(1);
        expect((await items(id)).map((r) => r.trackId).sort()).toEqual([trackIds[0], trackIds[1]].sort());
    });

    it("still refuses someone else's playlist, and adds nothing to it", async () => {
        const id = await newPlaylist("theirs", other);

        const res = await request(app).post(`/playlists/${id}/items/batch`).set("Authorization", as(owner)).send({ trackIds });

        expect(res.status).toBe(403);
        expect(await items(id)).toHaveLength(0);
    });
});
