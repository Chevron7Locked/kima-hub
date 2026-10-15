/**
 * Podcast discovery answers from Apple's categories and charts (recorded replies), never keyword searches:
 * the category list, a category's chart, "for you" rows from what the user follows, and similar shows.
 * Real router, database and Redis.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_poddisc", username: "t" }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: "u_poddisc", username: "t" }; next(); },
}));

import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { startMusicBrainzReplay, type RecordedReplies, type ReplayServer } from "../../__tests__/helpers/musicbrainzReplay";

const recording: RecordedReplies = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "__tests__", "fixtures", "apple", "catalog.json"), "utf8")
);
const app = express();
app.use(express.json());
app.use("/podcasts", podcastRoutes);

const USER = "u_poddisc";
const SHOW = "pod_disc_dnd";
const DND = "1450241676";
let replay: ReplayServer;

beforeAll(async () => {
    replay = await startMusicBrainzReplay(recording);
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

it("refuses a category that is not an id", async () => {
    expect((await request(app).get("/podcasts/charts?category=comedy")).status).toBe(400);
});

it("keeps the old discover endpoints answering from the charts", async () => {
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

it("finds similar shows on the show's own category chart, never the show", async () => {
    const res = await request(app).get(`/podcasts/${SHOW}/similar`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(12);
    expect(res.body.some((p: any) => p.itunesId === DND)).toBe(false);
    expect(res.body[0].genres).toEqual(["Improv"]);
});

it("answers 404 for a similar request on a show it does not have", async () => {
    expect((await request(app).get("/podcasts/no_such_show/similar")).status).toBe(404);
});
