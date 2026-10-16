/**
 * GET /podcasts/:podcastId/episodes/:episodeId/next: after an episode, the show's next one by release date that
 * this user has not finished, whatever order a page lists them in; none at the show's end. Real router and database.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_podnext", username: "t" }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: "u_podnext", username: "t" }; next(); },
}));

import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";

const USER = "u_podnext";
const SHOW = "pod_next_show";
const OTHER = "pod_next_other";
const app = express();
app.use("/podcasts", podcastRoutes);
const ep = (id: string, day: number) => ({ id, guid: id, title: id, audioUrl: `https://a.invalid/${id}.mp3`, duration: 600, publishedAt: new Date(Date.UTC(2026, 9, day)) });
const next = (episodeId: string, show = SHOW) => request(app).get(`/podcasts/${show}/episodes/${episodeId}/next`);

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: [SHOW, OTHER] } } });
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    await prisma.podcast.create({
        data: {
            id: SHOW, feedUrl: "https://f.invalid/next", title: "Next Show",
            episodes: { create: [ep("nx_14", 1), ep("nx_15", 8), ep("nx_16", 15), ep("nx_17", 22), ep("nx_18", 29)] },
        },
    });
    await prisma.podcast.create({ data: { id: OTHER, feedUrl: "https://f.invalid/other", title: "Other", episodes: { create: [ep("nx_other", 9)] } } });
    await prisma.podcastProgress.createMany({
        data: [
            { userId: USER, episodeId: "nx_16", currentTime: 600, duration: 600, isFinished: true },
            { userId: USER, episodeId: "nx_17", currentTime: 120, duration: 600, isFinished: false },
        ],
    });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: [SHOW, OTHER] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

it("is the episode released after this one, never an older one", async () => {
    const res = await next("nx_14");
    expect(res.status).toBe(200);
    expect(res.body.episode.id).toBe("nx_15");
    expect(res.body.podcast).toMatchObject({ id: SHOW, title: "Next Show" });
});

it("skips an episode already finished, and resumes one part-way through where it was left", async () => {
    const res = await next("nx_15");
    expect(res.body.episode.id).toBe("nx_17");
    expect(res.body.episode.progress.currentTime).toBe(120);
});

it("is none after the show's newest episode", async () => {
    const res = await next("nx_18");
    expect(res.status).toBe(200);
    expect(res.body.episode).toBeNull();
});

it("answers 404 for an episode that is not the show's", async () => {
    expect((await next("nx_other")).status).toBe(404);
    expect((await next("no_such_episode")).status).toBe(404);
});
