/**
 * Playlist display order: ?order=rev serves the item list reversed, an
 * unknown order is a 400, and the persisted reverseOrder flag is an
 * owner-only write. Real database, real router; auth via JWT, as the app
 * would.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../playlists";
import { prisma } from "../../utils/db";

const MARK = "zz-playlist-reverse";
const TEST_SECRET = process.env.JWT_SECRET!;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/playlists", playlistsRoutes);
    return app;
}

function tokenFor(userId: string, username: string): string {
    return jwt.sign(
        { userId, username, role: "user", tokenVersion: 0 },
        TEST_SECRET,
        { expiresIn: "1h" }
    );
}

let ownerId: string;
let otherId: string;
let ownerUsername: string;
let otherUsername: string;
let playlistId: string;
let trackIds: string[];

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } });

    const owner = await prisma.user.create({
        data: { username: `${MARK}-owner`, passwordHash: "test" },
    });
    const other = await prisma.user.create({
        data: { username: `${MARK}-other`, passwordHash: "test" },
    });
    ownerId = owner.id;
    ownerUsername = owner.username;
    otherId = other.id;
    otherUsername = other.username;

    const artist = await prisma.artist.create({
        data: {
            name: `${MARK} Artist`,
            identityKey: `${MARK}-artist`,
            libraryAlbumCount: 1,
        },
    });
    const album = await prisma.album.create({
        data: {
            rgMbid: `${MARK}-rgmbid`,
            identityKey: `${MARK}-album`,
            primaryType: "Album",
            title: `${MARK} Album`,
            artistId: artist.id,
            location: "LIBRARY",
            year: 2020,
        },
    });

    trackIds = [];
    for (let i = 0; i < 3; i += 1) {
        const track = await prisma.track.create({
            data: {
                title: `${MARK} Song ${i}`,
                albumId: album.id,
                trackNo: i + 1,
                duration: 100 + i,
                filePath: `/${MARK}/${i}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            },
        });
        trackIds.push(track.id);
    }

    const playlist = await prisma.playlist.create({
        data: {
            userId: ownerId,
            name: `${MARK} Playlist`,
            items: {
                create: trackIds.map((trackId, i) => ({
                    trackId,
                    sort: i,
                    rank: "abc"[i],
                })),
            },
        },
    });
    playlistId = playlist.id;
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.playlist.deleteMany({ where: { name: { startsWith: MARK } } });
});

async function getItemIds(order?: string): Promise<string[]> {
    const req = request(makeApp())
        .get(`/playlists/${playlistId}`)
        .set("Authorization", `Bearer ${tokenFor(ownerId, ownerUsername)}`);
    if (order !== undefined) {
        req.query({ order });
    }
    const res = await req.expect(200);
    return res.body.items.map((item: { track: { id: string } }) => item.track.id);
}

describe("GET /playlists/:id display order", () => {
    it("serves stored rank order when no order is given", async () => {
        expect(await getItemIds()).toEqual(trackIds);
    });

    it("serves stored rank order for order=asc", async () => {
        expect(await getItemIds("asc")).toEqual(trackIds);
    });

    it("serves exactly the reversed list for order=rev", async () => {
        const asc = await getItemIds("asc");
        const rev = await getItemIds("rev");
        expect(rev).toEqual([...asc].reverse());
    });

    it("rejects an unknown order with 400", async () => {
        const req = request(makeApp())
            .get(`/playlists/${playlistId}`)
            .set("Authorization", `Bearer ${tokenFor(ownerId, ownerUsername)}`)
            .query({ order: "banana" });
        const res = await req;
        expect(res.status).toBe(400);
    });
});

describe("PATCH /playlists/:id reverseOrder", () => {
    it("persists the flag and a plain GET comes back reversed until it is unset", async () => {
        const on = await request(makeApp())
            .patch(`/playlists/${playlistId}`)
            .set("Authorization", `Bearer ${tokenFor(ownerId, ownerUsername)}`)
            .send({ reverseOrder: true })
            .expect(200);
        expect(on.body.reverseOrder).toBe(true);
        expect(await getItemIds()).toEqual([...trackIds].reverse());

        const off = await request(makeApp())
            .patch(`/playlists/${playlistId}`)
            .set("Authorization", `Bearer ${tokenFor(ownerId, ownerUsername)}`)
            .send({ reverseOrder: false })
            .expect(200);
        expect(off.body.reverseOrder).toBe(false);
        expect(await getItemIds()).toEqual(trackIds);
    });

    it("an explicit order=asc beats a stored reverseOrder", async () => {
        await prisma.playlist.update({
            where: { id: playlistId },
            data: { reverseOrder: true },
        });
        expect(await getItemIds("asc")).toEqual(trackIds);
        expect(await getItemIds()).toEqual([...trackIds].reverse());
        await prisma.playlist.update({
            where: { id: playlistId },
            data: { reverseOrder: false },
        });
    });

    it("refuses a non-owner with 403 and leaves the flag untouched", async () => {
        const res = await request(makeApp())
            .patch(`/playlists/${playlistId}`)
            .set("Authorization", `Bearer ${tokenFor(otherId, otherUsername)}`)
            .send({ reverseOrder: true });
        expect(res.status).toBe(403);

        const row = await prisma.playlist.findUnique({
            where: { id: playlistId },
            select: { reverseOrder: true },
        });
        expect(row?.reverseOrder).toBe(false);
    });
});
