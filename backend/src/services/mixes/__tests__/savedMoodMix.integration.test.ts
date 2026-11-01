/**
 * A saved mood mix holds only playable library songs: Discover songs are dropped when saving, and the Home card counts
 * (and shows covers for) only the songs that still play when it is read.
 */
import { prisma } from "../../../utils/db";
import { waitForRedisReady } from "../../../utils/redis";
import {
    LibraryHandle, removeSyntheticLibrary, seedSyntheticLibrary, seedSyntheticMoods,
} from "../../../__tests__/fixtures/syntheticLibrary";
import { buildMoodState } from "../../moods/state";
import { moodBucketService } from "../../moodBucketService";

jest.setTimeout(300_000);
const PREFIX = "smmx_";
let lib: LibraryHandle;

beforeAll(async () => {
    await waitForRedisReady();
    lib = await seedSyntheticLibrary(PREFIX);
    await seedSyntheticMoods(PREFIX);
    await prisma.$transaction((tx) => buildMoodState(tx));
});
afterAll(async () => {
    await prisma.userMoodMix.deleteMany({ where: { userId: lib.user1 } });
    await removeSyntheticLibrary(PREFIX);
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$disconnect();
});

it("saving Discover song ids keeps none of them", async () => {
    const discover = await prisma.track.findMany({
        where: { id: { startsWith: PREFIX }, album: { location: "DISCOVER" } }, select: { id: true }, take: 5,
    });
    expect(discover.length).toBeGreaterThan(0);
    const saved = await moodBucketService.saveUserMoodMix(lib.user1, "happy", 15, discover.map((t) => t.id));
    expect(saved?.trackIds ?? []).toEqual([]);
    const home = await moodBucketService.getUserMoodMix(lib.user1);
    expect(home?.trackCount ?? 0).toBe(0);
});

it("a saved mix stops counting a song whose album has since moved to Discover", async () => {
    const lib5 = await prisma.track.findMany({
        where: { id: { startsWith: PREFIX }, album: { location: "LIBRARY" }, missingSince: null, corrupt: false },
        select: { id: true, albumId: true }, take: 5, orderBy: { id: "asc" },
    });
    await moodBucketService.saveUserMoodMix(lib.user1, "happy", 15, lib5.map((t) => t.id));
    const moved = lib5.slice(0, 3);
    await prisma.album.updateMany({ where: { id: { in: moved.map((t) => t.albumId) } }, data: { location: "DISCOVER" } });
    const home = await moodBucketService.getUserMoodMix(lib.user1);
    const stayed = lib5.filter((t) => !moved.some((m) => m.albumId === t.albumId)).map((t) => t.id);
    expect(stayed.length).toBeGreaterThan(0);
    expect(home?.trackIds).toEqual(stayed);
    expect(home?.trackCount).toBe(stayed.length);
});

it("saving only songs that cannot be saved keeps the listener's previous mix", async () => {
    await prisma.album.updateMany({ where: { id: { startsWith: PREFIX } }, data: { location: "LIBRARY" } });
    const good = await prisma.track.findMany({
        where: { id: { startsWith: PREFIX }, album: { location: "LIBRARY" }, missingSince: null, corrupt: false },
        select: { id: true }, take: 3, orderBy: { id: "asc" },
    });
    const first = await moodBucketService.saveUserMoodMix(lib.user1, "happy", 15, good.map((t) => t.id));
    expect(first?.trackIds).toHaveLength(3);
    const refused = await moodBucketService.saveUserMoodMix(lib.user1, "happy", 15, ["no-such-track"]);
    expect(refused).toBeNull();
    const home = await moodBucketService.getUserMoodMix(lib.user1);
    expect(home?.trackIds).toEqual(good.map((t) => t.id));
});
