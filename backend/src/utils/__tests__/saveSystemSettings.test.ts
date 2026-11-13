/**
 * The one save of system settings: it writes, drops the cache, and tells each subscriber which of its own fields
 * changed, never the others and never a value that was sent back unchanged (the settings page sends every field on
 * every save). Real database and cipher.
 */
import { prisma } from "../db";
import { encrypt } from "../encryption";
import { getSystemSettings, invalidateSystemSettingsCache, onSystemSettingsChange, saveSystemSettings } from "../systemSettings";
import { redisClient } from "../redis";
import { closeClient } from "../closeRedisClient";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

let before: Record<string, unknown> | null;
const unsubscribe: Array<() => void> = [];
const listen = (fields: Parameters<typeof onSystemSettingsChange>[0]) => {
    const heard = jest.fn();
    unsubscribe.push(onSystemSettingsChange(fields, heard));
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
    while (unsubscribe.length) unsubscribe.pop()!();
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
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
    it("tells a subscriber only about its own fields", async () => {
        const fanart = listen(["fanartEnabled", "fanartApiKey"]);
        const lidarr = listen(["lidarrUrl", "lidarrApiKey"]);

        await saveSystemSettings({ fanartEnabled: true, fanartApiKey: "fa-key", transcodeCacheMaxGb: 11 });

        expect(fanart).toHaveBeenCalledTimes(1);
        expect(fanart).toHaveBeenCalledWith(["fanartEnabled", "fanartApiKey"]);
        expect(lidarr).not.toHaveBeenCalled();
    });

    it("names only the subscriber's fields that changed", async () => {
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

    it("runs a subscriber after the save is readable", async () => {
        let seen: unknown;
        unsubscribe.push(
            onSystemSettingsChange(["transcodeCacheMaxGb"], async () => {
                seen = (await getSystemSettings())?.transcodeCacheMaxGb;
            }),
        );

        await saveSystemSettings({ transcodeCacheMaxGb: 14 });

        expect(seen).toBe(14);
    });

    it("lets a subscriber that throws neither fail the save nor silence the others", async () => {
        unsubscribe.push(onSystemSettingsChange(["fanartEnabled"], () => { throw new Error("subscriber broke"); }));
        unsubscribe.push(onSystemSettingsChange(["fanartEnabled"], async () => { throw new Error("async subscriber broke"); }));
        const other = listen(["fanartEnabled"]);

        await expect(saveSystemSettings({ fanartEnabled: true })).resolves.toEqual(["fanartEnabled"]);

        expect(other).toHaveBeenCalledTimes(1);
    });

    it("stops telling a subscriber that signed off", async () => {
        const heard = jest.fn();
        const off = onSystemSettingsChange(["fanartEnabled"], heard);
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
