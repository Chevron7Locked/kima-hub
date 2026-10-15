/**
 * A cached search answers each page with its own results: the second page is
 * not page one served again from the cache. Real database and Redis.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { searchService } from "../search";
import { normalizeArtistName } from "../artistIdentity";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "srchpage";
const NAMES = ["Quillfeather Alpha", "Quillfeather Beta", "Quillfeather Gamma"];

async function clearCache() {
    const keys = await redisClient.keys("search:artists:*quillfeather*");
    if (keys.length) await redisClient.del(...keys);
}

beforeAll(async () => {
    await waitForRedisReady();
    await clearCache();
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    for (const [i, name] of NAMES.entries()) {
        await prisma.artist.create({
            data: { id: `${P}${i}`, name, normalizedName: normalizeArtistName(name), identityKey: `${P}-${i}` },
        });
        await prisma.album.create({
            data: { id: `${P}${i}alb`, artistId: `${P}${i}`, rgMbid: `${P}-rg-${i}`, primaryType: "Album", title: `${name} Album` },
        });
    }
});

afterAll(async () => {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

it("gives the second page its own results after the first page was cached", async () => {
    const first = await searchService.searchByType({ query: "quillfeather", type: "artists", limit: 1, offset: 0, userId: "any" });
    const second = await searchService.searchByType({ query: "quillfeather", type: "artists", limit: 1, offset: 1, userId: "any" });
    expect(first.artists).toHaveLength(1);
    expect(second.artists).toHaveLength(1);
    expect(second.artists[0].id).not.toBe(first.artists[0].id);
});
