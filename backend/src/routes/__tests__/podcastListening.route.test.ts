/**
 * GET /podcasts/listening: across the shows a user follows, episodes in progress (latest played first) and each
 * show's newest episode while unplayed; shows they don't follow and played episodes stay out. Real router and database.
 */
jest.mock("../../middleware/auth", () => require("./helpers/podcastRoute").podcastAuthMock("u_podlisten"));

import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";
import { episodeOnDay } from "./helpers/podcastRoute";

const app = express();
app.use(express.json());
app.use("/podcasts", podcastRoutes);

const USER = "u_podlisten";
const FOLLOWED = "pod_listen_followed";
const OTHER = "pod_listen_other";
const SECOND = "pod_listen_second";
const CAUGHT_UP = "pod_listen_caught_up";
const SHOWS = [FOLLOWED, OTHER, SECOND, CAUGHT_UP];

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: SHOWS } } });
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    await prisma.podcast.create({
        data: {
            id: FOLLOWED, feedUrl: "https://feeds.example.invalid/listen-1", title: "Followed Show",
            episodes: { create: [episodeOnDay("ep_new", 10), episodeOnDay("ep_half", 5), episodeOnDay("ep_done", 1)] },
            subscriptions: { create: { userId: USER } },
        },
    });
    await prisma.podcast.create({
        data: { id: OTHER, feedUrl: "https://feeds.example.invalid/listen-2", title: "Not Followed", episodes: { create: [episodeOnDay("ep_other", 12)] } },
    });
    await prisma.podcast.create({
        data: {
            id: SECOND, feedUrl: "https://feeds.example.invalid/listen-3", title: "Second Show",
            episodes: { create: [episodeOnDay("ep_second_new", 11), episodeOnDay("ep_second_old", 8)] },
            subscriptions: { create: { userId: USER } },
        },
    });
    await prisma.podcast.create({
        data: {
            id: CAUGHT_UP, feedUrl: "https://feeds.example.invalid/listen-4", title: "Caught Up",
            episodes: { create: [episodeOnDay("ep_caught_latest", 9), episodeOnDay("ep_caught_old", 2)] },
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
