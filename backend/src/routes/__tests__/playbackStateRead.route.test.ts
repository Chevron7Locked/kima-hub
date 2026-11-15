/**
 * GET /api/playback-state: the saved queue comes back with only its playable songs, the way a Subsonic client is
 * shown it, so a song retired or gone missing since the queue was saved never reaches the player. The stored queue is
 * left as it is. Real database.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import playbackStateRouter from "../playbackState";
import { mountAsServer } from "./helpers/serverMount";

const P = "pbread";
const USER = `${P}user`;

const app = express();
app.use(express.json());
mountAsServer(app, "/api/playback-state", playbackStateRouter, "/api/playback-state");

const entry = (id: string) => ({ id, title: `${id} title`, displayTitle: null, duration: 200, artist: null, album: null });
const ids = (body: { queue: Array<{ id: string }> | null }) => body.queue?.map((e) => e.id) ?? null;

async function cleanup() {
    await prisma.playbackState.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

async function seedSong(id: string, opts: { missing?: boolean; corrupt?: boolean; album?: string } = {}) {
    await prisma.track.create({
        data: {
            id: `${P}${id}`, albumId: opts.album ?? `${P}alb`, title: id, trackNo: 1, duration: 200, filePath: `/tmp/${P}${id}.flac`,
            fileModified: new Date(), fileSize: 1, missingSince: opts.missing ? new Date() : null, corrupt: opts.corrupt ?? false,
        },
    });
}

const save = (queue: string[], currentIndex: number, extra: { trackId?: string | null; position?: number; queueSource?: string } = {}) => {
    const data = {
        queue: queue.map(entry), currentIndex, trackId: extra.trackId ?? null, position: extra.position ?? 0,
        queueSource: extra.queueSource ?? null,
    };
    return prisma.playbackState.upsert({ where: { userId: USER }, create: { userId: USER, playbackType: "track", ...data }, update: data });
};

const get = () => request(app).get("/api/playback-state").set("x-user", USER).expect(200);

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "Read Artist", identityKey: `${P}-a` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, identityKey: `${P}-ak`, title: "Read Album", primaryType: "Album" } });
    await prisma.album.create({ data: { id: `${P}dalb`, artistId: `${P}art`, rgMbid: `${P}-drg`, identityKey: `${P}-dak`, title: "Read Discover", primaryType: "Album", location: "DISCOVER" } });
    await seedSong("ok1");
    await seedSong("ok2");
    await seedSong("ok3");
    await seedSong("gone", { missing: true });
    await seedSong("bad", { corrupt: true });
    await seedSong("disc", { album: `${P}dalb` });
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("GET /api/playback-state", () => {
    it("answers no state for a person who has none", async () => {
        const res = await get();
        expect(res.body).toBeNull();
    });

    it("leaves out a missing, a corrupt and a Discover song, and keeps the index on the same song", async () => {
        await save([`${P}gone`, `${P}ok1`, `${P}bad`, `${P}ok2`, `${P}disc`, `${P}ok3`], 5, { trackId: `${P}ok3`, queueSource: "album:x" });
        const res = await get();
        expect(ids(res.body)).toEqual([`${P}ok1`, `${P}ok2`, `${P}ok3`]);
        expect(res.body.currentIndex).toBe(2);
        expect(res.body.trackId).toBe(`${P}ok3`);
        expect(res.body.queueSource).toBe("album:x");
    });

    it("when the current song is left out, the next playable one is current, from its start, and the track follows", async () => {
        await save([`${P}ok1`, `${P}gone`, `${P}ok2`], 1, { trackId: `${P}gone`, position: 7000 });
        const res = await get();
        expect(ids(res.body)).toEqual([`${P}ok1`, `${P}ok2`]);
        expect(res.body.currentIndex).toBe(1);
        expect(res.body.trackId).toBe(`${P}ok2`);
        expect(res.body.position).toBe(0);
    });

    it("keeps the offset when the current song is playable", async () => {
        await save([`${P}gone`, `${P}ok2`], 1, { trackId: `${P}ok2`, position: 7000 });
        expect((await get()).body.position).toBe(7000);
    });

    it("a queue with nothing playable comes back empty, naming no track", async () => {
        await save([`${P}gone`, `${P}bad`], 1, { trackId: `${P}bad`, position: 500, queueSource: "album:x" });
        const res = await get();
        expect(res.body.queue).toBeNull();
        expect(res.body.currentIndex).toBe(0);
        expect(res.body.trackId).toBeNull();
        expect(res.body.position).toBe(0);
        expect(res.body.queueSource).toBeNull();
    });

    it("does not change what is stored", async () => {
        await save([`${P}gone`, `${P}ok1`], 0, { trackId: `${P}gone` });
        await get();
        const stored = await prisma.playbackState.findUnique({ where: { userId: USER } });
        expect((stored!.queue as Array<{ id: string }>).map((e) => e.id)).toEqual([`${P}gone`, `${P}ok1`]);
        expect(stored!.trackId).toBe(`${P}gone`);
    });

    it("leaves a state with no queue exactly as stored", async () => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "audiobook", audiobookId: "ab1", position: 1234 } });
        const res = await get();
        expect(res.body).toMatchObject({ playbackType: "audiobook", audiobookId: "ab1", position: 1234, queue: null });
    });

    it("a queue that is not a list comes back as stored", async () => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: { odd: true } } });
        expect((await get()).body.queue).toEqual({ odd: true });
    });
});
