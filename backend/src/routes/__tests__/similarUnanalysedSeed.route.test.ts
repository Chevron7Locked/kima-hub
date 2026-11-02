/**
 * "Similar tracks" for a seed with no embedding answers 404, not arbitrary
 * tracks, on the vibe route. Real router, service and database; auth, redis,
 * logger and featureDetection are mocked.
 */

import express from "express";
import request from "supertest";

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// Any other export the routers' transitive imports reach for degrades to the
// same authenticated passthrough instead of blowing up the mount.
jest.mock("../../middleware/auth", () => {
    const passthrough = (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    };
    return new Proxy(
        { requireAuth: passthrough, requireAuthOrToken: passthrough },
        {
            get(target: any, key: string) {
                if (key in target) return target[key];
                return passthrough;
            },
        },
    );
});

// utils/redis builds a real ioredis client at import; nothing these routes
// touch on the asserted paths sends a command, so a stub keeps the run quiet.
jest.mock("../../utils/redis", () => ({
    __esModule: true,
    redisClient: { ping: jest.fn(async () => "pong") },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            musicCNN: true,
            vibeEmbeddings: true,
            audiobookshelfEnabled: false,
        }),
    },
}));

import { prisma } from "../../utils/db";
import vibeRouter from "../vibe";
import { SELF_SCORE } from "../../services/matching/formula";
import { MATCHING_MODEL, buildMatching } from "../../services/matching/state";

const UNANALYSED_ID = "ctrkuna000000000000000001"; // Track row, NO embedding
const SEED_ID = "ctrkemb000000000000000001"; // embedded, drives the happy path
const NEIGHBOUR_ID = "ctrkemb000000000000000002"; // embedded, nearest to SEED
const MISSING_ID = "ctrkmissing0000000000001"; // never created
const ALL_TRACK_IDS = [UNANALYSED_ID, SEED_ID, NEIGHBOUR_ID];

async function seedTrack(id: string) {
    const artist = await prisma.artist.create({
        data: { id: `cart_${id}`, name: `A ${id}`, identityKey: `a_${id}` },
    });
    const album = await prisma.album.create({
        data: {
            id: `calb_${id}`,
            rgMbid: `rg_${id}`,
            artistId: artist.id,
            title: `L ${id}`,
            primaryType: "Album",
        },
    });
    await prisma.track.create({
        data: {
            id,
            albumId: album.id,
            title: `T ${id}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${id}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        },
    });
}

// Prisma cannot write Unsupported("vector") columns; mirrors the raw insert
// shape used in hybridSimilarity.nullhandling.test.ts.
async function seedEmbedding(trackId: string, vector: string) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, $3, now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        vector,
        MATCHING_MODEL,
    );
}

// Unit 512-dim vectors that are cosine-identical (distance 0) to each other.
const UNIT_VECTOR = `[${["1", ...Array(511).fill("0")].join(",")}]`;

const vibeApp = express();
vibeApp.use("/api/vibe", vibeRouter);

beforeAll(async () => {
    await seedTrack(UNANALYSED_ID);
    await seedTrack(SEED_ID);
    await seedTrack(NEIGHBOUR_ID);
    await seedEmbedding(SEED_ID, UNIT_VECTOR);
    await seedEmbedding(NEIGHBOUR_ID, UNIT_VECTOR);
    await buildMatching();
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { in: ALL_TRACK_IDS } } });
    await prisma.album.deleteMany({
        where: { id: { in: ALL_TRACK_IDS.map((id) => `calb_${id}`) } },
    });
    await prisma.artist.deleteMany({
        where: { id: { in: ALL_TRACK_IDS.map((id) => `cart_${id}`) } },
    });
    // buildMatching() above wrote the library's one shared matching state; leaving it makes later files see a library that has one.
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
});

describe("similar tracks for an unanalysed seed", () => {
    it("GET /api/vibe/similar/:trackId answers 404 with the not-analysed body", async () => {
        const res = await request(vibeApp).get(`/api/vibe/similar/${UNANALYSED_ID}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            error: "No similar tracks found",
            message: "This track may not have been analyzed yet, or no analyzer is running",
        });
    });

    it("GET /api/vibe/similar/:trackId answers 404 for a nonexistent id too", async () => {
        const res = await request(vibeApp).get(`/api/vibe/similar/${MISSING_ID}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            error: "No similar tracks found",
            message: "This track may not have been analyzed yet, or no analyzer is running",
        });
    });

    it("an analysed seed still returns its neighbours with the documented shape", async () => {
        const res = await request(vibeApp).get(`/api/vibe/similar/${SEED_ID}`);
        expect(res.status).toBe(200);
        expect(res.body.sourceTrackId).toBe(SEED_ID);
        expect(res.body.tracks).toHaveLength(1);
        expect(res.body.tracks[0].id).toBe(NEIGHBOUR_ID);
        // Both tracks have the same feel, so the identical neighbour scores its sound
        // alone: 1 out of SELF_SCORE, the most a track can score against itself.
        expect(res.body.tracks[0].similarity).toBeCloseTo(1 / SELF_SCORE, 5);
        expect(res.body.tracks[0].album.title).toBe(`L ${NEIGHBOUR_ID}`);
        expect(res.body.tracks[0].artist.name).toBe(`A ${NEIGHBOUR_ID}`);
    });

});
