// Podcast art is the feed's own image everywhere a show or episode is listed: the shows list, a show's detail and its
// episodes, the new-episodes feed and the next episode. Kima keeps no cover copies (removed in 1.11); a cover link
// handed out before 1.12 and still saved in a player goes to the feed's image. Real database, real token.

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
const SHOW = "https://example.invalid/show.jpg";
const EPISODE = "https://example.invalid/episode.jpg";

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.podcast.create({
        data: { id: `${P}-show`, feedUrl: `https://example.invalid/${P}`, title: `${P} show`, imageUrl: SHOW },
    });
    for (const n of [1, 2]) {
        await prisma.podcastEpisode.create({
            data: {
                id: `${P}-ep${n}`, podcastId: `${P}-show`, guid: `${P}-ep${n}`, title: `${P} episode ${n}`,
                audioUrl: `https://example.invalid/${n}.mp3`, duration: 600, publishedAt: new Date(Date.UTC(2026, 9, n)), imageUrl: EPISODE,
            },
        });
    }
    await prisma.podcastSubscription.create({ data: { userId: USER, podcastId: `${P}-show` } });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("gives the feed's image for the show and its episodes in the list, the detail and the next episode", async () => {
    const list = await request(app()).get("/podcasts").set("Authorization", auth);
    expect(list.status).toBe(200);
    const listed = (list.body as { id: string; coverUrl: string; episodes: { coverUrl: string }[] }[]).find((p) => p.id === `${P}-show`)!;
    expect(listed.coverUrl).toBe(SHOW);
    expect(listed.episodes.map((e) => e.coverUrl)).toEqual([EPISODE, EPISODE]);

    const detail = await request(app()).get(`/podcasts/${P}-show`).set("Authorization", auth);
    expect(detail.status).toBe(200);
    expect(detail.body.coverUrl).toBe(SHOW);

    const next = await request(app()).get(`/podcasts/${P}-show/episodes/${P}-ep1/next`).set("Authorization", auth);
    expect(next.status).toBe(200);
    expect([next.body.podcast.coverUrl, next.body.episode.coverUrl]).toEqual([SHOW, EPISODE]);
});

/** Where an old cover link should send the image: Kima's proxy for the feed's image (this test mounts at /podcasts). */
const proxied = (url: string, token?: string) =>
    `/library/cover-art?${new URLSearchParams(token ? { url, token } : { url })}`;

it("sends a cover link saved from before 1.12 to the feed's image through Kima's image proxy", async () => {
    const show = await request(app()).get(`/podcasts/${P}-show/cover`).set("Authorization", auth);
    expect([show.status, show.headers.location]).toEqual([302, proxied(SHOW)]);
    const episode = await request(app()).get(`/podcasts/episodes/${P}-ep1/cover`).set("Authorization", auth);
    expect([episode.status, episode.headers.location]).toEqual([302, proxied(EPISODE)]);
});

it("carries an image token on to the proxy, as an <img> link sends it", async () => {
    const token = auth.slice("Bearer ".length);
    const res = await request(app()).get(`/podcasts/${P}-show/cover?token=${encodeURIComponent(token)}`);
    expect([res.status, res.headers.location]).toEqual([302, proxied(SHOW, token)]);
});

it("404s a show or episode it does not know, or one with no image, and refuses a request with no session", async () => {
    await prisma.podcast.create({ data: { id: `${P}-bare`, feedUrl: `https://example.invalid/${P}/bare`, title: `${P} bare` } });
    for (const path of [`${P}-nope/cover`, `episodes/${P}-nope/cover`, `${P}-bare/cover`]) {
        expect([path, (await request(app()).get(`/podcasts/${path}`).set("Authorization", auth)).status]).toEqual([path, 404]);
    }
    expect((await request(app()).get(`/podcasts/${P}-show/cover`)).status).toBe(401);
});
