/**
 * An episode is reached only through its own show: streaming it, saving its progress and clearing its progress
 * answer not-found when the episode id sits under another show's URL. Real router, real database; only the
 * episode cache is stood in for, so the stream is served from a local file instead of the feed's host.
 */
jest.mock("../../middleware/auth", () => require("./helpers/podcastRoute").podcastAuthMock("u_podshow"));

const cachedFile = require("path").join(require("os").tmpdir(), "kima-podcast-episode-show.mp3");
jest.mock("../../services/podcastDownload", () => ({
    getCachedFilePath: jest.fn().mockResolvedValue(cachedFile),
    downloadInBackground: jest.fn(),
    isDownloading: jest.fn().mockReturnValue(false),
}));

import fs from "fs";
import express from "express";
import request from "supertest";
import podcastRoutes from "../podcasts";
import { prisma } from "../../utils/db";
import { episodeOnDay } from "./helpers/podcastRoute";

const USER = "u_podshow";
const SHOW = "pod_show_own";
const OTHER_SHOW = "pod_show_other";
const EP = `${SHOW}-ep`;
const app = express();
app.use(express.json());
app.use("/podcasts", podcastRoutes);

const saveProgress = (show: string) =>
    request(app).post(`/podcasts/${show}/episodes/${EP}/progress`).send({ currentTime: 42, duration: 600 });
const progressRow = () => prisma.podcastProgress.findUnique({ where: { userId_episodeId: { userId: USER, episodeId: EP } } });

beforeAll(async () => {
    fs.writeFileSync(cachedFile, Buffer.from("episode audio"));
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
    await prisma.podcast.deleteMany({ where: { id: { in: [SHOW, OTHER_SHOW] } } });
    await prisma.podcast.create({
        data: { id: SHOW, feedUrl: "https://feeds.example.invalid/own", title: "Own", episodes: { create: [episodeOnDay(EP, 1)] } },
    });
    await prisma.podcast.create({
        data: { id: OTHER_SHOW, feedUrl: "https://feeds.example.invalid/other", title: "Other", episodes: { create: [episodeOnDay(`${OTHER_SHOW}-ep`, 1)] } },
    });
});

beforeEach(() => prisma.podcastProgress.deleteMany({ where: { userId: USER } }));

afterAll(async () => {
    fs.rmSync(cachedFile, { force: true });
    await prisma.podcastProgress.deleteMany({ where: { userId: USER } });
    await prisma.podcast.deleteMany({ where: { id: { in: [SHOW, OTHER_SHOW] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

describe("under its own show", () => {
    it("streams", async () => {
        const res = await request(app).get(`/podcasts/${SHOW}/episodes/${EP}/stream`);
        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe("episode audio");
    });

    it("saves progress", async () => {
        const res = await saveProgress(SHOW);
        expect(res.status).toBe(200);
        expect((await progressRow())?.currentTime).toBe(42);
    });

    it("clears progress", async () => {
        await saveProgress(SHOW);
        const res = await request(app).delete(`/podcasts/${SHOW}/episodes/${EP}/progress`);
        expect(res.status).toBe(200);
        expect(await progressRow()).toBeNull();
    });
});

describe("under another show's URL", () => {
    it("does not stream", async () => {
        const res = await request(app).get(`/podcasts/${OTHER_SHOW}/episodes/${EP}/stream`);
        expect(res.status).toBe(404);
    });

    it("does not save progress", async () => {
        const res = await saveProgress(OTHER_SHOW);
        expect(res.status).toBe(404);
        expect(await progressRow()).toBeNull();
    });

    it("does not clear progress", async () => {
        await saveProgress(SHOW);
        const res = await request(app).delete(`/podcasts/${OTHER_SHOW}/episodes/${EP}/progress`);
        expect(res.status).toBe(404);
        expect((await progressRow())?.currentTime).toBe(42);
    });
});
