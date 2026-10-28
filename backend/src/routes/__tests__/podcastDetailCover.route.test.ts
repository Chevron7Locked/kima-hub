// A followed show's detail page gives the same cover as the shows list: the cached copy when Kima has one, the feed's
// image otherwise. Real database, real token.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import podcastRoutes from "../podcasts";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-pod-cover";
const USER = `${P}-user`;
const auth = `Bearer ${generateToken({ id: USER, username: USER, role: "user", tokenVersion: 0 })}`;
const app = () => express().use(express.json()).use("/podcasts", podcastRoutes);

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    for (const [key, localCoverPath] of [["cached", `${P}/cover.jpg`], ["feedonly", null]] as const) {
        await prisma.podcast.create({
            data: { id: `${P}-${key}`, feedUrl: `https://example.invalid/${P}/${key}`, title: `${P} ${key}`, imageUrl: `https://example.invalid/${key}.jpg`, localCoverPath },
        });
        await prisma.podcastSubscription.create({ data: { userId: USER, podcastId: `${P}-${key}` } });
    }
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("detail and list agree on each show's cover", async () => {
    const list = await request(app()).get("/podcasts").set("Authorization", auth);
    expect(list.status).toBe(200);
    const listed = new Map((list.body as { id: string; coverUrl: string }[]).map((p) => [p.id, p.coverUrl]));

    for (const [key, expected] of [["cached", `/podcasts/${P}-cached/cover`], ["feedonly", "https://example.invalid/feedonly.jpg"]]) {
        const detail = await request(app()).get(`/podcasts/${P}-${key}`).set("Authorization", auth);
        expect(detail.status).toBe(200);
        expect([key, detail.body.coverUrl]).toEqual([key, expected]);
        expect(listed.get(`${P}-${key}`)).toBe(expected);
    }
});
