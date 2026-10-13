/**
 * The play-tracks endpoint answers one tap: the ordered queue for an artist's
 * Play All. The order is the canonical rule clients consume as-given — albums
 * by effective year (displayYear ?? year, missing last) descending, title
 * ascending, tracks by disc then number — and the payload stays lean: no
 * audioFeatures, no MusicBrainz preview rows, no discography. Real database,
 * real router; auth is injected as the parent router would.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import artistRoutes from "../artists";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const P = "zz-playtracks";

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: "test-user", username: "tester", role: "user" };
        next();
    });
    app.use("/", artistRoutes);
    return app;
}

const app = makeApp();

async function makeAlbum(id: string, title: string, opts: {
    year?: number | null;
    displayYear?: number | null;
    location?: "LIBRARY" | "DISCOVER";
}) {
    return prisma.album.create({
        data: {
            id,
            rgMbid: `${id}-rg`,
            identityKey: id,
            title,
            artistId: `${P}art`,
            primaryType: "Album",
            location: opts.location ?? "LIBRARY",
            year: opts.year ?? null,
            displayYear: opts.displayYear ?? null,
        },
    });
}

async function makeTrack(albumId: string, no: number, opts: { disc?: number | null; title?: string } = {}) {
    return prisma.track.create({
        data: {
            id: `${albumId}-t${no}`,
            albumId,
            title: opts.title ?? `Track ${no}`,
            trackNo: no,
            discNumber: opts.disc ?? null,
            duration: 100 + no,
            filePath: `/tmp/${albumId}-${no}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        },
    });
}

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: `${P}` } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: `${P}` } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: `${P}` } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({
        data: { id: `${P}art`, name: "Play Tracks Artist", identityKey: `${P}-identity` },
    });
    // Newest by effective year (displayYear wins over year).
    await makeAlbum(`${P}alb-newest`, "Zea", { year: 2010, displayYear: 2024 });
    await makeTrack(`${P}alb-newest`, 1);
    await makeTrack(`${P}alb-newest`, 2);
    // Same effective year as the next album: title ascending breaks the tie.
    await makeAlbum(`${P}alb-tie-b`, "Beta", { year: 2018 });
    await makeAlbum(`${P}alb-tie-a`, "Alpha", { year: 2018 });
    await makeTrack(`${P}alb-tie-a`, 1);
    await makeTrack(`${P}alb-tie-b`, 1);
    // Multi-disc: disc order before track number.
    await makeAlbum(`${P}alb-disc`, "Gamma", { year: 2015 });
    await makeTrack(`${P}alb-disc`, 4, { disc: 2, title: "Disc 2 first" });
    await makeTrack(`${P}alb-disc`, 5, { disc: 2 });
    await makeTrack(`${P}alb-disc`, 1, { disc: 1 });
    await makeTrack(`${P}alb-disc`, 3, { disc: 1 });
    // No year at all: sorts last, like iOS treating missing as 0.
    await makeAlbum(`${P}alb-nodate`, "Delta", {});
    await makeTrack(`${P}alb-nodate`, 1);
    // Discovery-kept album with files: plays today, so it plays here too.
    await makeAlbum(`${P}alb-disco`, "Epsilon", { year: 2020, location: "DISCOVER" });
    await makeTrack(`${P}alb-disco`, 1);
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await closeEngineConnections();
});

describe("GET /library/artists/:id/play-tracks", () => {
    it("returns the queue in canonical order", async () => {
        const res = await request(app).get(`/artists/${P}art/play-tracks`);
        expect(res.status).toBe(200);
        expect(res.body.tracks.map((t: any) => t.id)).toEqual([
            // 2024 first (displayYear wins over year 2010)
            `${P}alb-newest-t1`, `${P}alb-newest-t2`,
            // 2020 discovery-kept album beats both 2018s
            `${P}alb-disco-t1`,
            // 2018 tie: Alpha before Beta by title
            `${P}alb-tie-a-t1`, `${P}alb-tie-b-t1`,
            // 2015: disc 1 before disc 2
            `${P}alb-disc-t1`, `${P}alb-disc-t3`, `${P}alb-disc-t4`, `${P}alb-disc-t5`,
            // no year: last
            `${P}alb-nodate-t1`,
        ]);
    });

    it("ships only the fields a player reads", async () => {
        const res = await request(app).get(`/artists/${P}art/play-tracks`);
        const track = res.body.tracks[0];
        expect(Object.keys(track).sort()).toEqual([
            "album", "artist", "discNumber", "duration", "id", "title", "trackNo",
        ]);
        expect(Object.keys(track.album).sort()).toEqual(["coverArt", "id", "title"]);
        expect(Object.keys(track.artist).sort()).toEqual(["id", "name"]);
        expect(res.body.artist).toEqual({ id: `${P}art`, name: "Play Tracks Artist" });
        // The page's heavy payload must not ride along.
        expect(track.audioFeatures).toBeUndefined();
        expect(track.bpm).toBeUndefined();
        expect(track.embedding).toBeUndefined();
    });

    it("finds the artist by name and mbid like the page route does", async () => {
        const byName = await request(app).get("/artists/play tracks artist/play-tracks");
        expect(byName.status).toBe(200);
        expect(byName.body.tracks.length).toBeGreaterThan(0);
    });

    it("404s for an unknown artist", async () => {
        const res = await request(app).get("/artists/zz-playtracks-nobody/play-tracks");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Artist not found" });
    });
});
