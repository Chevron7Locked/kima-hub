/**
 * The setup steps and the sign-up check. GET /onboarding/status trusts a token only as far as sign-in does: a refresh
 * token, a stream ticket or one revoked by a password change proves nothing. Turning a service off during setup is
 * saved even on a server with no settings row yet (Lidarr is on by default). Real database, router and tokens; the
 * connection tests reach a closed local port.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import jwt from "jsonwebtoken";
import { generateRefreshToken, generateStreamTicket, generateToken, clearUserCache, JWT_SECRET_VALIDATED } from "../../middleware/auth";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { decrypt } from "../../utils/encryption";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { lidarrService } from "../../services/lidarr";
import { audiobookshelfService } from "../../services/audiobookshelf";
import { audiobookCacheService } from "../../services/audiobookCache";
import { whenRequestWorkEnded } from "../../utils/stopCheck";
import onboardingRoutes from "../onboarding";
import authRoutes from "../auth";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const P = "zz-onboarding";
const ADMIN = `${P}-admin`;
const NEW = `${P}-new`;
const app = mountAsServer(
    mountAsServer(express().use(express.json()), "/onboarding", onboardingRoutes, "/api/onboarding"),
    "/auth",
    authRoutes,
    "/api/auth",
);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const asAdmin = () => bearer(generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 }));
const CLOSED = "http://127.0.0.1:1";

let before: Record<string, unknown> | null;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0, onboardingComplete: true } });
    await prisma.user.create({ data: { id: NEW, username: NEW, passwordHash: "x", role: "user", tokenVersion: 3, onboardingComplete: false } });
});

beforeEach(() => {
    clearUserCache();
    invalidateSystemSettingsCache();
});

afterAll(async () => {
    await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    if (before) await prisma.systemSettings.create({ data: before as any });
    invalidateSystemSettingsCache();
    await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
    await closeEngineConnections();
});

const status = (headers: Record<string, string> = {}) => request(app).get("/onboarding/status").set(headers).expect(200);
const basic = { needsOnboarding: false, hasAccount: true };

describe("GET /onboarding/status", () => {
    it("answers without a token from the accounts alone", async () => {
        expect((await status()).body).toMatchObject(basic);
    });

    it("tells a signed-in listener whether they still need setup", async () => {
        const token = generateToken({ id: NEW, username: NEW, role: "user", tokenVersion: 3 });
        expect((await status(bearer(token))).body).toMatchObject({ needsOnboarding: true, hasAccount: true });
    });

    it.each([
        ["a refresh token", () => generateRefreshToken({ id: NEW, tokenVersion: 3 })],
        ["a stream ticket", () => generateStreamTicket({ id: NEW, tokenVersion: 3 })],
        ["a token from before a password change", () => generateToken({ id: NEW, username: NEW, role: "user", tokenVersion: 2 })],
        ["a token for a deleted account", () => generateToken({ id: `${P}-gone`, username: "gone", role: "user", tokenVersion: 0 })],
        ["a token that does not verify", () => "not.a.token"],
    ])("treats %s as no sign-in", async (_what, token) => {
        expect((await status(bearer(token()))).body).toMatchObject(basic);
    });

    it("reports whether sign-up is open", async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", registrationOpen: true }, update: { registrationOpen: true } });
        expect((await status()).body.registrationOpen).toBe(true);
        await prisma.systemSettings.update({ where: { id: "default" }, data: { registrationOpen: false } });
        expect((await status()).body.registrationOpen).toBe(false);
    });
});

describe("POST /onboarding/register", () => {
    it("refuses a new account while sign-up is closed, and takes one when open", async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { registrationOpen: false } });
        await request(app).post("/onboarding/register").send({ username: `${P}-r1`, password: "secret1" }).expect(403);

        await prisma.systemSettings.update({ where: { id: "default" }, data: { registrationOpen: true } });
        const res = await request(app).post("/onboarding/register").send({ username: `${P}-r1`, password: "secret1" }).expect(200);
        expect(res.body.user).toMatchObject({ username: `${P}-r1`, role: "user", onboardingComplete: false });
        expect(res.body.token).toEqual(expect.any(String));
    });

    it("signs the new account in as login does, with a refresh token that renews its session", async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { registrationOpen: true } });
        const res = await request(app).post("/onboarding/register").send({ username: `${P}-r2`, password: "secret1" }).expect(200);
        const account = await prisma.user.findUniqueOrThrow({ where: { username: `${P}-r2` } });
        expect(jwt.verify(res.body.refreshToken, JWT_SECRET_VALIDATED)).toMatchObject({
            userId: account.id,
            tokenVersion: account.tokenVersion,
            type: "refresh",
        });

        const renewed = await request(app).post("/auth/refresh").send({ refreshToken: res.body.refreshToken }).expect(200);
        expect(renewed.body.token).toEqual(expect.any(String));
        const me = await request(app).get("/onboarding/status").set(bearer(renewed.body.token)).expect(200);
        expect(me.body.needsOnboarding).toBe(true);
    });

    it("answers a name already in use with 'taken', and a short password with the rule", async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", registrationOpen: true }, update: { registrationOpen: true } });

        const taken = await request(app).post("/onboarding/register").send({ username: ADMIN, password: "secret1" }).expect(400);
        expect(taken.body.error).toBe("Username already taken");

        const short = await request(app).post("/onboarding/register").send({ username: `${P}-short`, password: "12345" }).expect(400);
        expect(short.body.error).toBe("Password must be at least 6 characters");
        expect(await prisma.user.count({ where: { username: `${P}-short` } })).toBe(0);
    });

    it("answers a 73-byte password and 2- and 51-character usernames with 400, creating nothing", async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", registrationOpen: true }, update: { registrationOpen: true } });
        const before = await prisma.user.count();

        const long = await request(app).post("/onboarding/register").send({ username: `${P}-long`, password: "a".repeat(73) }).expect(400);
        expect(long.body.error).toMatch(/^Password must be at most 72 characters/);
        const multibyte = await request(app).post("/onboarding/register").send({ username: `${P}-mb`, password: "é".repeat(37) }).expect(400);
        expect(multibyte.body.error).toMatch(/at most 72 characters/);
        const tiny = await request(app).post("/onboarding/register").send({ username: "ab", password: "secret1" }).expect(400);
        expect(tiny.body.error).toBe("Username must be 3 to 50 characters");
        await request(app).post("/onboarding/register").send({ username: "a".repeat(51), password: "secret1" }).expect(400);

        expect(await prisma.user.count()).toBe(before);
    });

    it("trims the username, and refuses one of only spaces", async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", registrationOpen: true }, update: { registrationOpen: true } });

        await request(app).post("/onboarding/register").send({ username: "      ", password: "secret1" }).expect(400);
        const res = await request(app).post("/onboarding/register").send({ username: `  ${P}-padded `, password: "secret1" }).expect(200);
        expect(res.body.user.username).toBe(`${P}-padded`);
        expect(await prisma.user.count({ where: { username: `${P}-padded` } })).toBe(1);
    });

    it("answers two sign-ups for one name with one account and 'taken' for the other", async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", registrationOpen: true }, update: { registrationOpen: true } });

        const replies = await Promise.all(
            [1, 2, 3].map(() => request(app).post("/onboarding/register").send({ username: `${P}-race`, password: "secret1" })),
        );

        expect(replies.map((r) => r.status).sort()).toEqual([200, 400, 400]);
        expect(replies.filter((r) => r.status === 400).every((r) => r.body.error === "Username already taken")).toBe(true);
        expect(await prisma.user.count({ where: { username: `${P}-race` } })).toBe(1);
    });
});

describe("the service steps", () => {
    const settings = () => prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } });

    it.each([
        ["lidarr", "lidarrEnabled"],
        ["audiobookshelf", "audiobookshelfEnabled"],
    ] as const)("%s turned off is saved on a server with no settings yet", async (step, field) => {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();

        await request(app).post(`/onboarding/${step}`).set(asAdmin()).send({ url: "", apiKey: "", enabled: false }).expect(200);

        expect((await settings())[field]).toBe(false);
    });

    it.each([
        ["lidarr", { lidarrEnabled: true, lidarrUrl: CLOSED }],
        ["audiobookshelf", { audiobookshelfEnabled: true, audiobookshelfUrl: CLOSED }],
    ] as const)("%s saves the address even when the connection test fails", async (step, saved) => {
        expectLog("warn");
        const res = await request(app).post(`/onboarding/${step}`).set(asAdmin()).send({ url: CLOSED, apiKey: "k", enabled: true }).expect(200);

        expect(res.body).toMatchObject({ success: true, tested: false, warning: expect.stringMatching(/saved/) });
        expect(await settings()).toMatchObject(saved);
    });

    it("stores the API key encrypted", async () => {
        expectLog("warn");
        await request(app).post("/onboarding/lidarr").set(asAdmin()).send({ url: CLOSED, apiKey: "the-key", enabled: true }).expect(200);

        const stored = (await settings()).lidarrApiKey!;
        expect(stored).toMatch(/^xc1\./);
        expect(decrypt(stored)).toBe("the-key");
    });

    it.each(["lidarr", "audiobookshelf"])("%s refuses an address that is not a URL", async (step) => {
        await request(app).post(`/onboarding/${step}`).set(asAdmin()).send({ url: "not a url", apiKey: "k", enabled: true }).expect(400);
    });

    it("soulseek needs both the username and the password", async () => {
        await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "", enabled: true }).expect(400);
    });

    it("a member cannot set up a service", async () => {
        const member = bearer(generateToken({ id: NEW, username: NEW, role: "user", tokenVersion: 3 }));
        await request(app).post("/onboarding/lidarr").set(member).send({ url: "", apiKey: "", enabled: false }).expect(403);
    });
});

describe("a saved step reaches whatever holds the setting", () => {
    const reload = {
        lidarr: jest.spyOn(lidarrService, "reinitialize"),
        audiobookshelf: jest.spyOn(audiobookshelfService, "reinitialize"),
    };
    let reconnect: jest.SpyInstance;
    let soulseekService: typeof import("../../services/soulseek").soulseekService;

    beforeAll(async () => {
        // Soulseek starts connecting as it loads when it is enabled; it is not.
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", soulseekEnabled: false }, update: { soulseekEnabled: false } });
        invalidateSystemSettingsCache();
        ({ soulseekService } = await import("../../services/soulseek"));
        reconnect = jest.spyOn(soulseekService, "resetAndReconnect").mockResolvedValue(undefined);
    });

    beforeEach(async () => {
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { lidarrUrl: null, lidarrApiKey: null, audiobookshelfUrl: null, audiobookshelfApiKey: null, soulseekUsername: null, soulseekPassword: null },
        });
        invalidateSystemSettingsCache();
        jest.clearAllMocks();
    });

    afterAll(() => soulseekService.disconnect());

    it("Lidarr is reloaded by its own step, not by the last one", async () => {
        expectLog("warn");
        await request(app).post("/onboarding/lidarr").set(asAdmin()).send({ url: CLOSED, apiKey: "k", enabled: true }).expect(200);

        expect(reload.lidarr).toHaveBeenCalledTimes(1);
        expect(reload.audiobookshelf).not.toHaveBeenCalled();
    });

    it("Audiobookshelf is reloaded by its own step", async () => {
        expectLog("warn");
        await request(app).post("/onboarding/audiobookshelf").set(asAdmin()).send({ url: CLOSED, apiKey: "k", enabled: true }).expect(200);

        expect(reload.audiobookshelf).toHaveBeenCalledTimes(1);
        expect(reload.lidarr).not.toHaveBeenCalled();
    });

    it("finishing setup reloads nothing again", async () => {
        await request(app).post("/onboarding/complete").set(asAdmin()).expect(200);

        expect(reload.lidarr).not.toHaveBeenCalled();
        expect(reload.audiobookshelf).not.toHaveBeenCalled();
    });

    it("finishing setup starts the audiobook sync as work the shutdown waits for, and hands it the stop check", async () => {
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", audiobookshelfEnabled: true },
            update: { audiobookshelfEnabled: true },
        });
        invalidateSystemSettingsCache();
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const sync = jest.spyOn(audiobookCacheService, "syncAll").mockImplementation(async () => {
            await held;
            return { synced: 0, failed: 0, skipped: 0, errors: [] };
        });
        try {
            await request(app).post("/onboarding/complete").set(asAdmin()).expect(200);
            for (let i = 0; i < 200 && sync.mock.calls.length === 0; i++) await new Promise((r) => setImmediate(r));
            expect(sync).toHaveBeenCalledWith({ shouldStop: expect.any(Function) });

            let drained = false;
            const waiting = whenRequestWorkEnded().then(() => (drained = true));
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
            expect(drained).toBe(false);

            release();
            await waiting;
            expect(drained).toBe(true);
        } finally {
            release();
            sync.mockRestore();
            await prisma.systemSettings.update({ where: { id: "default" }, data: { audiobookshelfEnabled: false } });
            invalidateSystemSettingsCache();
        }
    });

    it("a new Soulseek account reconnects once, not twice", async () => {
        expectLog("error");
        expectLog("warn");
        const res = await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "pw", enabled: true }).expect(200);

        expect(reconnect).toHaveBeenCalledTimes(1);
        expect(res.body.tested).toBe(false);
    });

    it("a Soulseek account the save connected is reported as tested", async () => {
        const connected = jest.spyOn(soulseekService, "isConnected").mockReturnValue(true);
        try {
            const res = await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "pw", enabled: true }).expect(200);

            expect(res.body).toMatchObject({ success: true, tested: true, warning: null });
        } finally {
            connected.mockRestore();
        }
    });

    it("a new Soulseek account is tested once the save's own reconnect has finished", async () => {
        let connectedNow = false;
        const connected = jest.spyOn(soulseekService, "isConnected").mockImplementation(() => connectedNow);
        const settled = jest.spyOn(soulseekService, "reconnectSettled").mockImplementation(
            () => new Promise<void>((resolve) => setTimeout(() => { connectedNow = true; resolve(); }, 50)),
        );
        try {
            const res = await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "pw", enabled: true }).expect(200);

            expect(res.body).toMatchObject({ success: true, tested: true, warning: null });
            expect(reconnect).toHaveBeenCalledTimes(1);
        } finally {
            connected.mockRestore();
            settled.mockRestore();
        }
    });

    it("the same Soulseek account sent again is tried again", async () => {
        expectLog("warn");
        await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "pw", enabled: true }).expect(200);
        reconnect.mockClear();

        await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "pw", enabled: true }).expect(200);

        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it("finishing the Soulseek step turns the integration on, and turning it off turns it off", async () => {
        const enabled = async () => (await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).soulseekEnabled;
        await prisma.systemSettings.update({ where: { id: "default" }, data: { soulseekEnabled: false } });

        await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "pw", enabled: true }).expect(200);
        expect(await enabled()).toBe(true);

        await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ enabled: false }).expect(200);
        expect(await enabled()).toBe(false);

        await prisma.systemSettings.update({ where: { id: "default" }, data: { soulseekEnabled: true } });
    });

    it("Soulseek turned off clears the account", async () => {
        expectLog("warn");
        await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ username: "me", password: "pw", enabled: true }).expect(200);

        await request(app).post("/onboarding/soulseek").set(asAdmin()).send({ enabled: false }).expect(200);

        expect(await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).toMatchObject({ soulseekUsername: null, soulseekPassword: null });
    });
});
