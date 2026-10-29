/**
 * GET /podcasts lists the shows a user follows, each with when it last published, so the page can sort by it.
 * Real router and database.
 */
jest.mock("../../middleware/auth", () => require("./helpers/podcastRoute").podcastAuthMock("u_podlist"));

import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";

const USER = "u_podlist";
const SHOWS = ["pod_list_old", "pod_list_new", "pod_list_empty"];
const app = express();
app.use("/podcasts", podcastRoutes);

const episode = (id: string, publishedAt: string) => ({ id, guid: id, title: id, audioUrl: `https://a.invalid/${id}.mp3`, duration: 60, publishedAt: new Date(publishedAt) });

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: SHOWS } } });
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    await prisma.podcast.create({
        data: { id: "pod_list_old", feedUrl: "https://f.invalid/old", title: "Old", episodes: { create: [episode("pl_o1", "2026-01-01T00:00:00Z"), episode("pl_o2", "2026-03-01T00:00:00Z")] } },
    });
    await prisma.podcast.create({
        data: { id: "pod_list_new", feedUrl: "https://f.invalid/new", title: "New", episodes: { create: [episode("pl_n1", "2026-10-01T00:00:00Z")] } },
    });
    await prisma.podcast.create({ data: { id: "pod_list_empty", feedUrl: "https://f.invalid/empty", title: "Empty" } });
    for (const podcastId of SHOWS) await prisma.podcastSubscription.create({ data: { userId: USER, podcastId } });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { in: SHOWS } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

it("gives each followed show the date of its newest episode, none for a show without episodes", async () => {
    const res = await request(app).get("/podcasts");
    expect(res.status).toBe(200);
    const latest = Object.fromEntries(res.body.map((p: { id: string; latestEpisodeAt: string | null }) => [p.id, p.latestEpisodeAt]));
    expect(latest).toEqual({
        pod_list_old: "2026-03-01T00:00:00.000Z",
        pod_list_new: "2026-10-01T00:00:00.000Z",
        pod_list_empty: null,
    });
});
