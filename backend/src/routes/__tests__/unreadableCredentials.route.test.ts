// A stored credential this server's key cannot read is kept, and counts as not set. Real database, real cipher, real
// routes. The test process holds the wrong key; `restart` loads a second copy of the code under the right one.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { getSystemSettings, invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { encrypt } from "../../utils/encryption";
import { ENCRYPTED_FIELDS } from "../../utils/encryptedFields";
import systemSettingsRoutes from "../systemSettings";
import onboardingRoutes from "../onboarding";
import { queues } from "../../workers/queues";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { setEnv } from "../../__tests__/helpers/env";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const ADMIN = "zz-unreadable-admin";
const RIGHT_KEY = "the-key-these-credentials-were-stored-under";
const FIELDS = Object.keys(ENCRYPTED_FIELDS) as (keyof typeof ENCRYPTED_FIELDS)[];

type Server = {
    encrypt: typeof encrypt;
    getSystemSettings: typeof getSystemSettings;
    /** A settings read that waits for its notices. */
    readSettings: (row: Record<string, unknown>) => Promise<unknown>;
    logger: typeof import("../../utils/logger").logger;
};

/** This code as a process started with `key` would load it: nothing kept from any earlier one. */
function restart(key: string | undefined = process.env.SETTINGS_ENCRYPTION_KEY): Server {
    let server!: Server;
    const restoreEnv = setEnv({ SETTINGS_ENCRYPTION_KEY: key });
    try {
        jest.isolateModules(() => {
            const fields = require("../../utils/encryptedFields");
            server = {
                encrypt: require("../../utils/encryption").encrypt,
                getSystemSettings: require("../../utils/systemSettings").getSystemSettings,
                readSettings: async (row) => {
                    const resolved = fields.decryptSettings(row);
                    await fields.noteUnreadableCredentials(resolved, () => []);
                    return resolved;
                },
                logger: require("../../utils/logger").logger,
            };
        });
    } finally {
        restoreEnv();
    }
    return server;
}

const underRightKey = restart(RIGHT_KEY);
const plain = (field: string) => `the ${field}`;
const sealed = () => Object.fromEntries(FIELDS.map((f) => [f, underRightKey.encrypt(plain(f))]));
const blanks = Object.fromEntries(FIELDS.map((f) => [f, ""]));

const storedCredentials = async () => {
    const row = await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } });
    return Object.fromEntries(FIELDS.map((f) => [f, row[f]]));
};
const store = async (data: Record<string, unknown>) => {
    await prisma.systemSettings.update({ where: { id: "default" }, data });
    invalidateSystemSettingsCache();
};

const app = () =>
    mountAsServer(
        mountAsServer(express().use(express.json()), "/system-settings", systemSettingsRoutes, "/api/system-settings"),
        "/onboarding",
        onboardingRoutes,
        "/api/onboarding",
    );
const asAdmin = () => `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
const get = () => request(app()).get("/system-settings").set("Authorization", asAdmin());
const save = (body: object) => request(app()).post("/system-settings").set("Authorization", asAdmin()).send(body);

let before: Record<string, unknown> | null;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

beforeEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: ADMIN } });
    await store(sealed());
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

describe("a wrong key", () => {
    it("reads as not set and changes nothing stored", async () => {
        expectLog("warn");
        const stored = await storedCredentials();

        const res = await get();

        expect(res.status).toBe(200);
        for (const field of FIELDS) expect(res.body[field]).toBeNull();
        invalidateSystemSettingsCache();
        expect(await getSystemSettings()).toMatchObject(Object.fromEntries(FIELDS.map((f) => [f, null])));
        expect(await storedCredentials()).toEqual(stored);
    });

    it("loses nothing when another setting is saved the way the settings page does, and the right key restores it all", async () => {
        expectLog("warn");
        const stored = await storedCredentials();

        const res = await save({ ...blanks, transcodeCacheMaxGb: 9 });

        expect(res.status).toBe(200);
        expect(await storedCredentials()).toEqual(stored);
        expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).transcodeCacheMaxGb).toBe(9);

        const restored = await restart(RIGHT_KEY).getSystemSettings();
        expect(restored).toMatchObject(Object.fromEntries(FIELDS.map((f) => [f, plain(f)])));
    });

    it("is treated the same when the save sends null", async () => {
        expectLog("warn");
        const stored = await storedCredentials();

        await save(Object.fromEntries(FIELDS.map((f) => [f, null])));

        expect(await storedCredentials()).toEqual(stored);
    });

    it("lets a new value replace what cannot be read, field by field", async () => {
        expectLog("warn");
        const stored = await storedCredentials();

        await save({ ...blanks, fanartApiKey: "a fresh key" });

        expect(await getSystemSettings()).toMatchObject({ fanartApiKey: "a fresh key", slskdApiKey: null });
        expect(await storedCredentials()).toEqual({ ...stored, fanartApiKey: expect.not.stringMatching(stored.fanartApiKey!) });
    });

    it("keeps a credential through the setup wizard's blank key and its soulseek-off step", async () => {
        expectLog("warn");
        const stored = await storedCredentials();
        const wizard = (step: string, body: object) =>
            request(app()).post(`/onboarding/${step}`).set("Authorization", asAdmin()).send(body);

        expect((await wizard("audiobookshelf", { enabled: true, url: "http://localhost:1", apiKey: "" })).status).toBe(200);
        expect((await wizard("lidarr", { enabled: true, url: "http://localhost:1" })).status).toBe(200);
        expect((await wizard("soulseek", { enabled: false })).status).toBe(200);

        expect(await storedCredentials()).toEqual(stored);
    });
});

describe("the other two unreadable kinds", () => {
    const cases = [
        ["encrypted twice", () => encrypt(encrypt("lidarr-key-from-2024"))],
        ["in no encrypted format", () => "plaintext-never-encrypted"],
    ] as const;

    it.each(cases)("a value %s reads as not set, and survives a read and a blank save", async (_kind, value) => {
        expectLog("warn");
        const unreadable = value();
        await store({ lidarrApiKey: unreadable });

        expect((await get()).body.lidarrApiKey).toBeNull();
        await save({ lidarrApiKey: "" });

        expect((await storedCredentials()).lidarrApiKey).toBe(unreadable);
    });
});

describe("a readable credential", () => {
    it("can still be blanked", async () => {
        await store({ fanartApiKey: encrypt("a key that reads") });

        await save({ fanartApiKey: "" });

        expect(await getSystemSettings()).toMatchObject({ fanartApiKey: null });
        expect((await storedCredentials()).fanartApiKey).toBeFalsy();
    });

    it("can still be blanked through the setup wizard", async () => {
        await store({ soulseekPassword: encrypt("a password that reads") });

        await request(app()).post("/onboarding/soulseek").set("Authorization", asAdmin()).send({ enabled: false });

        expect((await storedCredentials()).soulseekPassword).toBeNull();
    });
});

describe("the notice to admins", () => {
    const notices = () =>
        prisma.notification.findMany({ where: { userId: ADMIN, cleared: false }, orderBy: { title: "asc" } });
    // The restarted copy has a logger of its own; the unreadable fields are logged through it.
    const restartExpectingWarnings = (): Server => {
        const server = restart();
        expectLog("warn", server.logger);
        return server;
    };
    const row = async () => prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } });

    it("comes once per field per process, and says what to do without saying anything was cleared", async () => {
        const server = restartExpectingWarnings();

        await server.readSettings(await row());
        await server.readSettings(await row());

        const sent = await notices();
        expect(sent.map((n) => n.title).sort()).toEqual(Object.values(ENCRYPTED_FIELDS).map((l) => `${l} cannot be read`).sort());
        for (const notice of sent) {
            expect(notice.message).toMatch(/restore .*SETTINGS_ENCRYPTION_KEY.* or enter .* again/i);
            expect(notice.message).not.toMatch(/clear/i);
        }
    });

    it("comes back after a restart, as one row per field", async () => {
        await restartExpectingWarnings().readSettings(await row());
        await prisma.notification.updateMany({ where: { userId: ADMIN }, data: { cleared: true } });

        await restartExpectingWarnings().readSettings(await row());

        expect(await notices()).toHaveLength(FIELDS.length);
        expect(await prisma.notification.count({ where: { userId: ADMIN } })).toBe(FIELDS.length);
    });

    it("goes away once the right key is back", async () => {
        await restartExpectingWarnings().readSettings(await row());
        expect(await notices()).toHaveLength(FIELDS.length);

        await restart(RIGHT_KEY).readSettings(await row());

        expect(await notices()).toHaveLength(0);
    });

    it("goes away when a new value replaces the unreadable one", async () => {
        const server = restartExpectingWarnings();
        await server.readSettings(await row());

        await store({ fanartApiKey: encrypt("a fresh key") });
        await server.readSettings(await row());

        expect((await notices()).map((n) => n.title)).not.toContain("Fanart.tv API key cannot be read");
        expect(await notices()).toHaveLength(FIELDS.length - 1);
    });
});
