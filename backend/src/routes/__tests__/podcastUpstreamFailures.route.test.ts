/**
 * When Apple or a podcast host misbehaves, Kima answers with what happened, never a 500, and never remembers a bad
 * reply: an Apple 4xx is "not found", an outage or a reply that is not what was asked for is a bad gateway and is
 * not cached, an unknown category is a 404 before Apple is asked, and a host's 4xx on a stream or sample is a 404.
 * Real router, database and Redis; a local server plays Apple and the host.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_podfail", username: "t" }; next(); },
    requireAuthOrToken: (req: any, _res: any, next: any) => { req.user = { id: "u_podfail", username: "t" }; next(); },
}));
jest.mock("../../utils/ssrf", () => ({
    ...jest.requireActual("../../utils/ssrf"),
    validateUrlForFetch: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../services/podcastDownload", () => ({
    ...jest.requireActual("../../services/podcastDownload"),
    getCachedFilePath: jest.fn().mockResolvedValue(null),
    downloadInBackground: jest.fn(),
}));

import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { AppleReplyError, chart, lookupShows } from "../../services/podcastCatalog";
import { proxyPreviewStream } from "../../utils/previewProxy";

type Reply = { status: number; body: string; type?: string };
const replies = new Map<string, Reply[]>();
const answer = (path: string, ...r: Reply[]) => replies.set(path, r);
const json = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body), type: "application/json" });
const TREE = json({ "26": { subgenres: { "1303": { name: "Comedy", subgenres: { "1495": { name: "Improv" } } } } } });
const entry = (id: string) => ({ id: { attributes: { "im:id": id } }, "im:name": { label: `Show ${id}` }, "im:artist": { label: "A" }, "im:image": [] });

let host: http.Server;
let base = "";
const app = express();
app.use("/podcasts", podcastRoutes);
app.get("/preview-proxy", (_req, res) => proxyPreviewStream(res, `${base}/forbidden.mp3`, { notFoundMessage: "No preview", logLabel: "t" }));

beforeAll(async () => {
    host = http.createServer((req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if (path === "/forbidden.mp3") {
            res.writeHead(403);
            return res.end("forbidden");
        }
        const queue = replies.get(path) ?? [];
        const r = queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 404, body: "" };
        res.writeHead(r.status, { "Content-Type": r.type ?? "text/html" });
        res.end(r.body);
    });
    await new Promise<void>((ok) => host.listen(0, "127.0.0.1", () => ok()));
    base = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    process.env.ITUNES_BASE_URL = base;
    await waitForRedisReady();
    await prisma.podcast.deleteMany({ where: { id: "pod_fail" } });
    await prisma.podcast.create({
        data: {
            id: "pod_fail", feedUrl: "https://feeds.example.invalid/fail", title: "Fail Show",
            episodes: { create: [{ id: "pod_fail_ep", guid: "f1", title: "Ep", audioUrl: `${base}/forbidden.mp3`, duration: 60, publishedAt: new Date() }] },
        },
    });
});

beforeEach(async () => {
    replies.clear();
    const keys = await redisClient.keys("podcasts:*");
    if (keys.length) await redisClient.del(...keys);
});

afterAll(async () => {
    delete process.env.ITUNES_BASE_URL;
    await prisma.podcast.deleteMany({ where: { id: "pod_fail" } });
    await new Promise<void>((ok) => host.close(() => ok()));
});

describe("the catalogue never caches a reply that is not what was asked for", () => {
    it("a chart that comes back as an error page fails, and the next good reply is used", async () => {
        answer("/us/rss/toppodcasts/limit=200/genre=1495/json", { status: 200, body: "<html>busy</html>" }, json({ feed: { entry: [entry("1"), entry("2")] } }));
        await expect(chart(1495)).rejects.toBeInstanceOf(AppleReplyError);
        expect((await chart(1495)).map((p) => p.itunesId)).toEqual(["1", "2"]);
    });

    it("reads a chart of one show, which Apple sends as an object", async () => {
        answer("/us/rss/toppodcasts/limit=200/genre=1495/json", json({ feed: { entry: entry("7") } }));
        expect((await chart(1495)).map((p) => p.itunesId)).toEqual(["7"]);
    });

    it("a lookup without a results list fails instead of marking every show unknown for a week", async () => {
        answer("/lookup", json({ errorMessage: "throttled" }), json({ resultCount: 1, results: [{ kind: "podcast", collectionId: 5, feedUrl: "https://f.example.invalid/5", genreIds: ["1495"] }] }));
        await expect(lookupShows(["5"])).rejects.toBeInstanceOf(AppleReplyError);
        expect((await lookupShows(["5"])).get("5")?.feedUrl).toBe("https://f.example.invalid/5");
    });
});

describe("routes answer with what happened", () => {
    it("an unknown category is a 404, without asking for its chart", async () => {
        answer("/WebObjects/MZStoreServices.woa/ws/genres", TREE);
        expect((await request(app).get("/podcasts/charts?category=999999")).status).toBe(404);
        expect((await request(app).get("/podcasts/discover/genre/999999")).status).toBe(404);
    });

    it("an Apple 4xx is a 404 and a garbled reply is a 502, never a 500", async () => {
        answer("/WebObjects/MZStoreServices.woa/ws/genres", TREE);
        answer("/us/rss/toppodcasts/limit=200/genre=1495/json", { status: 403, body: "no" });
        expect((await request(app).get("/podcasts/charts?category=1495")).status).toBe(404);
        answer("/us/rss/toppodcasts/limit=200/json", { status: 200, body: "<html>maintenance</html>" });
        expect((await request(app).get("/podcasts/charts")).status).toBe(502);
    });

    it("a host refusing an episode or a sample is a 404", async () => {
        expect((await request(app).get("/podcasts/pod_fail/episodes/pod_fail_ep/stream").set("Range", "bytes=0-")).status).toBe(404);
        expect((await request(app).get("/preview-proxy")).status).toBe(404);
    });
});
