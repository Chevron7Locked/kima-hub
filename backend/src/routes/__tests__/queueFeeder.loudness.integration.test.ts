/**
 * The queue contract: every endpoint the web or iOS player can start a queue
 * from must carry loudness on every row, because the player levels playback
 * from the row it was handed and nothing re-enriches after. If a response
 * builder ever rebuilds its whitelist and forgets the field, this fails.
 *
 * Real database, real routers, auth injected as the parent router would.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import trackRoutes from "../library/tracks";
import albumRoutes from "../library/albums";
import artistRoutes from "../library/artists";
import playlistRoutes from "../playlists";
import playbackStateRoutes from "../playbackState";
import statsRoutes from "../stats";
import searchRoutes from "../search";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "zz-gaincontract-user", username: "gain-tester", role: "user" };
        next();
    },
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "zz-gaincontract-user", username: "gain-tester", role: "user" };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "zz-gaincontract-user", username: "gain-tester", role: "admin" };
        next();
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async () => null),
        setex: jest.fn(async () => "OK"),
        del: jest.fn(async () => 1),
        disconnect: jest.fn(),
        quit: jest.fn(async () => "OK"),
        multi: jest.fn(() => {
            const chain: any = {
                setex: () => chain,
                del: () => chain,
                sadd: () => chain,
                expire: () => chain,
                exec: async () => [],
            };
            return chain;
        }),
    },
}));

jest.setTimeout(60_000);

const P = "zz-gaincontract";
const USER = "zz-gaincontract-user";

function mount(router: express.RequestHandler) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = { id: USER, username: "gain-tester", role: "user" };
        next();
    });
    app.use("/", router);
    return app;
}

const libraryApp = mount(trackRoutes);
const albumApp = mount(albumRoutes);
const artistApp = mount(artistRoutes);
const playlistApp = mount(playlistRoutes);
const playbackStateApp = mount(playbackStateRoutes);
const statsApp = mount(statsRoutes);
const searchApp = mount(searchRoutes);

let albumId = `${P}-alb`;
let trackIds: string[] = [];

async function seed() {
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x-not-used", role: "user" },
    });
    const artist = await prisma.artist.create({
        data: { id: `${P}-art`, name: "Gain Contract Artist", identityKey: P },
    });
    await prisma.album.create({
        data: {
            id: albumId,
            rgMbid: `${P}-rg`,
            artistId: artist.id,
            title: "Gain Contract Album",
            primaryType: "Album",
            location: "LIBRARY",
            year: 2024,
        },
    });
    // Two measured and one unmeasured: the contract is the field, not a number.
    trackIds = [];
    for (const [i, loudness] of [-9.5, -13.2, null].entries()) {
        const id = `${P}-trk${i}`;
        await prisma.track.create({
            data: {
                id,
                albumId,
                title: `Zzgaincontract Song ${i}`,
                trackNo: i + 1,
                duration: 200,
                filePath: `/tmp/${id}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
                loudness,
            },
        });
        trackIds.push(id);
    }
    await prisma.play.create({ data: { userId: USER, trackId: trackIds[0] } });
    await prisma.playlist.create({
        data: {
            id: `${P}-pl`,
            userId: USER,
            name: "Gain Contract Playlist",
            // rank is unique per playlist and defaults to ""; nested creates must give distinct ones.
            items: { create: trackIds.map((trackId, sort) => ({ trackId, sort, rank: `a${sort}` })) },
        },
    });
}

async function teardown() {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.playlist.deleteMany({ where: { id: `${P}-pl` } });
    await prisma.track.deleteMany({ where: { albumId } });
    await prisma.album.deleteMany({ where: { id: albumId } });
    await prisma.artist.deleteMany({ where: { id: `${P}-art` } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(seed);
afterAll(async () => {
    await teardown();
    await closeEngineConnections();
});

/** Rows must exist, or the assertion would vacuously pass. */
function assertLoudnessOnEveryRow(rows: any[]) {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
        expect(row).toHaveProperty("loudness");
    }
}

it("library list carries loudness", async () => {
    const res = await request(libraryApp).get(`/tracks?search=zzgaincontract`);
    expect(res.status).toBe(200);
    assertLoudnessOnEveryRow(res.body.tracks);
});

it("track detail carries loudness (refresh and deep-link restore read it)", async () => {
    const res = await request(libraryApp).get(`/tracks/${trackIds[0]}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("loudness", -9.5);
});

it("radio carries loudness on every station row", async () => {
    const res = await request(libraryApp).get(`/radio?type=all&limit=50`);
    expect(res.status).toBe(200);
    const ours = res.body.tracks.filter((t: any) => t.title.includes("Zzgaincontract"));
    assertLoudnessOnEveryRow(ours);
});

it("stats play slices carry loudness", async () => {
    const never = await request(statsApp).get(`/tracks?of=never&limit=50`);
    expect(never.status).toBe(200);
    const oursNever = never.body.tracks.filter((t: any) => t.title.includes("Zzgaincontract"));
    assertLoudnessOnEveryRow(oursNever);

    const top = await request(statsApp).get(`/tracks?of=top&limit=50`);
    expect(top.status).toBe(200);
    const oursTop = top.body.tracks.filter((t: any) => t.title.includes("Zzgaincontract"));
    assertLoudnessOnEveryRow(oursTop);
});

it("album detail rows carry loudness", async () => {
    const res = await request(albumApp).get(`/albums/${albumId}`);
    expect(res.status).toBe(200);
    assertLoudnessOnEveryRow(res.body.tracks);
});

it("playlist detail rows carry loudness", async () => {
    const res = await request(playlistApp).get(`/${P}-pl`);
    expect(res.status).toBe(200);
    assertLoudnessOnEveryRow(res.body.items.map((i: any) => i.track));
});

it("artist play-tracks carries loudness (iOS native leveling reads it)", async () => {
    const res = await request(artistApp).get(`/artists/${P}-art/play-tracks`);
    expect(res.status).toBe(200);
    assertLoudnessOnEveryRow(res.body.tracks);
});

it("search results carry loudness", async () => {
    const res = await request(searchApp).get(`/?q=zzgaincontract&type=tracks`);
    expect(res.status).toBe(200);
    assertLoudnessOnEveryRow(res.body.tracks);
});

it("artist detail local-listen top tracks carry loudness and displayTitle", async () => {
    const res = await request(artistApp).get(`/artists/${P}-art`);
    expect(res.status).toBe(200);
    const ours = (res.body.topTracks ?? []).filter((t: any) => t.id?.startsWith(P));
    assertLoudnessOnEveryRow(ours);
    expect(ours.some((t: any) => t.displayTitle !== undefined)).toBe(true);
});

it("saved playback state (cross-device queue restore) keeps loudness", async () => {
    const queue = [{ id: trackIds[0], title: "Zzgaincontract Song 0", displayTitle: "Renamed", duration: 200, loudness: -9.5 }];
    const save = await request(playbackStateApp).post(`/`).send({ queue, playbackType: "track" });
    expect(save.status).toBeLessThan(400);
    const res = await request(playbackStateApp).get(`/`);
    expect(res.status).toBe(200);
    const state = res.body.state ?? res.body;
    const restored = (state.queue ?? []).filter((t: any) => t.id === trackIds[0]);
    assertLoudnessOnEveryRow(restored);
    expect(restored[0].loudness).toBe(-9.5);
    expect(restored[0].displayTitle).toBe("Renamed");
});
