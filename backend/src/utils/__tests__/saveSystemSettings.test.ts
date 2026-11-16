/**
 * The one save of system settings: it writes, drops the cache, and calls each listener with its own fields that
 * changed, never the others and never a value that was sent back unchanged (the settings page sends every field on
 * every save). Real database and cipher.
 */
import { prisma } from "../db";
import { encrypt } from "../encryption";
import { getSystemSettings, invalidateSystemSettingsCache, onSystemSettingsChange, readSystemSettingsFresh, saveSystemSettings } from "../systemSettings";
import { logger } from "../logger";
import { redisClient } from "../redis";
import { closeClient } from "../closeRedisClient";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

let before: Record<string, unknown> | null;
const removers: Array<() => void> = [];
const listen = (fields: Parameters<typeof onSystemSettingsChange>[1]) => {
    const heard = jest.fn();
    removers.push(onSystemSettingsChange("test listener", fields, heard));
    return heard;
};

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
});

beforeEach(async () => {
    const start = {
        fanartEnabled: false,
        fanartApiKey: null,
        lidarrUrl: "http://lidarr.test:8686",
        soulseekUsername: null,
        soulseekPassword: null,
        transcodeCacheMaxGb: 10,
        discoverAlbumsSortedAt: null,
    };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...start }, update: start });
    invalidateSystemSettingsCache();
});

afterEach(() => {
    while (removers.length) removers.pop()!();
});

afterAll(async () => {
    // Upsert: a suite running alongside may have deleted the row meanwhile.
    if (before) await prisma.systemSettings.upsert({ where: { id: "default" }, create: before as any, update: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

describe("saveSystemSettings", () => {
    it("writes the row and the next read sees it, not a cached copy", async () => {
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(10);

        await saveSystemSettings({ transcodeCacheMaxGb: 12 });

        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(12);
        expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).transcodeCacheMaxGb).toBe(12);
    });

    it("does not cache what a read that began before the save saw", async () => {
        const read = prisma.systemSettings.findUnique.bind(prisma.systemSettings);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let sawOldRow!: () => void;
        const oldRowSeen = new Promise<void>((resolve) => { sawOldRow = resolve; });
        const slow = jest.spyOn(prisma.systemSettings, "findUnique").mockImplementationOnce(((args: never) => (async () => {
            const row = await read(args);
            sawOldRow();
            await gate;
            return row;
        })()) as never);

        try {
            const stale = getSystemSettings();
            await oldRowSeen;
            await saveSystemSettings({ transcodeCacheMaxGb: 12 });
            release();

            expect((await stale)?.transcodeCacheMaxGb).toBe(10);
        } finally {
            slow.mockRestore();
        }
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(12);
    });

    // The save's commit reaches the database before its code carries on to drop the cache; this holds it in between.
    function holdAfterCommit() {
        const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let committed!: () => void;
        const commitSeen = new Promise<void>((resolve) => { committed = resolve; });
        const spy = jest.spyOn(prisma, "$transaction").mockImplementationOnce(((...args: unknown[]) => (async () => {
            const result = await real(...args);
            committed();
            await gate;
            return result;
        })()) as never);
        return { release, commitSeen, restore: () => spy.mockRestore() };
    }

    it("a read made after the commit, before the save has carried on, sees the save, not a cached copy", async () => {
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(10); // warms the cache
        const held = holdAfterCommit();
        try {
            const saving = saveSystemSettings({ transcodeCacheMaxGb: 14 });
            await held.commitSeen;

            expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(14);
            held.release();
            await saving;
        } finally {
            held.restore();
        }
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(14);
    });

    it("a save that fails after its commit still drops the cache, and reads are cached again afterwards", async () => {
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(10); // warms the cache
        const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
        const spy = jest.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
            await real(...args);
            throw new Error("connection lost at commit");
        }) as never);
        try {
            await expect(saveSystemSettings({ transcodeCacheMaxGb: 16 })).rejects.toThrow("connection lost at commit");
        } finally {
            spy.mockRestore();
        }

        const reads = jest.spyOn(prisma.systemSettings, "findUnique");
        try {
            expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(16);
            await getSystemSettings();
            expect(reads).toHaveBeenCalledTimes(1); // the second read is the cache's: no save is left open
        } finally {
            reads.mockRestore();
        }
    });

    it("a read made after the commit does not join a read that began before it", async () => {
        const read = prisma.systemSettings.findUnique.bind(prisma.systemSettings);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let sawOldRow!: () => void;
        const oldRowSeen = new Promise<void>((resolve) => { sawOldRow = resolve; });
        const slow = jest.spyOn(prisma.systemSettings, "findUnique").mockImplementationOnce(((args: never) => (async () => {
            const row = await read(args);
            sawOldRow();
            await gate;
            return row;
        })()) as never);
        const held = holdAfterCommit();
        try {
            const stale = getSystemSettings();
            await oldRowSeen;
            const saving = saveSystemSettings({ transcodeCacheMaxGb: 16 });
            await held.commitSeen;

            expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(16);
            held.release();
            release();
            await saving;
            expect((await stale)?.transcodeCacheMaxGb).toBe(10);
        } finally {
            held.restore();
            slow.mockRestore();
        }
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(16);
    });

    it("reports a text setting blanked, and one set after being blank, as changes", async () => {
        expect(await saveSystemSettings({ lidarrUrl: "" })).toEqual(["lidarrUrl"]);
        expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).lidarrUrl).toBe("");
        expect(await saveSystemSettings({ lidarrUrl: "http://lidarr.test:8686" })).toEqual(["lidarrUrl"]);
        expect(await saveSystemSettings({ lidarrUrl: null })).toEqual(["lidarrUrl"]);
    });

    it("says nothing changed when a text setting that was never set is saved blank", async () => {
        await prisma.systemSettings.update({ where: { id: "default" }, data: { lidarrUrl: null } });
        invalidateSystemSettingsCache();
        expect(await saveSystemSettings({ lidarrUrl: "" })).toEqual([]);
    });

    it("encrypts a credential in the row and reads it back plain", async () => {
        await saveSystemSettings({ fanartApiKey: "fa-key" });

        const row = await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } });
        expect(row.fanartApiKey).not.toBe("fa-key");
        expect((await getSystemSettings())?.fanartApiKey).toBe("fa-key");
    });

    it("creates the row when there is none", async () => {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();

        await saveSystemSettings({ transcodeCacheMaxGb: 3 });

        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(3);
    });

    it("answers with the fields whose value changed", async () => {
        const changed = await saveSystemSettings({ transcodeCacheMaxGb: 10, fanartEnabled: true, lidarrUrl: "http://lidarr.test:8686" });

        expect(changed).toEqual(["fanartEnabled"]);
    });

    it("reports each change once when two saves of the same value run at the same time", async () => {
        const heard = listen(["fanartEnabled"]);

        const answers = await Promise.all(Array.from({ length: 4 }, () => saveSystemSettings({ fanartEnabled: true })));

        expect(answers.filter((changed) => changed.length > 0)).toEqual([["fanartEnabled"]]);
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it("keeps both changes when two saves of different fields run at the same time", async () => {
        const [first, second] = await Promise.all([
            saveSystemSettings({ fanartEnabled: true }),
            saveSystemSettings({ transcodeCacheMaxGb: 21 }),
        ]);

        expect(first).toEqual(["fanartEnabled"]);
        expect(second).toEqual(["transcodeCacheMaxGb"]);
        const row = await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } });
        expect([row.fanartEnabled, row.transcodeCacheMaxGb]).toEqual([true, 21]);
    });

    it("creates the row once when two saves arrive and there is none", async () => {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();

        await expect(
            Promise.all([saveSystemSettings({ transcodeCacheMaxGb: 5 }), saveSystemSettings({ fanartEnabled: true })]),
        ).resolves.toHaveLength(2);

        const row = await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } });
        expect([row.transcodeCacheMaxGb, row.fanartEnabled]).toEqual([5, true]);
    });

    it("stores the time a save gives for the library marker when the save creates the row, not the database's default time", async () => {
        // The default time comes from the database's clock, which may run ahead of the server's; it is no earlier marker.
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();
        const past = new Date(Date.now() - 60_000);

        await saveSystemSettings({ libraryChangedAt: past });

        expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).libraryChangedAt?.getTime()).toBe(past.getTime());
    });

    it("keeps an unreadable credential when a blank is saved over it, and says nothing changed", async () => {
        const heard = listen(["fanartApiKey"]);
        // A well-formed ciphertext that this key cannot open.
        const stranger = encrypt("sealed under another key").slice(0, -4) + "AAAA";
        await prisma.systemSettings.update({ where: { id: "default" }, data: { fanartApiKey: stranger } });
        invalidateSystemSettingsCache();

        await saveSystemSettings({ fanartApiKey: "" });

        expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).fanartApiKey).toBe(stranger);
        expect(heard).not.toHaveBeenCalled();
    });
});

describe("onSystemSettingsChange", () => {
    it("tells a listener only about its own fields", async () => {
        const fanart = listen(["fanartEnabled", "fanartApiKey"]);
        const lidarr = listen(["lidarrUrl", "lidarrApiKey"]);

        await saveSystemSettings({ fanartEnabled: true, fanartApiKey: "fa-key", transcodeCacheMaxGb: 11 });

        expect(fanart).toHaveBeenCalledTimes(1);
        expect(fanart).toHaveBeenCalledWith(["fanartEnabled", "fanartApiKey"]);
        expect(lidarr).not.toHaveBeenCalled();
    });

    it("names only the listener's fields that changed", async () => {
        await saveSystemSettings({ fanartEnabled: true });
        const fanart = listen(["fanartEnabled", "fanartApiKey"]);

        await saveSystemSettings({ fanartEnabled: true, fanartApiKey: "fa-key" });

        expect(fanart).toHaveBeenCalledWith(["fanartApiKey"]);
    });

    it("says nothing about a value sent back as it was", async () => {
        await saveSystemSettings({ fanartApiKey: "fa-key", lidarrUrl: "http://lidarr.test:8686" });
        const heard = listen(["fanartApiKey", "lidarrUrl", "soulseekUsername"]);

        await saveSystemSettings({ fanartApiKey: "fa-key", lidarrUrl: "http://lidarr.test:8686", soulseekUsername: "" });

        expect(heard).not.toHaveBeenCalled();
    });

    it("counts a credential's new value as a change, and a cleared one too", async () => {
        await saveSystemSettings({ soulseekPassword: "one" });
        const heard = listen(["soulseekPassword"]);

        await saveSystemSettings({ soulseekPassword: "two" });
        await saveSystemSettings({ soulseekPassword: null });

        expect(heard).toHaveBeenCalledTimes(2);
    });

    it("runs a listener after the save is readable", async () => {
        const seen = new Promise<unknown>((resolve) => {
            removers.push(
                onSystemSettingsChange("test listener", ["transcodeCacheMaxGb"], async () => {
                    resolve((await getSystemSettings())?.transcodeCacheMaxGb);
                }),
            );
        });

        await saveSystemSettings({ transcodeCacheMaxGb: 14 });

        await expect(seen).resolves.toBe(14);
    });

    it("lets a listener that throws neither fail the save nor silence the others", async () => {
        removers.push(onSystemSettingsChange("test listener", ["fanartEnabled"], () => { throw new Error("listener broke"); }));
        removers.push(onSystemSettingsChange("test listener", ["fanartEnabled"], async () => { throw new Error("async listener broke"); }));
        const other = listen(["fanartEnabled"]);

        await expect(saveSystemSettings({ fanartEnabled: true })).resolves.toEqual(["fanartEnabled"]);

        expect(other).toHaveBeenCalledTimes(1);
    });

    it("does not wait for a listener that never finishes", async () => {
        const never = jest.fn(() => new Promise<void>(() => {}));
        removers.push(onSystemSettingsChange("test listener", ["fanartEnabled"], never));
        const other = listen(["fanartEnabled"]);
        const held = Symbol("held");

        const outcome = await Promise.race([
            saveSystemSettings({ fanartEnabled: true }),
            new Promise<symbol>((resolve) => setTimeout(() => resolve(held), 500)),
        ]);

        expect(outcome).toEqual(["fanartEnabled"]);
        expect(never).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
    });

    it("logs a listener that fails after the save has returned, and the save is unharmed", async () => {
        let fail!: (error: Error) => void;
        removers.push(onSystemSettingsChange("cover art", ["fanartEnabled"], () => new Promise<void>((_, reject) => { fail = reject; })));
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => logger);

        try {
            await expect(saveSystemSettings({ fanartEnabled: true })).resolves.toEqual(["fanartEnabled"]);
            fail(new Error("late failure"));
            await new Promise((resolve) => setImmediate(resolve));

            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cover art.*fanartEnabled/), expect.objectContaining({ message: "late failure" }));
        } finally {
            warn.mockRestore();
        }
    });

    it("stops telling a listener that was removed", async () => {
        const heard = jest.fn();
        const off = onSystemSettingsChange("test listener", ["fanartEnabled"], heard);
        off();

        await saveSystemSettings({ fanartEnabled: true });

        expect(heard).not.toHaveBeenCalled();
    });

    it("compares dates by time", async () => {
        const at = new Date("2026-01-02T03:04:05Z");
        await saveSystemSettings({ discoverAlbumsSortedAt: at });
        const heard = listen(["discoverAlbumsSortedAt"]);

        await saveSystemSettings({ discoverAlbumsSortedAt: new Date(at.getTime()) });

        expect(heard).not.toHaveBeenCalled();
    });
});

describe("readSystemSettingsFresh", () => {
    it("sees a change another process just made, which the cached read does not see yet", async () => {
        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(10); // cached
        await prisma.systemSettings.update({ where: { id: "default" }, data: { transcodeCacheMaxGb: 13 } }); // as another process would

        expect((await getSystemSettings())?.transcodeCacheMaxGb).toBe(10);
        expect(await readSystemSettingsFresh("transcodeCacheMaxGb")).toEqual({ transcodeCacheMaxGb: 13 });
    });

    it("answers only the fields asked for, and null before the row exists", async () => {
        expect(await readSystemSettingsFresh("registrationOpen", "transcodeCacheMaxGb")).toEqual({
            registrationOpen: expect.any(Boolean),
            transcodeCacheMaxGb: 10,
        });
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        expect(await readSystemSettingsFresh("registrationOpen")).toBeNull();
    });
});
