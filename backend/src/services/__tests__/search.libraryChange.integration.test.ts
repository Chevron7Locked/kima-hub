/**
 * A cached search ends when the library a client lists changes: a song that goes missing, or a Discover song that a like
 * moves to the library, is not offered or withheld from a cached answer. Real database and Redis.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { searchService } from "../search";
import { libraryChangedAt, markLibraryChanged } from "../libraryChanged";
import { normalizeArtistName } from "../artistIdentity";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const P = "srchchg";
const NAME = "Zorbwick Lanternfish";

async function clearCache() {
    const keys = await redisClient.keys("search:*zorbwick*");
    if (keys.length) await redisClient.del(...keys);
}

/** The marker moves, to a time later than the one stored. */
async function libraryChanges() {
    await markLibraryChanged(new Date(Math.max(Date.now(), (await libraryChangedAt()) + 1)));
}

async function seed(location: "LIBRARY" | "DISCOVER") {
    await prisma.artist.create({ data: { id: `${P}art`, name: NAME, normalizedName: normalizeArtistName(NAME), identityKey: `${P}-ik` } });
    await prisma.album.create({
        data: {
            id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, primaryType: "Album", title: `${NAME} Album`, location,
            tracks: { create: { id: `${P}t`, title: "zorbwick song", trackNo: 1, duration: 100, filePath: `${P}t.flac`, fileModified: new Date(), fileSize: 1 } },
        },
    });
}

async function cleanup() {
    await clearCache();
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

const found = async (type: "artists" | "tracks") => {
    const answer = await searchService.searchByType({ query: "zorbwick", type, limit: 5, offset: 0, userId: "any" });
    return type === "artists" ? answer.artists.length : answer.tracks.length;
};
const foundInAll = async () => (await searchService.searchAll({ query: "zorbwick", limit: 5, userId: "any" })).tracks.length;

beforeAll(waitForRedisReady);
beforeEach(cleanup);
afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

it("stops offering a song that went missing once the library-changed marker moves", async () => {
    await seed("LIBRARY");
    expect(await found("tracks")).toBe(1);
    expect(await foundInAll()).toBe(1);

    await prisma.track.update({ where: { id: `${P}t` }, data: { missingSince: new Date() } });
    await libraryChanges();

    expect(await found("tracks")).toBe(0);
    expect(await foundInAll()).toBe(0);
});

it("offers an artist whose Discover album a like moved to the library once the marker moves", async () => {
    await seed("DISCOVER");
    expect(await found("artists")).toBe(0);

    await prisma.album.update({ where: { id: `${P}alb` }, data: { location: "LIBRARY" } });
    await libraryChanges();

    expect(await found("artists")).toBe(1);
});
