/**
 * getPodcasts gives `originalImageUrl` only when the stored picture is a full http or https address an app can load.
 * Any other value (a path, `native:`, `file:`, no scheme) is left out, as the artist and album image fields are.
 * Real router and the suite database.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { podcastRouter } from "../podcasts";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const P = "zzpimg";
const USER = `${P}-user`;

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", podcastRouter);

async function cleanup() {
    await prisma.podcast.deleteMany({ where: { feedUrl: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

const IMAGES: Record<string, string | null> = {
    web: "https://images.example/show.jpg",
    plain: "http://images.example/show.jpg",
    upper: "HTTPS://images.example/show.jpg",
    native: "native:covers/show.jpg",
    file: "file:///etc/passwd",
    path: "/covers/show.jpg",
    bare: "images.example/show.jpg",
    scripted: "javascript:alert(1)",
    none: null,
};

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    for (const [key, imageUrl] of Object.entries(IMAGES)) {
        const podcast = await prisma.podcast.create({
            data: { feedUrl: `${P}-${key}`, title: `${P} ${key}`, imageUrl },
        });
        await prisma.podcastSubscription.create({ data: { userId: USER, podcastId: podcast.id } });
    }
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

async function shown(): Promise<Record<string, string | undefined>> {
    const res = await request(app).get("/getPodcasts.view").query({ f: "json", includeEpisodes: "false" }).expect(200);
    const channels: any[] = [res.body["subsonic-response"].podcasts.channel].flat();
    return Object.fromEntries(channels.map((c) => [c.url.slice(P.length + 1), c.originalImageUrl]));
}

describe("getPodcasts originalImageUrl", () => {
    it("is given for an http or https address", async () => {
        const got = await shown();
        expect(got.web).toBe(IMAGES.web);
        expect(got.plain).toBe(IMAGES.plain);
        expect(got.upper).toBe(IMAGES.upper);
    });

    it("is left out for anything else", async () => {
        const got = await shown();
        for (const key of ["native", "file", "path", "bare", "scripted", "none"]) {
            expect([key, got[key]]).toEqual([key, undefined]);
        }
    });
});
