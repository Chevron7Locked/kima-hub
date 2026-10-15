/**
 * Shows and episodes are each user's own: a search finds only those of the shows the user follows, by full text
 * and by the plain fallback, and one user's cached answer never reaches another. Real database and Redis.
 */
jest.mock("../../middleware/auth", () => {
    // Requests come from B, the user who does not follow the show at first.
    const asB = (req: any, _res: any, next: any) => { req.user = { id: "zz-followsearch-b", username: "b" }; next(); };
    return { requireAuth: asB, requireAuthOrToken: asB };
});

import express from "express";
import request from "supertest";
import podcastRoutes from "../../routes/podcasts";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { searchService } from "../search";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-followsearch";
const A = `${P}-a`;
const B = `${P}-b`;

beforeAll(async () => {
    for (const id of [A, B]) await prisma.user.upsert({ where: { id }, create: { id, username: id, passwordHash: "x" }, update: {} });
    await prisma.podcast.deleteMany({ where: { id: `${P}-show` } });
    await prisma.podcast.create({
        data: {
            id: `${P}-show`, feedUrl: `https://feeds.example.invalid/${P}`, title: "Wyvernquill Hour", author: "Wyvernquill",
            episodes: { create: [{ id: `${P}-ep`, guid: `${P}-ep`, title: "Wyvernquill returns", audioUrl: "https://a.invalid/1.mp3", duration: 60, publishedAt: new Date() }] },
            subscriptions: { create: { userId: A } },
        },
    });
    const keys = await redisClient.keys("search:*");
    if (keys.length) await redisClient.del(...keys);
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: `${P}-show` } });
    await prisma.user.deleteMany({ where: { id: { in: [A, B] } } });
    await closeEngineConnections();
});

const found = async (userId: string, query: string) => {
    const all = await searchService.searchAll({ query, limit: 10, userId });
    const shows = await searchService.searchByType({ query, type: "podcasts", limit: 10, userId });
    const episodes = await searchService.searchByType({ query, type: "episodes", limit: 10, userId });
    return {
        all: [...all.podcasts.map((p) => p.id), ...all.episodes.map((e) => e.id)],
        shows: shows.podcasts.map((p) => p.id),
        episodes: episodes.episodes.map((e) => e.id),
    };
};

it("finds a followed show and its episodes for the follower", async () => {
    expect(await found(A, "wyvernquill")).toEqual({ all: [`${P}-show`, `${P}-ep`], shows: [`${P}-show`], episodes: [`${P}-ep`] });
});

it("finds nothing of it for someone who does not follow it, though the follower's answer is cached", async () => {
    expect(await found(B, "wyvernquill")).toEqual({ all: [], shows: [], episodes: [] });
});

it("scopes the plain fallback the same way (a query full text search cannot use)", async () => {
    expect((await searchService.searchPodcasts({ query: "Wyvernquill Hour", userId: B })).map((p) => p.id)).toEqual([]);
    expect((await searchService.searchPodcasts({ query: "Wyvernquill Hour", userId: A })).map((p) => p.id)).toEqual([`${P}-show`]);
});

it("finds a show right after following it, and loses it right after removing it, though the earlier answer was cached", async () => {
    const app = express();
    app.use(express.json());
    app.use("/podcasts", podcastRoutes);
    expect((await found(B, "wyvernquill")).shows).toEqual([]);
    const followed = await request(app).post("/podcasts/subscribe").send({ feedUrl: `https://feeds.example.invalid/${P}` });
    expect(followed.status).toBe(200);
    expect(await found(B, "wyvernquill")).toEqual({ all: [`${P}-show`, `${P}-ep`], shows: [`${P}-show`], episodes: [`${P}-ep`] });
    expect((await request(app).delete(`/podcasts/${P}-show/unsubscribe`)).status).toBe(200);
    expect(await found(B, "wyvernquill")).toEqual({ all: [], shows: [], episodes: [] });
});
