/**
 * Podcast discovery answers from Apple's categories and charts (recorded replies), never keyword searches:
 * the category list, a category's chart, "for you" rows from what the user follows, and similar shows.
 * Real router, database and Redis.
 */
jest.mock("../../middleware/auth", () => require("./helpers/podcastRoute").podcastAuthMock("u_poddisc"));

import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import * as catalog from "../../services/podcastCatalog";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { loadRecording, startReplayServer, type ReplayServer } from "../../__tests__/helpers/replayServer";

const recording = loadRecording("apple", "catalog");
const app = express();
app.use(express.json());
app.use("/podcasts", podcastRoutes);

const USER = "u_poddisc";
const SHOW = "pod_disc_dnd";
const DND = "1450241676";
let replay: ReplayServer;

beforeAll(async () => {
    replay = await startReplayServer(recording);
    process.env.ITUNES_BASE_URL = replay.url;
    await waitForRedisReady();
    const keys = await redisClient.keys("podcasts:*");
    if (keys.length > 0) await redisClient.del(...keys);
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    await prisma.podcast.deleteMany({ where: { id: SHOW } });
    await prisma.podcast.create({
        data: {
            id: SHOW,
            feedUrl: "https://feeds.example.invalid/disc-dnd",
            title: "Dungeons and Daddies",
            itunesId: DND,
            categoryIds: [1495],
            subscriptions: { create: { userId: USER } },
        },
    });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: SHOW } });
    await prisma.user.deleteMany({ where: { id: USER } });
    delete process.env.ITUNES_BASE_URL;
    await replay.close();
});

it("lists Apple's categories with their parents", async () => {
    const res = await request(app).get("/podcasts/categories");
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({ id: 1486, name: "Comedy Fiction", parentId: 1483 });
});

it("answers a category's chart, paged, with categories named", async () => {
    const res = await request(app).get("/podcasts/charts?category=1495&limit=5&offset=0");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[0]).toMatchObject({ chartRank: 1, isExternal: true, genres: ["Improv"], categoryIds: [1495] });
    const next = await request(app).get("/podcasts/charts?category=1495&limit=5&offset=5");
    expect(next.body[0].chartRank).toBe(6);
});

it("answers a category row's background request with the same chart, and refuses a flag that is not true or false", async () => {
    const row = await request(app).get("/podcasts/charts?category=1495&limit=5&background=true");
    expect(row.status).toBe(200);
    const plain = await request(app).get("/podcasts/charts?category=1495&limit=5");
    expect(row.body).toEqual(plain.body);
    expect((await request(app).get("/podcasts/charts?category=1495&background=yes")).status).toBe(400);
});

it("refuses a category that is not an id", async () => {
    expect((await request(app).get("/podcasts/charts?category=comedy")).status).toBe(400);
});

it("answers the discover top and genres endpoints from the charts", async () => {
    const top = await request(app).get("/podcasts/discover/top?limit=3");
    expect(top.status).toBe(200);
    expect(top.body.map((p: any) => p.chartRank)).toEqual([1, 2, 3]);
    const genres = await request(app).get("/podcasts/discover/genres?genres=1495");
    expect(genres.body["1495"]).toHaveLength(10);
});

it("builds 'for you' from the followed show's category, without the show itself", async () => {
    const res = await request(app).get("/podcasts/for-you");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toEqual({ id: 1495, name: "Improv", parentId: 1303 });
    expect(res.body[0].because).toEqual(["Dungeons and Daddies"]);
    expect(res.body[0].podcasts.some((p: any) => p.itunesId === DND)).toBe(false);
    expect(res.body[0].podcasts.length).toBe(12);
});

it("finds similar shows on the show's own category chart, closest category list first, never the show", async () => {
    const res = await request(app).get(`/podcasts/${SHOW}/similar`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(12);
    expect(res.body.some((p: any) => p.itunesId === DND)).toBe(false);
    // The show is tagged Improv only, so the closest are the shows whose own category list (Apple's, from the
    // recorded batched lookup) is Improv plus the fewest others: shared categories over all categories.
    const onChart = (await catalog.chart(1495)).filter((p) => p.itunesId !== DND);
    const shows = await catalog.lookupShows(onChart.map((p) => p.itunesId));
    const closeness = (id: string) => {
        const own = shows.get(id)!.categoryIds;
        return (own.includes(1495) ? 1 : 0) / new Set([...own, 1495]).size;
    };
    const returned = res.body.map((p: any) => closeness(p.itunesId));
    expect(returned).toEqual([...returned].sort((a, b) => b - a));
    // Not just the chart's top: a show high on it but tagged with more besides (Not Another D&D Podcast: Games,
    // Leisure) gives way to closer ones further down.
    const passedOver = onChart.slice(0, 12).filter((p) => !res.body.some((r: any) => r.itunesId === p.itunesId));
    expect(passedOver.length).toBeGreaterThan(0);
    for (const p of passedOver) expect(closeness(p.itunesId)).toBeLessThan(Math.min(...returned));
});

it("answers 404 for a similar request on a show it does not have", async () => {
    expect((await request(app).get("/podcasts/no_such_show/similar")).status).toBe(404);
});

it("finds similar shows for a show not followed yet, by its Apple id, as for a followed show, never the show", async () => {
    const res = await request(app).get(`/podcasts/preview/${DND}/similar`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(12);
    expect(res.body.some((p: any) => p.itunesId === DND)).toBe(false);
    const show = (await catalog.lookupShows([DND])).get(DND)!;
    expect(show.categoryIds.length).toBeGreaterThan(1);
    expect(res.body).toEqual(await catalog.similarShows(show));
});

it("answers 404 for a preview, its snippet or its similar shows when the Apple id is not a number", async () => {
    for (const path of ["/podcasts/preview/pod_disc_dnd", "/podcasts/preview/pod_disc_dnd/snippet", "/podcasts/preview/pod_disc_dnd/similar"]) {
        const res = await request(app).get(path);
        expect([path, res.status, res.body.error]).toEqual([path, 404, "Podcast not found"]);
    }
});
