/**
 * GET /podcasts/listening: across the shows a user follows, episodes in progress (latest played first) and each
 * show's newest episode while unplayed; shows they don't follow and played episodes stay out. Real router and database.
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
const SECOND = "pod_listen_second";
const CAUGHT_UP = "pod_listen_caught_up";
const SHOWS = [FOLLOWED, OTHER, SECOND, CAUGHT_UP];
const ep = (id: string, day: number) => ({ id, guid: id, title: id, audioUrl: `https://a.invalid/${id}.mp3`, duration: 600, publishedAt: new Date(Date.UTC(2026, 9, day)) });

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: SHOWS } } });
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
    await prisma.podcast.create({
        data: {
            id: SECOND, feedUrl: "https://feeds.example.invalid/listen-3", title: "Second Show",
            episodes: { create: [ep("ep_second_new", 11), ep("ep_second_old", 8)] },
            subscriptions: { create: { userId: USER } },
        },
    });
    await prisma.podcast.create({
        data: {
            id: CAUGHT_UP, feedUrl: "https://feeds.example.invalid/listen-4", title: "Caught Up",
            episodes: { create: [ep("ep_caught_latest", 9), ep("ep_caught_old", 2)] },
            subscriptions: { create: { userId: USER } },
        },
    });
    await prisma.podcastProgress.createMany({
        data: [
            { userId: USER, episodeId: "ep_half", currentTime: 300, duration: 600, isFinished: false, lastPlayedAt: new Date(Date.UTC(2026, 9, 13)) },
            // Played more recently, so it leads the in-progress row.
            { userId: USER, episodeId: "ep_second_old", currentTime: 60, duration: 600, isFinished: false, lastPlayedAt: new Date(Date.UTC(2026, 9, 14)) },
            { userId: USER, episodeId: "ep_done", currentTime: 600, duration: 600, isFinished: true },
            { userId: USER, episodeId: "ep_caught_latest", currentTime: 600, duration: 600, isFinished: true },
        ],
    });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: SHOWS } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

it("lists what is in progress and what is new, only from followed shows", async () => {
    const res = await request(app).get("/podcasts/listening");
    expect(res.status).toBe(200);
    expect(res.body.inProgress.map((r: any) => r.episode.id)).toEqual(["ep_second_old", "ep_half"]);
    expect(res.body.inProgress[1].episode.progress.progress).toBe(50);
    expect(res.body.inProgress[1].podcast).toMatchObject({ id: FOLLOWED, title: "Followed Show" });
    // One per show, its newest, newest first; a show whose newest is already played offers nothing older.
    expect(res.body.newEpisodes.map((r: any) => r.episode.id)).toEqual(["ep_second_new", "ep_new"]);
});
