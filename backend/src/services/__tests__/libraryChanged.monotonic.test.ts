/**
 * The library change marker never goes backwards, however many writers move it at once, the settings cache is not left
 * holding the old value, and a save through the one settings writer tells its listeners. Real database, the one real
 * marker: other tests read it, so every time used here is within a few milliseconds of now, never left far ahead of it.
 * Other suites in the same run reset that row too (as saveSystemSettings.test.ts does), so a reset landing between a
 * move and its read is a possible, very rare failure; the one writer takes no row id, so there is no private row to use.
 */
import { prisma } from "../../utils/db";
import { getSystemSettings, onSystemSettingsChange, saveSystemSettings } from "../../utils/systemSettings";
import { libraryChangedAt, markLibraryChanged } from "../libraryChanged";

// Past the few milliseconds ahead of now that the earlier tests may have left the marker at.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

afterAll(async () => {
    await prisma.$disconnect();
});

it("many concurrent moves never leave the marker below the latest of them", async () => {
    for (let round = 0; round < 8; round++) {
        const base = Date.now() + 5;
        const times = Array.from({ length: 12 }, (_, i) => base + ((i * 7) % 12));
        await Promise.all(times.map((t) => markLibraryChanged(new Date(t))));
        expect(await libraryChangedAt()).toBeGreaterThanOrEqual(Math.max(...times));
    }
});

it("two concurrent moves leave the later time, whichever finishes last", async () => {
    const base = Date.now() + 5;
    await Promise.all([markLibraryChanged(new Date(base + 9)), markLibraryChanged(new Date(base + 3))]);
    expect(await libraryChangedAt()).toBeGreaterThanOrEqual(base + 9);
});

it("an older time changes nothing", async () => {
    await markLibraryChanged();
    const held = await libraryChangedAt();
    await markLibraryChanged(new Date(held - 60_000));
    expect(await libraryChangedAt()).toBe(held);
    expect(await saveSystemSettings({ libraryChangedAt: new Date(held - 60_000) })).toEqual([]);
});

it("a later read of the settings sees the new marker, not a cached one", async () => {
    const before = (await getSystemSettings())?.libraryChangedAt?.getTime() ?? 0;
    await settle();
    await markLibraryChanged();
    expect((await getSystemSettings())?.libraryChangedAt?.getTime()).toBeGreaterThan(before);
});

it("a move tells the listeners of the marker, and an older time does not", async () => {
    const heard = jest.fn();
    const stop = onSystemSettingsChange("monotonic-test", ["libraryChangedAt"], heard);
    try {
        await settle();
        await markLibraryChanged();
        expect(heard).toHaveBeenCalledWith(["libraryChangedAt"]);
        heard.mockClear();
        await markLibraryChanged(new Date(Date.now() - 60_000));
        expect(heard).not.toHaveBeenCalled();
    } finally {
        stop();
    }
});
