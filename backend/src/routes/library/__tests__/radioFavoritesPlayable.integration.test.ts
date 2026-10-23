/**
 * Favorites radio draws its most-played tracks only from tracks that can play.
 * Here the tracks with the most plays have a missing file or are marked
 * corrupt, so reading them first would leave the station short; it must still
 * return `limit` tracks from the playable ones that have plays.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import router from "../tracks";

jest.setTimeout(120_000);

const P = "rfp_";
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

// Track groups, by number: 0-29 missing file, 10 plays each; 30-39 corrupt, 10 plays each;
// 40-99 playable, 1 play each; 100-119 playable, never played.
beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: `${P}user`, username: `${P}user`, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "Fav Artist", normalizedName: "fav artist", identityKey: `${P}ak` } });
    await prisma.album.create({
        data: { id: `${P}alb`, rgMbid: `${P}rg`, artistId: `${P}art`, identityKey: `${P}ik`, title: "Fav Album", primaryType: "Album" },
    });
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "missingSince", corrupt, "updatedAt")
        SELECT ${P + "trk_"} || lpad(i::text, 3, '0'), ${P + "alb"}, 'Fav Track ' || i, 1, 200,
               '/tmp/' || ${P} || i || '.flac', now(), 1000,
               CASE WHEN i < 30 THEN now() END, i BETWEEN 30 AND 39, now()
        FROM generate_series(0, 119) AS i`;
    await prisma.$executeRaw`
        INSERT INTO "Play" (id, "userId", "trackId")
        SELECT ${P + "play_"} || i || '_' || k, ${P + "user"}, ${P + "trk_"} || lpad(i::text, 3, '0')
        FROM generate_series(0, 99) AS i, generate_series(1, CASE WHEN i < 40 THEN 10 ELSE 1 END) AS k`;
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("returns the limit from playable played tracks when the most played cannot play", async () => {
    for (let k = 0; k < 10; k++) {
        const res = await request(app).get("/radio").query({ type: "favorites", limit: LIMIT });
        expect(res.status).toBe(200);
        const ids: string[] = res.body.tracks.map((t: { id: string }) => t.id);
        expect(ids).toHaveLength(LIMIT);
        expect(new Set(ids).size).toBe(LIMIT);
        const n = ids.map((id) => Number(id.slice(-3)));
        expect(n.every((x) => x >= 40 && x < 100)).toBe(true);
    }
});
