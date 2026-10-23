/**
 * GET /api/vibe/mood/:trackId answers with the mood that colours the track's
 * star on the map, read from the real library's learned moods through a real
 * sign-in.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import vibeRouter from "../vibe";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { MOODS, MOOD_HEADS, type Mood } from "../../services/moods/heads";
import { buildMoodState } from "../../services/moods/state";

const P = "cvmood";
const ANALYZED_AT = new Date("2026-10-23T00:00:00Z");

/** Learned scores: 0 on every mood, `strong` far above, or every mood below the rest of the library. */
function moods(strong?: Mood | "low") {
    return Object.fromEntries(MOODS.map((m) => [m, strong === "low" ? -1 : m === strong ? 5 : 0])) as Record<Mood, number>;
}

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
}

let token: string;

beforeAll(async () => {
    await cleanup();
    const user = await prisma.user.create({
        data: { id: `${P}user`, username: `${P}user`, passwordHash: "x", role: "user" },
    });
    token = generateToken(user);
    await prisma.artist.create({ data: { id: `${P}art`, name: "Mood Artist", identityKey: `${P}-art` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Mood Album", primaryType: "Album" } });
    // Ten quiet tracks give the library a mean and spread to stand out against.
    const tracks: [string, Record<Mood, number> | null, string][] = [
        ["happy", moods("happy"), "completed"],
        ["calm", moods("calm"), "completed"],
        ["flat", moods("low"), "completed"],
        ["fresh", null, "pending"],
        ...Array.from({ length: 10 }, (_, i): [string, Record<Mood, number>, string] => [`quiet${i}`, moods(), "completed"]),
    ];
    for (const [i, [name, scores, status]] of tracks.entries()) {
        const id = `${P}${name}`;
        await prisma.track.create({
            data: {
                id, albumId: `${P}alb`, title: name, trackNo: i + 1, duration: 200,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
                analysisStatus: status, arousal: 0.2 + (i % 5) * 0.15, instrumentalness: 0.5, acousticness: 0.1 + (i % 3) * 0.3,
            },
        });
        if (!scores) continue;
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at) VALUES ($1, $2::vector, $3, $4)`,
            id, `[1${",0".repeat(MOOD_HEADS.dims - 1)}]`, MOOD_HEADS.model, ANALYZED_AT,
        );
        await prisma.trackMood.create({
            data: { track_id: id, embedded_at: ANALYZED_AT, weights: MOOD_HEADS.version, ...scores },
        });
    }
    await prisma.$transaction((tx) => buildMoodState(tx));
});

afterAll(async () => {
    await cleanup();
    await closeClient(redisClient);
});

function app() {
    const a = express();
    a.use("/api/vibe", vibeRouter);
    return a;
}

const mood = (id: string) =>
    request(app()).get(`/api/vibe/mood/${id}`).set("Authorization", `Bearer ${token}`);

describe("GET /api/vibe/mood/:trackId", () => {
    it("names the mood a track stands out on", async () => {
        expect((await mood(`${P}happy`)).body).toEqual({ dominantMood: "moodHappy" });
        expect((await mood(`${P}calm`)).body).toEqual({ dominantMood: "moodRelaxed" });
    });

    it("says no single mood when none stands out", async () => {
        expect((await mood(`${P}flat`)).body).toEqual({ dominantMood: "neutral" });
    });

    it("says not analysed for a track without moods yet", async () => {
        expect((await mood(`${P}fresh`)).body).toEqual({ dominantMood: "unanalyzed" });
    });

    it("refuses a request that is not signed in", async () => {
        const res = await request(app()).get(`/api/vibe/mood/${P}happy`);
        expect(res.status).toBe(401);
    });
});
