// A song path starts and ends on songs that play. A start or end song that is missing, corrupt or a Discover song
// answers 404, whichever end it is, before the matching is consulted. Real database, real router.

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "cpathunplayableuser000", role: "user" };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import vibeRouter from "../vibe";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const P = "zzpathunplay";
// The route takes cuid-shaped ids only.
const id = (kind: string) => `c${P}${kind}`.padEnd(25, "0");
const SONG = { playable: id("ok"), playable2: id("ok2"), discover: id("disc"), missing: id("miss"), corrupt: id("corr") };
const app = mountAsServer(express().use(express.json()), "/vibe", vibeRouter, "/api/vibe");

beforeAll(async () => {
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    for (const [kind, songId] of Object.entries(SONG)) {
        await prisma.album.create({
            data: { id: `${P}-${kind}-al`, rgMbid: `${P}-${kind}-rg`, artistId: `${P}-ar`, identityKey: `${P}-${kind}-ik`, title: kind, primaryType: "Album", location: kind === "discover" ? "DISCOVER" : "LIBRARY" },
        });
        await prisma.track.create({
            data: {
                id: songId, albumId: `${P}-${kind}-al`, title: kind, trackNo: 1, duration: 100, filePath: `${P}-${kind}.flac`, fileModified: new Date(), fileSize: 1,
                ...(kind === "missing" ? { missingSince: new Date() } : {}),
                ...(kind === "corrupt" ? { corrupt: true } : {}),
            },
        });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { in: Object.values(SONG) } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

const path = (startTrackId: string, endTrackId: string) => request(app).post("/vibe/path").send({ startTrackId, endTrackId });

describe.each(["discover", "missing", "corrupt"] as const)("a %s song", (kind) => {
    it("is refused as the start of a song path", async () => {
        const res = await path(SONG[kind], SONG.playable);
        expect(res.status).toBe(404);
    });

    it("is refused as the end of a song path", async () => {
        const res = await path(SONG.playable, SONG[kind]);
        expect(res.status).toBe(404);
    });
});

it("does not refuse two playable songs as unplayable", async () => {
    // These have no matching data, so the path itself is refused, but not as a song that won't play.
    const res = await path(SONG.playable, SONG.playable2);
    expect(res.status).toBe(400);
});
