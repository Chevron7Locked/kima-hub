/**
 * Favorites radio draws its most-played tracks only from tracks that can play.
 * Here the tracks with the most plays have a missing file or are marked
 * corrupt, so reading them first would leave the station short; it must still
 * return `limit` tracks from the playable ones that have plays.
 */
import request from "supertest";
import { prisma } from "../../../utils/db";
import { cleanupPlayable, radioApp, seedPlayableLibrary } from "../../__tests__/helpers/radioPlayable";

jest.setTimeout(120_000);

const P = "rfp_";
const LIMIT = 20;
const app = radioApp(`${P}user`);

// Track groups, by number: 0-29 missing file and 30-39 corrupt, each with 10 play rows at one instant (one listen);
// 40-99 playable, 1 play each; 100-119 playable, never played. Weighting is tested in radio.integration.
beforeAll(async () => {
    await seedPlayableLibrary(P, { label: "Fav", trackCount: 120, missing: [0, 29], corrupt: [30, 39] });
    await prisma.$executeRaw`
        INSERT INTO "Play" (id, "userId", "trackId")
        SELECT ${P + "play_"} || i || '_' || k, ${P + "user"}, ${P + "trk_"} || lpad(i::text, 3, '0')
        FROM generate_series(0, 99) AS i, generate_series(1, CASE WHEN i < 40 THEN 10 ELSE 1 END) AS k`;
});

afterAll(async () => {
    await cleanupPlayable(P);
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
