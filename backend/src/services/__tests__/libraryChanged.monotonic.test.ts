/**
 * The library change marker never goes backwards, however many writers move it at once, and the settings cache is not left
 * holding the old value. Real database. The moves run on a settings row of this test's own, at times of its choosing, so
 * the one real marker, which other tests read, is never left at a time chosen here.
 */
import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { markLibraryChanged } from "../libraryChanged";

const ROW = "monotonic_test_row";
const BASE = Date.UTC(2031, 0, 1);

const stored = async () => (await prisma.systemSettings.findUniqueOrThrow({ where: { id: ROW } })).libraryChangedAt?.getTime();
const move = (ms: number) => markLibraryChanged(new Date(ms), ROW);

beforeEach(async () => {
    await prisma.systemSettings.deleteMany({ where: { id: ROW } });
});

afterAll(async () => {
    await prisma.systemSettings.deleteMany({ where: { id: ROW } });
    await prisma.$disconnect();
});

it("two concurrent moves leave the later time, whichever finishes last", async () => {
    await move(BASE);
    const [a, b] = await Promise.all([move(BASE + 2000), move(BASE + 1000)]);
    // Each answer is the time stored when its own statement ran: never below its own time, never past the later one.
    expect(a.getTime()).toBe(BASE + 2000);
    expect(b.getTime()).toBeGreaterThanOrEqual(BASE + 1000);
    expect(b.getTime()).toBeLessThanOrEqual(BASE + 2000);
    expect(await stored()).toBe(BASE + 2000);
});

it("many concurrent moves never leave the marker below the latest of them", async () => {
    for (let round = 0; round < 5; round++) {
        const times = Array.from({ length: 12 }, (_, i) => BASE + round * 100_000 + ((i * 7) % 12) * 1000);
        const answers = await Promise.all(times.map(move));
        expect(await stored()).toBe(Math.max(...times));
        for (const [i, answer] of answers.entries()) expect(answer.getTime()).toBeGreaterThanOrEqual(times[i]);
    }
});

it("an older time changes nothing and answers the time stored", async () => {
    const latest = await move(BASE + 500_000);
    const older = await move(BASE + 1000);
    expect(older.getTime()).toBe(latest.getTime());
    expect(await stored()).toBe(latest.getTime());
});

it("a later read of the settings sees the new marker, not a cached one", async () => {
    const before = (await getSystemSettings())?.libraryChangedAt?.getTime() ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const moved = await markLibraryChanged();
    expect(moved.getTime()).toBeGreaterThan(before);
    expect((await getSystemSettings())?.libraryChangedAt?.getTime()).toBeGreaterThanOrEqual(moved.getTime());
});
