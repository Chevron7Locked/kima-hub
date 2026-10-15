/**
 * GET /podcasts/listening: across the shows a user follows, episodes in progress (latest played first) and the
 * newest episodes not started; shows they don't follow and finished episodes stay out. Real router and database.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_podlisten", username: "t" }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: "u_podlisten", username: "t" }; next(); },
}));

import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";

const app = express();
app.use(express.json());
app.use("/podcasts", podcastRoutes);

const USER = "u_podlisten";
const FOLLOWED = "pod_listen_followed";
const OTHER = "pod_listen_other";
const ep = (id: string, day: number) => ({ id, guid: id, title: id, audioUrl: `https://a.invalid/${id}.mp3`, duration: 600, publishedAt: new Date(Date.UTC(2026, 9, day)) });

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: [FOLLOWED, OTHER] } } });
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    await prisma.podcast.create({
        data: {
            id: FOLLOWED, feedUrl: "https://feeds.example.invalid/listen-1", title: "Followed Show",
            episodes: { create: [ep("ep_new", 10), ep("ep_half", 5), ep("ep_done", 1)] },
            subscriptions: { create: { userId: USER } },
        },
    });
    await prisma.podcast.create({
        data: { id: OTHER, feedUrl: "https://feeds.example.invalid/listen-2", title: "Not Followed", episodes: { create: [ep("ep_other", 12)] } },
    });
    await prisma.podcastProgress.createMany({
        data: [
            { userId: USER, episodeId: "ep_half", currentTime: 300, duration: 600, isFinished: false },
            { userId: USER, episodeId: "ep_done", currentTime: 600, duration: 600, isFinished: true },
        ],
    });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: [FOLLOWED, OTHER] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

it("lists what is in progress and what is new, only from followed shows", async () => {
    const res = await request(app).get("/podcasts/listening");
    expect(res.status).toBe(200);
    expect(res.body.inProgress.map((r: any) => r.episode.id)).toEqual(["ep_half"]);
    expect(res.body.inProgress[0].episode.progress.progress).toBe(50);
    expect(res.body.inProgress[0].podcast).toMatchObject({ id: FOLLOWED, title: "Followed Show" });
    expect(res.body.newEpisodes.map((r: any) => r.episode.id)).toEqual(["ep_new"]);
});
