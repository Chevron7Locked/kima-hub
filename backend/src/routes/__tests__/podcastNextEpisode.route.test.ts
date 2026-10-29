/**
 * GET /podcasts/:podcastId/episodes/:episodeId/next: after an episode, the show's next one by release date that
 * this user has not finished, whatever order a page lists them in; none at the show's end. Real router and database.
 */
jest.mock("../../middleware/auth", () => require("./helpers/podcastRoute").podcastAuthMock("u_podnext"));

import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";
import { episodeOnDay } from "./helpers/podcastRoute";

const USER = "u_podnext";
const SHOW = "pod_next_show";
const OTHER = "pod_next_other";
const app = express();
app.use("/podcasts", podcastRoutes);
const next = (episodeId: string, show = SHOW) => request(app).get(`/podcasts/${show}/episodes/${episodeId}/next`);

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: [SHOW, OTHER] } } });
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    await prisma.podcast.create({
        data: {
            id: SHOW, feedUrl: "https://f.invalid/next", title: "Next Show",
            episodes: { create: [episodeOnDay("nx_14", 1), episodeOnDay("nx_15", 8), episodeOnDay("nx_16", 15), episodeOnDay("nx_17", 22), episodeOnDay("nx_18", 29)] },
        },
    });
    await prisma.podcast.create({ data: { id: OTHER, feedUrl: "https://f.invalid/other", title: "Other", episodes: { create: [episodeOnDay("nx_other", 9)] } } });
    await prisma.podcastProgress.createMany({
        data: [
            { userId: USER, episodeId: "nx_16", currentTime: 600, duration: 600, isFinished: true },
            { userId: USER, episodeId: "nx_17", currentTime: 120, duration: 600, isFinished: false },
        ],
    });
});

afterAll(async () => {
    await prisma.playbackState.deleteMany({ where: { userId: USER } });
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

it("unfollowing a show forgets that it was playing, so no device restores it; other playback stays", async () => {
    await prisma.podcastSubscription.createMany({ data: [{ userId: USER, podcastId: SHOW }, { userId: USER, podcastId: OTHER }], skipDuplicates: true });
    await prisma.playbackState.upsert({
        where: { userId: USER },
        create: { userId: USER, playbackType: "podcast", podcastId: `${SHOW}:nx_15` },
        update: { playbackType: "podcast", podcastId: `${SHOW}:nx_15` },
    });

    expect((await request(app).delete(`/podcasts/${OTHER}/unsubscribe`)).status).toBe(200);
    expect(await prisma.playbackState.findUnique({ where: { userId: USER } })).not.toBeNull();

    expect((await request(app).delete(`/podcasts/${SHOW}/unsubscribe`)).status).toBe(200);
    expect(await prisma.playbackState.findUnique({ where: { userId: USER } })).toBeNull();
});
