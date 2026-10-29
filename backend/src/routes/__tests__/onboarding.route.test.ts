/**
 * The setup steps and the sign-up check. GET /onboarding/status trusts a token only as far as sign-in does: a refresh
 * token, a stream ticket or one revoked by a password change proves nothing. Turning a service off during setup is
 * saved even on a server with no settings row yet (Lidarr is on by default). Real database, router and tokens; the
 * connection tests reach a closed local port.
 */

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateRefreshToken, generateStreamTicket, generateToken, clearUserCache } from "../../middleware/auth";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { decrypt } from "../../utils/encryption";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import onboardingRoutes from "../onboarding";

const P = "zz-onboarding";
const ADMIN = `${P}-admin`;
const NEW = `${P}-new`;
const app = express().use(express.json()).use("/onboarding", onboardingRoutes);
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
        const res = await request(app).post(`/onboarding/${step}`).set(asAdmin()).send({ url: CLOSED, apiKey: "k", enabled: true }).expect(200);

        expect(res.body).toMatchObject({ success: true, tested: false, warning: expect.stringMatching(/saved/) });
        expect(await settings()).toMatchObject(saved);
    });

    it("stores the API key encrypted", async () => {
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
