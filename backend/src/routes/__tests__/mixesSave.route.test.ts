/**
 * POST /mixes/:id/save turns a mix into a playlist in one write: every song in the mix's order, each with its own
 * rank (the column is unique per playlist). A song the mix still names but the library no longer has (mixes are
 * cached) is left out rather than failing the save or leaving an empty playlist behind. The saver's other devices are
 * told once; saving the same mix again is refused and tells nobody. Real database and Redis; auth is passed through.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import mixRoutes from "../mixes";
import { prisma } from "../../utils/db";
import { nightZone } from "../../services/mixes/nightPlays";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import type { SSEEvent } from "../../services/eventBus";
import { cleanupMarked, listenTo, playlistAnnouncements, seedSongs } from "./helpers/liveEvents";

const MARK = "zz-mix-save";
let userId: string;
let songs: string[];
let heard: SSEEvent[];
let stopListening: () => void;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: userId, username: `${MARK}-user`, role: "user" };
    next();
});
app.use("/mixes", mixRoutes);

/** The user's cached mixes, as the mixes route stores them. */
const cacheMixes = async (mixes: Array<{ id: string; name: string; trackIds: string[] }>) =>
    redisClient.setex(`mixes:${userId}`, 3600, JSON.stringify({ zones: { [await nightZone()]: { mixes, at: Date.now() } } }));

const announced = () => playlistAnnouncements(heard);

beforeAll(async () => {
    await waitForRedisReady();
    await cleanupMarked(MARK);
    userId = (await prisma.user.create({ data: { username: `${MARK}-user`, passwordHash: "x" } })).id;
    songs = await seedSongs(MARK, 5);
    const listener = listenTo(userId);
    heard = listener.heard;
    stopListening = listener.stop;
});

afterAll(async () => {
    stopListening();
    await cleanupMarked(MARK);
});

beforeEach(async () => {
    heard.length = 0;
    await prisma.playlist.deleteMany({ where: { userId } });
});

// Here, not in afterAll: the test setup closes Redis before a file's own afterAll runs.
afterEach(async () => {
    await redisClient.del(`mixes:${userId}`);
});

describe("saving a mix as a playlist", () => {
    it("keeps every song in the mix's order, each with its own rank, and tells the saver's devices once", async () => {
        const order = [songs[3], songs[0], songs[4], songs[1], songs[2]];
        await cacheMixes([{ id: "mix-1", name: `${MARK} Late Night`, trackIds: order }]);

        const res = await request(app).post("/mixes/mix-1/save").send({});

        expect(res.status).toBe(200);
        expect(res.body.trackCount).toBe(5);
        const items = await prisma.playlistItem.findMany({ where: { playlistId: res.body.id }, orderBy: { rank: "asc" } });
        expect(items.map((i) => i.trackId)).toEqual(order);
        expect(new Set(items.map((i) => i.rank)).size).toBe(5);
        expect(announced()).toEqual([{ playlistId: res.body.id, deleted: false }]);
    });

    it("leaves out a song the library no longer has, and saves the rest", async () => {
        await cacheMixes([{ id: "mix-2", name: `${MARK} Stale`, trackIds: [songs[0], "deleted-since-the-mix-was-made", songs[1]] }]);

        const res = await request(app).post("/mixes/mix-2/save").send({});

        expect(res.status).toBe(200);
        expect(res.body.trackCount).toBe(2);
        const items = await prisma.playlistItem.findMany({ where: { playlistId: res.body.id }, orderBy: { rank: "asc" } });
        expect(items.map((i) => i.trackId)).toEqual([songs[0], songs[1]]);
        expect(announced()).toEqual([{ playlistId: res.body.id, deleted: false }]);
    });

    it("leaves out a song whose album has moved to Discover since the mix was made", async () => {
        const artist = await prisma.artist.findFirstOrThrow({ where: { name: `${MARK} Artist` } });
        const discover = await prisma.album.create({
            data: { rgMbid: `${MARK}-rg-disc`, identityKey: `${MARK}-album-disc`, primaryType: "Album", title: `${MARK} Discover Album`, artistId: artist.id, location: "DISCOVER" },
        });
        const discoverSong = await prisma.track.create({
            data: { title: `${MARK} Discover Song`, albumId: discover.id, trackNo: 1, duration: 100, filePath: `/${MARK}/disc.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        await cacheMixes([{ id: "mix-5", name: `${MARK} Moved`, trackIds: [songs[0], discoverSong.id, songs[1]] }]);

        const res = await request(app).post("/mixes/mix-5/save").send({});

        expect(res.status).toBe(200);
        const items = await prisma.playlistItem.findMany({ where: { playlistId: res.body.id }, orderBy: { rank: "asc" } });
        expect(items.map((i) => i.trackId)).toEqual([songs[0], songs[1]]);
    });

    it("refuses a mix none of whose songs the library still has: no empty playlist, nobody told", async () => {
        await cacheMixes([{ id: "mix-4", name: `${MARK} Gone`, trackIds: ["deleted-one", "deleted-two"] }]);

        const res = await request(app).post("/mixes/mix-4/save").send({});

        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/none of this mix's songs/i);
        expect(await prisma.playlist.count({ where: { userId } })).toBe(0);
        expect(announced()).toEqual([]);
    });

    it("refuses to save the same mix twice, and tells nobody", async () => {
        await cacheMixes([{ id: "mix-3", name: `${MARK} Twice`, trackIds: [songs[0]] }]);
        expect((await request(app).post("/mixes/mix-3/save").send({})).status).toBe(200);
        heard.length = 0;

        const again = await request(app).post("/mixes/mix-3/save").send({});

        expect(again.status).toBe(409);
        expect(await prisma.playlist.count({ where: { userId } })).toBe(1);
        expect(announced()).toEqual([]);
    });
});
