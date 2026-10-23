/**
 * Discovery radio counts only playable tracks when it decides whether enough
 * tracks are unplayed. Here most unplayed tracks have a missing file or are
 * marked corrupt, so counting them would stop the station short; it must fall
 * back to the least-played tracks and still return `limit`.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import router from "../tracks";

jest.setTimeout(120_000);

const P = "rdp_";
const LIMIT = 20;
const app = express();
app.use(express.json());
app.use("/", router);

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

// Track groups, by number: 0-1 playable and unplayed; 2-29 unplayed with a missing file;
// 30-39 unplayed and corrupt; 40-79 playable and played once.
beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: `${P}user`, username: `${P}user`, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "Disc Artist", normalizedName: "disc artist", identityKey: `${P}ak` } });
    await prisma.album.create({
        data: { id: `${P}alb`, rgMbid: `${P}rg`, artistId: `${P}art`, identityKey: `${P}ik`, title: "Disc Album", primaryType: "Album" },
    });
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "missingSince", corrupt, "updatedAt")
        SELECT ${P + "trk_"} || lpad(i::text, 3, '0'), ${P + "alb"}, 'Disc Track ' || i, 1, 200,
               '/tmp/' || ${P} || i || '.flac', now(), 1000,
               CASE WHEN i BETWEEN 2 AND 29 THEN now() END, i BETWEEN 30 AND 39, now()
        FROM generate_series(0, 79) AS i`;
    await prisma.$executeRaw`
        INSERT INTO "Play" (id, "userId", "trackId")
        SELECT ${P + "play_"} || i, ${P + "user"}, ${P + "trk_"} || lpad(i::text, 3, '0')
        FROM generate_series(40, 79) AS i`;
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("returns the limit from the least-played tracks when most unplayed tracks cannot play", async () => {
    const own = (id: string) => id.startsWith(`${P}trk_`);
    for (let k = 0; k < 10; k++) {
        const res = await request(app).get("/radio").query({ type: "discovery", limit: LIMIT });
        expect(res.status).toBe(200);
        const ids: string[] = res.body.tracks.map((t: { id: string }) => t.id);
        // Other suites' leftovers are not expected; every returned track must be one of ours that can play.
        expect(ids.every(own)).toBe(true);
        const n = ids.map((id) => Number(id.slice(-3)));
        expect(n.every((x) => x < 2 || x >= 40)).toBe(true);
        expect(ids).toHaveLength(LIMIT);
        expect(new Set(ids).size).toBe(LIMIT);
    }
});
