/**
 * POST /podcasts/subscribe finds a stored show by either of its keys (Apple can give a show a new feed address),
 * follows once however often it is asked, and survives two follows of a new show at once. Real router and
 * database; a local server plays the feed, so the address check is stubbed to let 127.0.0.1 through.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_podsub", username: "t" }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: "u_podsub", username: "t" }; next(); },
}));
jest.mock("../../utils/ssrf", () => ({
    ...jest.requireActual("../../utils/ssrf"),
    validateUrlForFetch: jest.fn().mockResolvedValue(null),
}));

import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";

const USER = "u_podsub";
const STORED = "pod_sub_stored";
const app = express();
app.use(express.json());
app.use("/podcasts", podcastRoutes);

let feedHost: http.Server;
let feedBase = "";
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Race Show</title><description>d</description>
<item><title>Ep 1</title><guid>race-1</guid><pubDate>Mon, 13 Oct 2026 10:00:00 GMT</pubDate>
<enclosure url="https://cdn.example.invalid/1.mp3" length="1000" type="audio/mpeg"/></item></channel></rss>`;

const cleanup = async () => {
    await prisma.podcast.deleteMany({ where: { OR: [{ id: STORED }, { feedUrl: { startsWith: feedBase || "http://127.0.0.1" } }] } });
};

beforeAll(async () => {
    feedHost = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(FEED);
    });
    await new Promise<void>((ok) => feedHost.listen(0, "127.0.0.1", () => ok()));
    feedBase = `http://127.0.0.1:${(feedHost.address() as AddressInfo).port}`;
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
});

beforeEach(async () => {
    await cleanup();
    await prisma.podcast.create({
        data: { id: STORED, feedUrl: "https://old-host.example.invalid/feed", title: "Stored Show", itunesId: "1450241676" },
    });
});

afterAll(async () => {
    await cleanup();
    await prisma.user.deleteMany({ where: { id: USER } });
    await new Promise<void>((ok) => feedHost.close(() => ok()));
});

it("follows a stored show found by its Apple id, though its feed address has changed", async () => {
    const res = await request(app).post("/podcasts/subscribe").send({ itunesId: 1450241676, feedUrl: "https://new-host.example.invalid/feed" });
    expect(res.status).toBe(200);
    expect(res.body.podcast.id).toBe(STORED);
    expect(await prisma.podcast.count({ where: { itunesId: "1450241676" } })).toBe(1);
    expect(await prisma.podcastSubscription.count({ where: { userId: USER, podcastId: STORED } })).toBe(1);
});

it("follows once however often it is asked", async () => {
    const first = await request(app).post("/podcasts/subscribe").send({ itunesId: "1450241676" });
    const again = await request(app).post("/podcasts/subscribe").send({ itunesId: "1450241676" });
    expect([first.body.message, again.body.message]).toEqual(["Subscribed successfully", "Already subscribed"]);
    expect(await prisma.podcastSubscription.count({ where: { userId: USER, podcastId: STORED } })).toBe(1);
});

it("survives two follows of a new show at once: one show stored, both answered", async () => {
    const feedUrl = `${feedBase}/race.xml`;
    const [a, b] = await Promise.all([
        request(app).post("/podcasts/subscribe").send({ feedUrl }),
        request(app).post("/podcasts/subscribe").send({ feedUrl }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.podcast.id).toBe(b.body.podcast.id);
    expect(await prisma.podcast.count({ where: { feedUrl } })).toBe(1);
    expect(await prisma.podcastSubscription.count({ where: { userId: USER, podcastId: a.body.podcast.id } })).toBe(1);
});
