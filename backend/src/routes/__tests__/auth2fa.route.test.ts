/**
 * Two-factor sign-in end to end: turning it on checks a code against the new secret and hands out ten one-time
 * recovery codes; signing in then needs a current code or one recovery code, once; turning it off needs the password
 * and a current code. A code is spent by use (RFC 6238 section 5.2): the same code, or an earlier step's, is refused
 * a second time, wherever it is sent. Real database, real encryption, real codes from the secret; the clock is fixed
 * and moved a step at a time, so which 30-second step a code belongs to never depends on when the test runs.
 */
jest.mock("../../middleware/rateLimiter", () => {
    const pass = (_req: any, _res: any, next: any) => next();
    return new Proxy({}, { get: () => pass });
});

import crypto from "crypto";
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import speakeasy from "speakeasy";
import { prisma } from "../../utils/db";
import { encrypt } from "../../utils/encryption";
import { generateToken, clearUserCache } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import authRoutes from "../auth";
import { mountAsServer } from "./helpers/serverMount";

const USER = "zz-2fa-user";
const PASSWORD = "correct horse";
const app = mountAsServer(express().use(express.json()), "/auth", authRoutes, "/api/auth");
const bearer = () => `Bearer ${generateToken({ id: USER, username: USER, role: "user", tokenVersion: 0 })}`;
const login = (token?: string) => request(app).post("/auth/login").send({ username: USER, password: PASSWORD, ...(token ? { token } : {}) });
const enable = (token: string) => request(app).post("/auth/2fa/enable").set("Authorization", bearer()).send({ secret, token });
const disable = (token: string, password = PASSWORD) => request(app).post("/auth/2fa/disable").set("Authorization", bearer()).send({ password, token });
const secret = speakeasy.generateSecret({ length: 20 }).base32;

const STEP_MS = 30_000;
let clock = 1_800_000_000_000;
/** The code for the step `offset` steps from the fixed clock; the server accepts two either side of its own. */
const codeAt = (offset: number) => speakeasy.totp({ secret, encoding: "base32", time: (clock + offset * STEP_MS) / 1000 });
const codeNow = () => codeAt(0);
const nextStep = () => { clock += STEP_MS; };

/** Puts the account in the state turning 2FA on leaves it in, with ten known recovery codes. */
async function twoFactorOn(): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString("hex").toUpperCase());
    const hashes = codes.map((code) => crypto.createHash("sha256").update(code).digest("hex"));
    await prisma.user.update({
        where: { id: USER },
        data: { twoFactorEnabled: true, twoFactorSecret: encrypt(secret), twoFactorRecoveryCodes: encrypt(hashes.join(",")), twoFactorLastStep: 0 },
    });
    return codes;
}

beforeAll(async () => {
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: await bcrypt.hash(PASSWORD, 10), role: "user", tokenVersion: 0 } });
});

beforeEach(async () => {
    // Each test starts steps away from the last, with the account back to just-switched-off.
    clock += 20 * STEP_MS;
    clearUserCache();
    await prisma.user.update({
        where: { id: USER },
        data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: null, twoFactorLastStep: 0 },
    });
});

afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("turning it on", () => {
    it("refuses a wrong code, and a right one hands out ten recovery codes", async () => {
        await enable("000000").expect(400);

        const res = await enable(codeNow()).expect(200);

        expect(res.body.recoveryCodes).toHaveLength(10);
        for (const code of res.body.recoveryCodes) expect(code).toMatch(/^[0-9A-F]{8}$/);
    });

    it("spends the code it was turned on with, so that code cannot then sign in, but the next step's can", async () => {
        const enabling = codeNow();
        await enable(enabling).expect(200);

        expect((await login(enabling)).status).toBe(401);
        nextStep();
        expect((await login(codeNow())).status).toBe(200);
    });
});

describe("signing in with a code", () => {
    it("asks for a code, refuses a wrong one, and takes a current one", async () => {
        await twoFactorOn();

        expect((await login().expect(200)).body).toMatchObject({ requires2FA: true });
        expect((await login("000000")).status).toBe(401);
        expect((await login(codeNow()).expect(200)).body.token).toEqual(expect.any(String));
    });

    it("reads a code sent as a number like one sent as text, and never fails on one", async () => {
        await twoFactorOn();
        const send = (token: unknown) => request(app).post("/auth/login").send({ username: USER, password: PASSWORD, token });

        expect((await send(12345678)).status).toBe(401);
        expect((await send(Number(codeNow()))).status).toBe(codeNow().startsWith("0") ? 401 : 200);
    });

    it("refuses a code the second time, and takes a later step's", async () => {
        await twoFactorOn();
        const code = codeNow();

        expect((await login(code)).status).toBe(200);
        expect((await login(code)).status).toBe(401);
        nextStep();
        expect((await login(codeNow())).status).toBe(200);
    });

    it("refuses a code from an earlier step once a later one was used, though it still fits the clock", async () => {
        await twoFactorOn();
        const earlier = codeAt(-1);
        const later = codeAt(0);

        expect((await login(later)).status).toBe(200);
        expect((await login(earlier)).status).toBe(401);
    });

    it("takes a code once when two sign-ins send it together", async () => {
        await twoFactorOn();
        const code = codeNow();

        const results = await Promise.all([login(code), login(code)]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it("keeps a spent code spent when the person turns it off and on again with the same secret", async () => {
        await twoFactorOn();
        const code = codeNow();
        expect((await login(code)).status).toBe(200);
        nextStep();
        await disable(codeNow()).expect(200);
        const again = codeAt(0);

        // Turning it back on with this step's code spends it; the code from before is older still.
        await enable(again).expect(200);
        expect((await login(again)).status).toBe(401);
        expect((await login(code)).status).toBe(401);
    });
});

describe("a recovery code", () => {
    it("is taken once, in either case", async () => {
        const [code] = await twoFactorOn();

        expect((await login(code.toLowerCase()).expect(200)).body.token).toEqual(expect.any(String));
        expect((await login(code)).status).toBe(401);
    });

    it("is taken once even when two sign-ins send it together", async () => {
        const codes = await twoFactorOn();

        const results = await Promise.all([login(codes[1]), login(codes[1])]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
        expect((await login(codes[1])).status).toBe(401);
        expect((await login(codes[2]).expect(200)).body.token).toEqual(expect.any(String));
    });

    it("lets sign-ins send different codes together, each succeeding once", async () => {
        const codes = await twoFactorOn();

        const results = await Promise.all([login(codes[3]), login(codes[4]), login(codes[5])]);

        expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
        for (const i of [3, 4, 5]) expect((await login(codes[i])).status).toBe(401);
        expect((await login(codes[6])).status).toBe(200);
    });

    it("leaves the other codes in the list when two different ones are spent together", async () => {
        const codes = await twoFactorOn();

        await Promise.all([login(codes[0]), login(codes[1])]);

        for (const i of [2, 3, 4, 5, 6, 7, 8, 9]) expect((await login(codes[i])).status).toBe(200);
    });
});

describe("turning it off", () => {
    it("needs the password and a current code", async () => {
        await twoFactorOn();

        await disable(codeNow(), "wrong").expect(400);
        await disable("000000").expect(400);
        await disable(codeNow()).expect(200);
        expect((await login().expect(200)).body.token).toEqual(expect.any(String));
    });

    it("refuses a code that was just used to sign in", async () => {
        await twoFactorOn();
        const code = codeNow();
        expect((await login(code)).status).toBe(200);

        await disable(code).expect(400);

        expect((await login()).body.requires2FA).toBe(true);
        nextStep();
        await disable(codeNow()).expect(200);
    });

    it("spends the code it takes, so a sign-in sending it at once cannot also succeed", async () => {
        await twoFactorOn();
        const code = codeNow();

        await disable(code).expect(200);
        await enable(codeAt(1)).expect(200);

        // The account has 2FA again; the code the disable used is older than the step that turned it back on.
        expect((await login(code)).status).toBe(401);
    });
});

it("refuses an unknown name and a wrong password alike", async () => {
    const unknown = await request(app).post("/auth/login").send({ username: "zz-2fa-nobody", password: PASSWORD });
    const wrong = await request(app).post("/auth/login").send({ username: USER, password: "nope" });
    expect([unknown.status, unknown.body]).toEqual([401, { error: "Invalid credentials" }]);
    expect([wrong.status, wrong.body]).toEqual([401, { error: "Invalid credentials" }]);
});
