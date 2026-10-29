/**
 * The vibe answers that the player queues (similar songs, vibe search, song path) carry each song's edited title, so
 * the player shows the edit as the song lists do. The matching engine is replaced with fixed answers about a real song
 * row; the edited title comes from the real database.
 */

const mockSimilar = jest.fn();
const mockSearch = jest.fn();
const mockPath = jest.fn();
jest.mock("../../services/hybridSimilarity", () => ({ findSimilarTracks: (...a: unknown[]) => mockSimilar(...a) }));
jest.mock("../../services/textEmbeddingBridge", () => ({ searchTracksByText: (...a: unknown[]) => mockSearch(...a) }));
jest.mock("../../services/songPath", () => ({ generateSongPath: (...a: unknown[]) => mockPath(...a) }));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "vt_user", role: "user" };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import vibeRouter from "../vibe";

const P = "vtitle";
const app = express().use(express.json()).use("/vibe", vibeRouter);

const row = (id: string) => ({
    id, title: "file title", duration: 200, trackNo: 1, distance: 0.1, similarity: 0.9,
    albumId: `${P}_alb`, albumTitle: "Album", albumCoverUrl: null, artistId: `${P}_art`, artistName: "Artist",
});

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}_art`, name: "Artist", identityKey: `${P}_ik` } });
    await prisma.album.create({ data: { id: `${P}_alb`, rgMbid: `${P}_rg`, artistId: `${P}_art`, title: "Album", primaryType: "Album" } });
    for (const [id, displayTitle] of [[`${P}_edited`, "edited title"], [`${P}_plain`, null]] as const) {
        await prisma.track.create({
            data: { id, albumId: `${P}_alb`, title: "file title", displayTitle, trackNo: 1, duration: 200, filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

const titles = (tracks: Array<{ displayTitle?: string | null }>) => tracks.map((t) => t.displayTitle);

describe("vibe answers carry the edited title", () => {
    it("similar songs", async () => {
        mockSimilar.mockResolvedValue([row(`${P}_edited`), row(`${P}_plain`)]);
        const res = await request(app).get(`/vibe/similar/${P}_seed`).expect(200);
        expect(titles(res.body.tracks)).toEqual(["edited title", null]);
    });

    it("vibe search", async () => {
        mockSearch.mockResolvedValue([row(`${P}_edited`), row(`${P}_plain`)]);
        const res = await request(app).post("/vibe/search").send({ query: "calm piano" }).expect(200);
        expect(titles(res.body.tracks)).toEqual(["edited title", null]);
    });

    it("song path, its ends included", async () => {
        const step = (id: string) => ({ id, title: "file title", duration: 200, albumId: `${P}_alb`, albumTitle: "Album", albumCoverUrl: null, artistId: `${P}_art`, artistName: "Artist" });
        mockPath.mockResolvedValue({ startTrack: step(`${P}_edited`), path: [step(`${P}_plain`)], endTrack: step(`${P}_edited`), metadata: {} });
        const res = await request(app)
            .post("/vibe/path")
            .send({ startTrackId: "ckxxxxxxxxxxxxxxxxxxxxxxx", endTrackId: "ckyyyyyyyyyyyyyyyyyyyyyyy" })
            .expect(200);
        expect([res.body.startTrack.displayTitle, ...titles(res.body.path), res.body.endTrack.displayTitle]).toEqual([
            "edited title",
            null,
            "edited title",
        ]);
    });
});

describe("how many results a vibe answer holds", () => {
    it.each([
        [undefined, 20],
        [7, 7],
        ["7", 7],
        [500, 100],
        ["many", 20],
        [-3, 1],
    ])("a search asking for %p gets %p", async (limit, expected) => {
        mockSearch.mockResolvedValue([]);
        await request(app).post("/vibe/search").send({ query: "calm piano", ...(limit === undefined ? {} : { limit }) });
        expect(mockSearch.mock.calls.at(-1)?.[1]).toBe(expected);
    });

    it.each([["500", 100], ["many", 20], ["7", 7]])("similar songs asking for %p get %p", async (limit, expected) => {
        mockSimilar.mockResolvedValue([row(`${P}_plain`)]);
        await request(app).get(`/vibe/similar/${P}_seed?limit=${limit}`);
        expect(mockSimilar.mock.calls.at(-1)?.[1]).toBe(expected);
    });
});
