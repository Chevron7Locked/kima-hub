/**
 * POST /podcasts/:podcastId/episodes/:episodeId/progress: a missing episode is a 404 and a body
 * without a position is a 400, never a 500; the shapes clients already send keep working.
 * Real router, real database.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_podprog", username: "t" }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: "u_podprog", username: "t" }; next(); },
}));

import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";

const P = "pod_progress_route";
const app = express();
app.use(express.json());
app.use("/podcasts", podcastRoutes);

beforeAll(async () => {
    await prisma.user.upsert({ where: { id: "u_podprog" }, create: { id: "u_podprog", username: "u_podprog", passwordHash: "x" }, update: {} });
    await prisma.podcast.deleteMany({ where: { id: P } });
    await prisma.podcast.create({
        data: {
            id: P,
            feedUrl: "https://feeds.example.invalid/progress",
            title: "Show",
            episodes: { create: [{ id: `${P}-ep`, guid: "g1", title: "E1", audioUrl: "https://a.invalid/1.mp3", duration: 600, publishedAt: new Date() }] },
        },
    });
});

afterAll(async () => {
    await prisma.podcastProgress.deleteMany({ where: { userId: "u_podprog" } });
    await prisma.podcast.deleteMany({ where: { id: P } });
    await prisma.user.deleteMany({ where: { id: "u_podprog" } });
});

const url = (episodeId: string) => `/podcasts/${P}/episodes/${episodeId}/progress`;

it("saves a position past the stored length", async () => {
    const res = await request(app).post(url(`${P}-ep`)).send({ currentTime: 650, duration: 700 });
    expect(res.status).toBe(200);
    const row = await prisma.podcastProgress.findUniqueOrThrow({ where: { userId_episodeId: { userId: "u_podprog", episodeId: `${P}-ep` } } });
    expect(row.currentTime).toBe(650);
});

it("accepts numbers sent as strings, and a missing duration keeps the stored one", async () => {
    expect((await request(app).post(url(`${P}-ep`)).send({ currentTime: 30, duration: 700 })).status).toBe(200);
    const res = await request(app).post(url(`${P}-ep`)).send({ currentTime: "120" });
    expect(res.status).toBe(200);
    const row = await prisma.podcastProgress.findUniqueOrThrow({ where: { userId_episodeId: { userId: "u_podprog", episodeId: `${P}-ep` } } });
    expect(row.currentTime).toBe(120);
    expect(row.duration).toBe(700);
});

it("answers 404 for an episode that does not exist", async () => {
    const res = await request(app).post(url("no_such_episode")).send({ currentTime: 10, duration: 20 });
    expect(res.status).toBe(404);
});

it("answers 400 without a position", async () => {
    const res = await request(app).post(url(`${P}-ep`)).send({ duration: 20 });
    expect(res.status).toBe(400);
});

it("counts an episode finished from 95% of its length on, whatever the client says, and unfinished again when replayed from early on", async () => {
    const row = () => prisma.podcastProgress.findUniqueOrThrow({ where: { userId_episodeId: { userId: "u_podprog", episodeId: `${P}-ep` } } });
    const save = (body: Record<string, unknown>) => request(app).post(url(`${P}-ep`)).send(body);

    expect((await save({ currentTime: 560, duration: 600 })).status).toBe(200);
    expect((await row()).isFinished).toBe(false);

    const near = await save({ currentTime: 570, duration: 600 });
    expect(near.body.progress.isFinished).toBe(true);
    expect((await row()).isFinished).toBe(true);

    // No length sent: a stored or feed length may be short of the audio, so nothing is decided from it.
    await save({ currentTime: 30, duration: 600 });
    expect((await row()).isFinished).toBe(false);
    await save({ currentTime: 590 });
    expect((await row()).isFinished).toBe(false);
    await save({ currentTime: 600, isFinished: true });
    expect((await row()).isFinished).toBe(true);
});
