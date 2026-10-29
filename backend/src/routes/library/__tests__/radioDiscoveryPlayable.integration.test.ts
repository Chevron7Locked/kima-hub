/**
 * Discovery radio counts only playable tracks when it decides whether enough
 * tracks are unplayed. Here most unplayed tracks have a missing file or are
 * marked corrupt, so counting them would stop the station short; it must fall
 * back to the least-played tracks and still return `limit`.
 */
import request from "supertest";
import { prisma } from "../../../utils/db";
import { cleanupPlayable, radioApp, seedPlayableLibrary } from "../../__tests__/helpers/radioPlayable";

jest.setTimeout(120_000);

const P = "rdp_";
const LIMIT = 20;
const app = radioApp();

// Track groups, by number: 0-1 playable and unplayed; 2-29 unplayed with a missing file;
// 30-39 unplayed and corrupt; 40-79 playable and played once.
beforeAll(async () => {
    await seedPlayableLibrary(P, { label: "Disc", trackCount: 80, missing: [2, 29], corrupt: [30, 39] });
    await prisma.$executeRaw`
        INSERT INTO "Play" (id, "userId", "trackId")
        SELECT ${P + "play_"} || i, ${P + "user"}, ${P + "trk_"} || lpad(i::text, 3, '0')
        FROM generate_series(40, 79) AS i`;
});

afterAll(async () => {
    await cleanupPlayable(P);
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
