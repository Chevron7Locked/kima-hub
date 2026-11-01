/**
 * A library a recipe cannot rank (no arousal reading anywhere) is a property of the library, not a fault
 * (UnrankableLibraryError): Home mix builds give no mix for it and log no error.
 */
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import { waitForRedisReady } from "../../../utils/redis";
import {
    LibraryHandle, removeSyntheticLibrary, seedSyntheticLibrary, seedSyntheticMoods,
} from "../../../__tests__/fixtures/syntheticLibrary";
import { buildMoodState } from "../../moods/state";
import { programmaticPlaylistService } from "../index";

jest.setTimeout(300_000);
const PREFIX = "unrk_";
let lib: LibraryHandle;

beforeAll(async () => {
    await waitForRedisReady();
    lib = await seedSyntheticLibrary(PREFIX);
    await seedSyntheticMoods(PREFIX);
    await prisma.$transaction((tx) => buildMoodState(tx));
    await prisma.$executeRawUnsafe(`UPDATE mood_state SET arousal_mean = NULL, arousal_sd = NULL`);
});
afterAll(async () => {
    await removeSyntheticLibrary(PREFIX);
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$disconnect();
});

it("building Home mixes for a library a recipe cannot rank logs no error", async () => {
    const errors = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    let mixes = 0;
    for (let d = 1; d <= 6; d++) {
        const out = await programmaticPlaylistService.generateAllMixes(lib.user1, false, new Date(Date.UTC(2026, 5, d, 12)), "UTC");
        mixes += out.length;
    }
    const unrankable = errors.mock.calls.filter((c) => String(c[0]).includes("failed") && String(c[1]).includes("Recipe"));
    errors.mockRestore();
    expect(mixes).toBeGreaterThan(0);
    expect(unrankable).toEqual([]);
});
