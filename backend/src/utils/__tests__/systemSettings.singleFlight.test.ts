/**
 * Concurrent reads of cold system settings share one read of the row. A read that began before a save invalidated the
 * cache is not shared with anyone who asks afterwards, and is not kept; a read that fails is not kept either, so
 * the next call tries again. Real database.
 */
import { prisma } from "../db";
import { getSystemSettings, invalidateSystemSettingsCache, saveSystemSettings } from "../systemSettings";
import { redisClient } from "../redis";
import { closeClient } from "../closeRedisClient";
import { queues } from "../../workers/queues";
import { notificationService } from "../../services/notificationService";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

let before: Record<string, unknown> | null;
let readRow: typeof prisma.systemSettings.findUnique;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    readRow = prisma.systemSettings.findUnique.bind(prisma.systemSettings);
});

beforeEach(async () => {
    // transcodeCacheMaxGb is just a plain numeric column to tell one saved row from another
    const start = { transcodeCacheMaxGb: 10, fanartApiKey: null, acoustidApiKey: null, discoverAlbumsSortedAt: null };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...start }, update: start });
    invalidateSystemSettingsCache();
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

/** Counts reads of the row, and holds each one open (after the row was read) until the test releases it. */
function watchReads() {
    const releases: Array<() => void> = [];
    const spy = jest.spyOn(prisma.systemSettings, "findUnique").mockImplementation(((args: never) => (async () => {
        const row = await readRow(args);
        await new Promise<void>((resolve) => releases.push(resolve));
        return row;
    })()) as never);
    const waitForRead = async (count: number) => {
        const deadline = Date.now() + 3000;
        while (releases.length < count) {
            if (Date.now() > deadline) throw new Error(`expected ${count} open reads of the row, saw ${releases.length}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };
    const releaseAll = () => releases.forEach((release) => release());
    return { spy, releases, waitForRead, releaseAll };
}

describe("getSystemSettings with a cold cache", () => {
    it("reads the row once for any number of concurrent calls", async () => {
        const reads = watchReads();

        const calls = Array.from({ length: 8 }, () => getSystemSettings());
        await reads.waitForRead(1);
        reads.releaseAll();
        const answers = await Promise.all(calls);

        expect(reads.spy).toHaveBeenCalledTimes(1);
        answers.forEach((answer) => expect(answer?.transcodeCacheMaxGb).toBe(10));
        // each caller owns its copy: changing one does not change what the others, or later calls, get
        answers[0]!.transcodeCacheMaxGb = 99;
        expect(answers[1]!.transcodeCacheMaxGb).toBe(10);
        reads.spy.mockRestore();
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(10);
    });

    it("answers a warm cache without reading the row", async () => {
        await getSystemSettings();
        const spy = jest.spyOn(prisma.systemSettings, "findUnique");

        await Promise.all([getSystemSettings(), getSystemSettings()]);

        expect(spy).not.toHaveBeenCalled();
    });

    it("gives a call made after an invalidation its own read and the new value, and keeps only that one", async () => {
        const reads = watchReads();

        const early = getSystemSettings();
        const alsoEarly = getSystemSettings();
        await reads.waitForRead(1);
        // a save lands while the first read is still open
        await prisma.systemSettings.update({ where: { id: "default" }, data: { transcodeCacheMaxGb: 12 } });
        invalidateSystemSettingsCache();
        const late = getSystemSettings();
        const alsoLate = getSystemSettings();
        await reads.waitForRead(2);
        reads.releaseAll();

        expect(reads.spy).toHaveBeenCalledTimes(2);
        expect((await early)?.transcodeCacheMaxGb).toBe(10);
        expect((await alsoEarly)?.transcodeCacheMaxGb).toBe(10);
        expect((await late)?.transcodeCacheMaxGb).toBe(12);
        expect((await alsoLate)?.transcodeCacheMaxGb).toBe(12);
        reads.spy.mockRestore();
        const spy = jest.spyOn(prisma.systemSettings, "findUnique");
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(12);
        expect(spy).not.toHaveBeenCalled();
    });

    it("does not let an old read's end cancel the read that replaced it", async () => {
        const reads = watchReads();

        const old = getSystemSettings();
        await reads.waitForRead(1);
        invalidateSystemSettingsCache();
        const fresh = getSystemSettings();
        await reads.waitForRead(2);
        reads.releases[0]!(); // the old read ends first, while the new one is open
        await old;
        const joiner = getSystemSettings(); // arrives after the old read ended: joins the new one
        reads.releases[1]!();
        await Promise.all([fresh, joiner]);

        expect(reads.spy).toHaveBeenCalledTimes(2);
    });

    it("tries again after a read fails, and every call waiting on the failed read sees the failure", async () => {
        const spy = jest.spyOn(prisma.systemSettings, "findUnique").mockRejectedValueOnce(new Error("database went away"));

        const outcomes = await Promise.allSettled([getSystemSettings(), getSystemSettings()]);

        expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(10);
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("shares a read that finds no row, and keeps nothing", async () => {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        const spy = jest.spyOn(prisma.systemSettings, "findUnique");

        const answers = await Promise.all([getSystemSettings(), getSystemSettings(), getSystemSettings()]);

        expect(answers).toEqual([null, null, null]);
        expect(spy).toHaveBeenCalledTimes(1);
        await getSystemSettings();
        expect(spy).toHaveBeenCalledTimes(2);
    });
});

describe("saveSystemSettings and a read in flight", () => {
    it("a call after the save gets the saved value even while a read from before it is open", async () => {
        const reads = watchReads();
        const stale = getSystemSettings();
        await reads.waitForRead(1);

        await saveSystemSettings({ transcodeCacheMaxGb: 15 });
        const fresh = getSystemSettings();
        await reads.waitForRead(2);
        reads.releaseAll();

        expect((await stale)?.transcodeCacheMaxGb).toBe(10);
        expect((await fresh)?.transcodeCacheMaxGb).toBe(15);
    });
});

// 'xc1.' marks the current format, and the rest is no valid ciphertext: stored, but the key cannot read it.
const unreadable = "xc1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function storeUnreadable(field: "fanartApiKey" | "acoustidApiKey", more: Record<string, unknown> = {}) {
    await prisma.systemSettings.update({ where: { id: "default" }, data: { [field]: unreadable, ...more } });
    invalidateSystemSettingsCache();
}

describe("what getSystemSettings hands out", () => {
    it("is a copy: changing it, nested values too, changes neither the next read nor the cache", async () => {
        const sortedAt = new Date("2026-01-02T03:04:05Z");
        await storeUnreadable("fanartApiKey", { discoverAlbumsSortedAt: sortedAt });

        const first = (await getSystemSettings())!;
        expect(first.unreadableFields).toEqual(["fanartApiKey"]);
        first.unreadableFields.push("lidarrApiKey");
        first.discoverAlbumsSortedAt!.setTime(0);
        first.transcodeCacheMaxGb = 99;

        // answered from the cache: no read of the row
        const spy = jest.spyOn(prisma.systemSettings, "findUnique");
        const second = (await getSystemSettings())!;
        expect(spy).not.toHaveBeenCalled();
        expect(second.unreadableFields).toEqual(["fanartApiKey"]);
        expect(second.discoverAlbumsSortedAt).toEqual(sortedAt);
        expect(second.transcodeCacheMaxGb).toBe(10);
    });

    it("is a copy for callers who shared one read, too", async () => {
        await storeUnreadable("fanartApiKey");

        const [a, b] = await Promise.all([getSystemSettings(), getSystemSettings()]);
        a!.unreadableFields.push("lidarrApiKey");

        expect(b!.unreadableFields).toEqual(["fanartApiKey"]);
        expect((await getSystemSettings())!.unreadableFields).toEqual(["fanartApiKey"]);
    });
});

describe("an unreadable credential", () => {
    it("still answers when the admin notice about an unreadable credential cannot be sent", async () => {
        await storeUnreadable("acoustidApiKey");
        const notify = jest.spyOn(notificationService, "notifyAdmins").mockRejectedValue(new Error("notifications are down"));

        const settings = await getSystemSettings();

        expect(settings?.acoustidApiKey).toBeNull();
        expect(settings?.unreadableFields).toContain("acoustidApiKey");
        expect(notify).toHaveBeenCalled();
    });
});
