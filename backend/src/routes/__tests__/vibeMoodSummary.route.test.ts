/**
 * GET /api/vibe/mood-summary gives the collection page its mood picture without the whole map: each mood's share of
 * the analysed tracks, and the mood each album and artist shares with its tracks. Real router, real test database,
 * a real sign-in. Every seeded track is first checked against the mood the map gives it (GET /api/vibe/mood/:id),
 * so the summary is held to the same per-track moods the map shows.
 */

import fs from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import vibeRouter from "../vibe";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { MOODS, MOOD_HEADS, type Mood } from "../../services/moods/heads";
import { buildMoodState } from "../../services/moods/state";
import { LEGEND, summariseMoods } from "../../services/vibeMap";

const P = "cvsum";
const ANALYZED_AT = new Date("2026-10-23T00:00:00Z");

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

type Kind = "happy" | "calm" | "flat" | "quiet" | "fresh";
// album -> [artist, location, kinds]
const ALBUMS: Record<string, [string, "LIBRARY" | "DISCOVER", Kind[]]> = {
    a1: ["x", "LIBRARY", ["happy", "happy", "calm"]], // happy wins the album
    a2: ["x", "LIBRARY", ["flat", "flat", "happy"]], // no single mood wins: album left out
    a3: ["y", "LIBRARY", ["calm", "happy"]], // tie: legend order, happy before calm
    a4: ["w", "LIBRARY", ["fresh"]], // not analysed: left out of everything
    a5: ["q", "LIBRARY", Array.from({ length: 12 }, () => "quiet" as const)], // fills the library out so moods stand out
    d1: ["z", "DISCOVER", ["happy", "happy"]], // Discover songs never appear
};

let token: string;
const expectedMood: Record<string, string> = {};

beforeAll(async () => {
    await cleanup();
    const user = await prisma.user.create({ data: { id: `${P}user`, username: `${P}user`, passwordHash: "x", role: "user" } });
    token = generateToken(user);
    for (const a of ["x", "y", "z", "w", "q"]) {
        await prisma.artist.create({ data: { id: `${P}art${a}`, name: `Artist ${a}`, identityKey: `${P}-art-${a}` } });
    }
    let n = 0;
    for (const [alb, [artist, location, kinds]] of Object.entries(ALBUMS)) {
        await prisma.album.create({
            data: { id: `${P}${alb}`, artistId: `${P}art${artist}`, rgMbid: `${P}-rg-${alb}`, title: alb, identityKey: `${P}-alb-${alb}`, primaryType: "Album", location },
        });
        for (const [i, kind] of kinds.entries()) {
            const id = `${P}${alb}t${i}`;
            n += 1;
            await prisma.track.create({
                data: {
                    id, albumId: `${P}${alb}`, title: id, trackNo: i + 1, duration: 200,
                    filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
                    analysisStatus: kind === "fresh" ? "pending" : "completed",
                    arousal: 0.2 + (n % 5) * 0.15, instrumentalness: 0.5, acousticness: 0.1 + (n % 3) * 0.3,
                },
            });
            // The mood snapshot already leaves Discover songs unscored; the summary's own query leaves them out too.
            expectedMood[id] = location === "DISCOVER" ? "unanalyzed" : { happy: "moodHappy", calm: "moodRelaxed", flat: "neutral", quiet: "neutral", fresh: "unanalyzed" }[kind];
            await prisma.$executeRawUnsafe(
                `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at) VALUES ($1, $2::vector, $3, $4)`,
                id, `[1${",0".repeat(MOOD_HEADS.dims - 1)}]`, MOOD_HEADS.model, ANALYZED_AT,
            );
            await prisma.$executeRawUnsafe(
                `INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out) VALUES ($1, $2, $3, 0, 0, 0.5, true)`,
                id, ANALYZED_AT, n,
            );
            if (kind === "fresh") continue;
            const scores = moods(kind === "happy" ? "happy" : kind === "calm" ? "calm" : kind === "flat" ? "low" : undefined);
            await prisma.trackMood.create({ data: { track_id: id, embedded_at: ANALYZED_AT, weights: MOOD_HEADS.version, ...scores } });
        }
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
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
const summary = () => auth(request(app()).get("/api/vibe/mood-summary"));

describe("GET /api/vibe/mood-summary", () => {
    it("starts from the moods the map gives these tracks", async () => {
        for (const [id, mood] of Object.entries(expectedMood)) {
            const res = await auth(request(app()).get(`/api/vibe/mood/${id}`));
            expect([id, res.body.dominantMood]).toEqual([id, mood]);
        }
    });

    it("shares the analysed tracks out by mood, leaving unanalysed and Discover songs out", async () => {
        const res = await summary();
        expect(res.status).toBe(200);
        // analysed library songs: happy 4 (a1 x2, a2, a3), calm 2 (a1, a3), no single mood 14 (a2 x2, a5 x12).
        const analysed = 20;
        expect(res.body.shares).toEqual([
            { key: "neutral", fraction: 14 / analysed },
            { key: "moodHappy", fraction: 4 / analysed },
            { key: "moodRelaxed", fraction: 2 / analysed },
        ]);
    });

    it("marks each album and artist with the mood most of its tracks share", async () => {
        const res = await summary();
        expect(res.body.albums).toEqual({
            [`${P}a1`]: "moodHappy", // 2 happy, 1 calm
            [`${P}a3`]: "moodHappy", // 1 happy, 1 calm: tie goes to the legend's order
        }); // a2 (no single mood wins), a4 (unanalysed), a5 (all neutral) and d1 (Discover) are absent
        expect(res.body.artists).toEqual({
            [`${P}artx`]: "moodHappy", // 3 happy, 1 calm, 2 neutral
            [`${P}arty`]: "moodHappy",
        });
    });

    it("refuses a request that is not signed in", async () => {
        expect((await request(app()).get("/api/vibe/mood-summary")).status).toBe(401);
    });
});

describe("summariseMoods", () => {
    const t = (dominantMood: string, albumId = "al", artistId = "ar") => ({ dominantMood, albumId, artistId });

    it("treats a value that is not a mood as no single mood, and answers empty for nothing analysed", () => {
        expect(summariseMoods([t("somethingElse"), t("moodSad")]).shares).toEqual([
            { key: "moodSad", fraction: 0.5 },
            { key: "neutral", fraction: 0.5 },
        ]);
        expect(summariseMoods([t("unanalyzed")])).toEqual({ shares: [], albums: {}, artists: {} });
    });

    it("sizes moods biggest first, equal counts in legend order, and each group's winner ties to the legend too", () => {
        const out = summariseMoods([
            t("moodParty", "b1", "r1"), t("moodSad", "b1", "r1"), t("moodHappy", "b2", "r2"), t("neutral", "b2", "r2"),
            t("neutral", "b3", "r3"), t("neutral", "b3", "r3"), t("moodHappy", "b3", "r3"), t("unanalyzed", "b4", "r4"),
        ]);
        // 7 analysed: neutral 3, happy 2, then sad and party 1 each, sad first by the legend.
        expect(out.shares.map((s) => s.key)).toEqual(["neutral", "moodHappy", "moodSad", "moodParty"]);
        expect(out.shares.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1);
        expect(out.albums).toEqual({ b1: "moodSad", b2: "moodHappy" }); // b3 is mostly no single mood, b4 unanalysed
    });

    it("keeps the same mood order as the frontend's legend", () => {
        const source = fs.readFileSync(path.resolve(__dirname, "../../../../frontend/features/vibe/mapUtils.ts"), "utf8");
        const block = /export const MOOD_KEYS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
        const frontend = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
        expect(frontend.length).toBeGreaterThan(0);
        expect(LEGEND).toEqual(frontend);
    });
});
