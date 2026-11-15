/**
 * Two-factor sign-in end to end: setup keeps a pending secret on the server for ten minutes; turning it on checks a
 * code against that secret (never one the client sends) and hands out ten one-time recovery codes; signing in then
 * needs a current code or one recovery code, once; turning it off, or replacing the recovery codes, needs the password
 * and a current code or a recovery code; an admin can turn it off for someone whose secret cannot be read. A code is spent by use (RFC 6238 section 5.2): the same code, or an earlier step's, is refused
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
import { logger } from "../../utils/logger";
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
const enable = (token: unknown, body: object = {}) => request(app).post("/auth/2fa/enable").set("Authorization", bearer()).send({ token, ...body });
const disable = (token: unknown, password: unknown = PASSWORD) => request(app).post("/auth/2fa/disable").set("Authorization", bearer()).send({ password, token });
const newCodes = (token: unknown, password: unknown = PASSWORD) => request(app).post("/auth/2fa/recovery-codes").set("Authorization", bearer()).send({ password, token });
const setup = () => request(app).post("/auth/2fa/setup").set("Authorization", bearer());
const secret = speakeasy.generateSecret({ length: 20 }).base32;
/** Stored text the key cannot open: the right format, but no sealed value under this key. */
const UNREADABLE = "xc1." + Buffer.alloc(60, 7).toString("base64url");
const stored = () => prisma.user.findUniqueOrThrow({
    where: { id: USER },
    select: { twoFactorEnabled: true, twoFactorSecret: true, twoFactorRecoveryCodes: true, twoFactorLastStep: true, twoFactorPendingSecret: true, twoFactorPendingAt: true },
});

const STEP_MS = 30_000;
let clock = 1_800_000_000_000;
/** The code for the step `offset` steps from the fixed clock; the server accepts two either side of its own. */
const codeAt = (offset: number) => speakeasy.totp({ secret, encoding: "base32", time: (clock + offset * STEP_MS) / 1000 });
const codeNow = () => codeAt(0);
const nextStep = () => { clock += STEP_MS; };
const codeFor = (base32: string) => speakeasy.totp({ secret: base32, encoding: "base32", time: clock / 1000 });

/** Puts the account where setup leaves it: `secret` waiting, made now, for the code to be proved. */
async function setupDone(pending: string = secret): Promise<void> {
    await prisma.user.update({ where: { id: USER }, data: { twoFactorPendingSecret: encrypt(pending), twoFactorPendingAt: new Date(clock) } });
}

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
        data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: null, twoFactorLastStep: 0, twoFactorPendingSecret: null, twoFactorPendingAt: null },
    });
});

afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("setting it up", () => {
    it("hands out a secret and a QR code, and keeps the secret on the server, sealed, until a code proves it", async () => {
        const res = await setup().expect(200);

        expect(res.body.secret).toMatch(/^[A-Z2-7]+$/);
        expect(res.body.qrCode).toMatch(/^data:image\/png/);
        const kept = await stored();
        expect(kept.twoFactorEnabled).toBe(false);
        expect(kept.twoFactorPendingSecret).toEqual(expect.any(String));
        expect(kept.twoFactorPendingSecret).not.toContain(res.body.secret);
    });

    it("turns on with a code from that secret, and nothing the client says about the secret changes that", async () => {
        const made = (await setup().expect(200)).body.secret as string;
        const other = speakeasy.generateSecret({ length: 20 }).base32;

        // A code from a secret the client names is refused, even though the client names it as the secret.
        await enable(codeFor(other), { secret: other }).expect(400);
        expect((await stored()).twoFactorEnabled).toBe(false);

        // The server's own secret is the one checked, whatever the client sends beside it.
        const res = await enable(codeFor(made), { secret: other }).expect(200);
        expect(res.body.recoveryCodes).toHaveLength(10);
        nextStep();
        expect((await login(codeFor(made))).status).toBe(200);
        nextStep();
        expect((await login(codeFor(other))).status).toBe(401);
        expect((await stored()).twoFactorPendingSecret).toBeNull();
    });

    it("replaces the pending secret when setup is run again", async () => {
        const first = (await setup().expect(200)).body.secret as string;
        const second = (await setup().expect(200)).body.secret as string;

        expect(second).not.toBe(first);
        await enable(codeFor(first)).expect(400);
        await enable(codeFor(second)).expect(200);
    });

    it("lets a wrong code be tried again against the same pending secret", async () => {
        const made = (await setup().expect(200)).body.secret as string;

        await enable("000000").expect(400);

        await enable(codeFor(made)).expect(200);
    });

    it("forgets the pending secret after ten minutes, and says to start setup again", async () => {
        const made = (await setup().expect(200)).body.secret as string;
        clock += 10 * 60_000 + STEP_MS;

        const res = await enable(codeFor(made));

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/set up again|start setup/i);
        expect((await stored()).twoFactorEnabled).toBe(false);
    });

    it("keeps a pending secret still good just inside ten minutes", async () => {
        const made = (await setup().expect(200)).body.secret as string;
        clock += 9 * 60_000;

        await enable(codeFor(made)).expect(200);
    });

    it("refuses to turn on when no setup was run, whatever secret the client sends", async () => {
        const res = await enable(codeNow(), { secret });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/set up again|start setup/i);
        expect((await stored()).twoFactorEnabled).toBe(false);
    });

    it("refuses to turn on when the pending secret cannot be read, and setup then makes a new one", async () => {
        await prisma.user.update({ where: { id: USER }, data: { twoFactorPendingSecret: UNREADABLE, twoFactorPendingAt: new Date(clock) } });

        await enable(codeNow()).expect(400);

        const made = (await setup().expect(200)).body.secret as string;
        await enable(codeFor(made)).expect(200);
    });
});

describe("turning it on", () => {
    it("refuses a wrong code, and a right one hands out ten recovery codes", async () => {
        await setupDone();
        await enable("000000").expect(400);

        const res = await enable(codeNow()).expect(200);

        expect(res.body.recoveryCodes).toHaveLength(10);
        for (const code of res.body.recoveryCodes) expect(code).toMatch(/^[0-9A-F]{16}$/);
    });

    it("spends the code it was turned on with, so that code cannot then sign in, but the next step's can", async () => {
        await setupDone();
        const enabling = codeNow();
        await enable(enabling).expect(200);

        expect((await login(enabling)).status).toBe(401);
        nextStep();
        expect((await login(codeNow())).status).toBe(200);
    });
});

describe("turning it on while it is on", () => {
    it("is refused at setup and at enable, and leaves the secret, the recovery codes and the spent step as they were", async () => {
        const codes = await twoFactorOn();
        const before = await stored();
        const newSecret = speakeasy.generateSecret({ length: 20 }).base32;

        expect((await setup()).status).toBe(400);
        const res = await enable(codeFor(newSecret), { secret: newSecret });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already enabled/i);
        expect(await stored()).toEqual(before);
        expect((await login(codes[0]).expect(200)).body.token).toEqual(expect.any(String));
        nextStep();
        expect((await login(codeNow())).status).toBe(200);
    });

    it("does not let two requests turn it on at once", async () => {
        await setupDone();
        const code = codeNow();

        const results = await Promise.all([enable(code), enable(code)]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    });

    it("keeps the step that turned it on spent, so an earlier step's code cannot sign in", async () => {
        await twoFactorOn();
        await disable(codeNow()).expect(200);

        await setupDone();
        await enable(codeAt(1)).expect(200);

        expect((await login(codeAt(0))).status).toBe(401);
    });
});

describe("turning it off clears the spent step", () => {
    it("whichever kind of code turned it off: the step is back to nothing spent, with the secret gone", async () => {
        const [recovery] = await twoFactorOn();
        expect((await login(codeNow())).status).toBe(200);
        expect((await stored()).twoFactorLastStep).toBeGreaterThan(0);

        await disable(recovery).expect(200);
        expect(await stored()).toMatchObject({ twoFactorEnabled: false, twoFactorSecret: null, twoFactorLastStep: 0 });

        await twoFactorOn();
        await disable(codeNow()).expect(200);
        expect((await stored()).twoFactorLastStep).toBe(0);
    });

    it("leaves the session alone: the signed-in token still works afterwards", async () => {
        await twoFactorOn();

        await disable(codeNow()).expect(200);

        await request(app).get("/auth/2fa/status").set("Authorization", bearer()).expect(200);
    });
});

describe("a credential the key cannot read", () => {
    let warn: jest.SpyInstance;
    beforeEach(() => { warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined as never); });
    afterEach(() => warn.mockRestore());

    it("refuses the sign-in cleanly, keeps the stored secret, and logs why once per attempt", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: UNREADABLE } });
        const before = await stored();

        for (const attempt of [login(), login("123456")]) {
            const res = await attempt;
            expect(res.status).toBe(401);
            expect(res.body.token).toBeUndefined();
        }

        expect(await stored()).toEqual(before);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("does not count a refusal after the right password as a wrong guess, so it never locks the account", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: UNREADABLE } });

        for (let i = 0; i < 25; i++) expect((await login()).status).toBe(401);
    });

    it("refuses a sign-in when 2FA is on but no secret is stored, rather than signing in without a code", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: null } });

        const res = await login();

        expect(res.status).toBe(401);
        expect(res.body.token).toBeUndefined();
        expect((await stored()).twoFactorEnabled).toBe(true);
    });

    const listWarnings = () => warn.mock.calls.filter((call) => String(call[0]).includes("recovery-code list")).length;

    it("refuses a recovery code when the list is unreadable, keeps the list, and still takes a current code", async () => {
        const [code] = await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorRecoveryCodes: UNREADABLE } });

        expect((await login(code)).status).toBe(401);
        expect((await stored()).twoFactorRecoveryCodes).toBe(UNREADABLE);
        expect((await login(codeNow())).status).toBe(200);
    });

    it("logs an unreadable recovery list once per sign-in that sends a code, whatever the code looks like", async () => {
        const [code] = await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorRecoveryCodes: UNREADABLE } });

        await login(code);
        expect(listWarnings()).toBe(1);
        await login("000000");
        expect(listWarnings()).toBe(2);
        await login(codeNow());
        expect(listWarnings()).toBe(3);
    });

    it("does not log it when the sign-in only asks for a code, or on the other 2FA routes", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorRecoveryCodes: UNREADABLE } });

        await login();
        await request(app).get("/auth/2fa/status").set("Authorization", bearer());
        await newCodes("0000000A");
        await disable("0000000A");
        await disable(codeNow());

        expect(listWarnings()).toBe(0);
    });

    it("does not log a readable list", async () => {
        const [code] = await twoFactorOn();

        await login(code);

        expect(listWarnings()).toBe(0);
    });

    it("is not turned off by the disable route, with or without a right code, and is left as it is", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: UNREADABLE } });
        const before = await stored();

        expect((await disable(codeNow())).status).toBe(409);
        expect((await disable("000000")).status).toBe(409);

        expect(await stored()).toEqual(before);
    });

    it("is not turned off by the disable route when 2FA is on with no secret stored", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: null } });

        expect((await disable("000000")).status).toBe(409);

        expect((await stored()).twoFactorEnabled).toBe(true);
    });

    it("still asks a wrong password first, before saying anything about the credential", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: UNREADABLE } });

        await disable(codeNow(), "wrong").expect(400);
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
        await setupDone();
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

describe("the clock window", () => {
    it("takes a code one step either side of now, and refuses two steps either side", async () => {
        await twoFactorOn();

        expect((await login(codeAt(-2))).status).toBe(401);
        expect((await login(codeAt(2))).status).toBe(401);
        expect((await login(codeAt(-1))).status).toBe(200);
        nextStep();
        nextStep();
        expect((await login(codeAt(1))).status).toBe(200);
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
        await setupDone();
        await enable(codeAt(1)).expect(200);

        // The account has 2FA again; the code the disable used is older than the step that turned it back on.
        expect((await login(code)).status).toBe(401);
    });
});

describe("turning it off with a recovery code", () => {
    it("works for a person who lost their phone, spends the code, and clears everything stored", async () => {
        const [code] = await twoFactorOn();

        await disable(code.toLowerCase()).expect(200);

        const after = await stored();
        expect(after).toMatchObject({ twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: null, twoFactorPendingSecret: null });
        expect((await login().expect(200)).body.token).toEqual(expect.any(String));
    });

    it("refuses a wrong recovery code and one already used, and leaves it on", async () => {
        const [code] = await twoFactorOn();

        await disable("DEADBEEF").expect(400);
        expect((await login(code)).status).toBe(200);
        await disable(code).expect(400);

        expect((await stored()).twoFactorEnabled).toBe(true);
    });

    it("still asks the password first", async () => {
        const [code] = await twoFactorOn();

        await disable(code, "wrong").expect(400);

        expect((await stored()).twoFactorEnabled).toBe(true);
        expect((await login(code)).status).toBe(200);
    });

    it("refuses a recovery code when the list cannot be read, and leaves it on", async () => {
        const [code] = await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorRecoveryCodes: UNREADABLE } });
        jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);

        await disable(code).expect(400);

        expect((await stored()).twoFactorEnabled).toBe(true);
        jest.mocked(logger.warn).mockRestore();
    });
});

describe("new recovery codes", () => {
    it("replace the whole list: ten new codes come back once, the old ones stop working, the new ones work", async () => {
        const old = await twoFactorOn();

        const res = await newCodes(codeNow()).expect(200);

        const fresh: string[] = res.body.recoveryCodes;
        expect(fresh).toHaveLength(10);
        for (const code of fresh) expect(code).toMatch(/^[0-9A-F]{16}$/);
        expect(fresh.some((code) => old.includes(code))).toBe(false);
        expect((await login(old[0])).status).toBe(401);
        expect((await login(fresh[0])).status).toBe(200);
        expect((await login(fresh[0])).status).toBe(401);
        expect((await stored()).twoFactorEnabled).toBe(true);
    });

    it("can be asked for with a recovery code, which is spent", async () => {
        const [code] = await twoFactorOn();

        const res = await newCodes(code).expect(200);

        expect(res.body.recoveryCodes).toHaveLength(10);
        expect((await login(code)).status).toBe(401);
    });

    it("need the password and a right code, and change nothing when either is wrong", async () => {
        const old = await twoFactorOn();
        const before = await stored();

        await newCodes(codeNow(), "wrong").expect(400);
        await newCodes("000000").expect(400);
        await newCodes("DEADBEEF").expect(400);

        expect(await stored()).toEqual(before);
        expect((await login(old[0])).status).toBe(200);
    });

    it("spend the code they are asked with, so it cannot also sign in", async () => {
        await twoFactorOn();
        const code = codeNow();

        await newCodes(code).expect(200);

        expect((await login(code)).status).toBe(401);
    });

    it("are refused while 2FA is off", async () => {
        const res = await newCodes(codeNow());

        expect(res.status).toBe(400);
        expect((await stored()).twoFactorRecoveryCodes).toBeNull();
    });

    it("are refused, and nothing changes, when the secret cannot be read", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: UNREADABLE } });
        jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);
        const before = await stored();

        await newCodes(codeNow()).expect(409);

        expect(await stored()).toEqual(before);
        jest.mocked(logger.warn).mockRestore();
    });

    it("replace an unreadable list when the person proves a current code", async () => {
        await twoFactorOn();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorRecoveryCodes: UNREADABLE } });
        jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);

        const res = await newCodes(codeNow()).expect(200);

        nextStep();
        expect((await login(res.body.recoveryCodes[0])).status).toBe(200);
        jest.mocked(logger.warn).mockRestore();
    });
});

describe("what the log says about 2FA", () => {
    let info: jest.SpyInstance;
    beforeEach(() => { info = jest.spyOn(logger, "info").mockImplementation(() => undefined as never); });
    afterEach(() => info.mockRestore());
    const lines = () => info.mock.calls.map((call) => call.join(" "));
    const about = (what: RegExp) => lines().filter((line) => line.includes(USER) && what.test(line));

    it("names the person and what they did when they turn it on, make new recovery codes, and turn it off; never a code or secret", async () => {
        const made = (await setup().expect(200)).body.secret as string;
        const on = await enable(codeFor(made)).expect(200);
        nextStep();
        const fresh = (await newCodes(codeFor(made)).expect(200)).body.recoveryCodes as string[];
        nextStep();
        await disable(codeFor(made)).expect(200);

        expect(about(/turned on 2FA/)).toHaveLength(1);
        expect(about(/made new recovery codes/)).toHaveLength(1);
        expect(about(/turned off 2FA/)).toHaveLength(1);
        const everything = lines().join("\n");
        for (const text of [made, ...on.body.recoveryCodes, ...fresh]) expect(everything).not.toContain(text);
    });

    it("says nothing when the request was refused", async () => {
        await twoFactorOn();

        await disable("000000").expect(400);
        await newCodes("000000").expect(400);
        await enable("000000").expect(400);

        expect(lines().filter((line) => /2FA/.test(line))).toEqual([]);
    });
});

describe("a recovery code of sixteen characters", () => {
    it("is taken once at sign-in, in either case; a wrong one is a wrong recovery code", async () => {
        await twoFactorOn();
        const fresh: string[] = (await newCodes(codeNow()).expect(200)).body.recoveryCodes;

        expect((await login(fresh[0].toLowerCase())).status).toBe(200);
        const again = await login(fresh[0]);
        expect([again.status, again.body.error]).toEqual([401, "Invalid recovery code"]);
        const wrong = await login("0123456789ABCDEF");
        expect([wrong.status, wrong.body.error]).toEqual([401, "Invalid recovery code"]);
    });

    it("is made by an eight-character code from an older list, and then turns 2FA off", async () => {
        const [old] = await twoFactorOn();
        const [long] = (await newCodes(old).expect(200)).body.recoveryCodes as string[];
        expect(long).toHaveLength(16);

        await disable(long).expect(200);

        expect((await stored()).twoFactorEnabled).toBe(false);
    });

    it("leaves an older list's eight-character codes working until the list is replaced", async () => {
        const [first, second] = await twoFactorOn();

        expect((await login(first)).status).toBe(200);
        await disable(second).expect(200);
    });

    it("is not confused with a length that is neither: twelve characters are read as an authenticator code", async () => {
        await twoFactorOn();

        const res = await login("0123456789AB");

        expect([res.status, res.body.error]).toEqual([401, "Invalid 2FA token"]);
    });
});

describe("a code typed the way people copy it", () => {
    const spaced = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
    const dashed = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

    it("signs in with a recovery code in lower case, spaced, dashed, or with either around it", async () => {
        const codes = await twoFactorOn();

        expect((await login(` ${codes[0].toLowerCase()} `)).status).toBe(200);
        expect((await login(spaced(codes[1]))).status).toBe(200);
        expect((await login(dashed(codes[2]).toLowerCase())).status).toBe(200);
        expect((await login(`- ${dashed(codes[3])}\n`)).status).toBe(200);
        expect((await login(codes[0])).status).toBe(401);
    });

    it("turns it on with an authenticator code typed as 123 456, and signs in with one typed 123-456", async () => {
        const made = (await setup().expect(200)).body.secret as string;
        const code = codeFor(made);

        await enable(`${code.slice(0, 3)} ${code.slice(3)}`).expect(200);
        nextStep();
        const next = codeFor(made);
        expect((await login(`${next.slice(0, 3)}-${next.slice(3)}`)).status).toBe(200);
    });

    it("turns it off, and makes new codes, with a spaced recovery code in lower case", async () => {
        const codes = await twoFactorOn();
        const typed = (code: string) => ` ${code.slice(0, 4)} ${code.slice(4).toLowerCase()}\n`;

        await newCodes(typed(codes[0])).expect(200);
        const fresh = await twoFactorOn();
        await disable(typed(fresh[0])).expect(200);
    });

    it("answers 400 to a code that is nothing but spaces and dashes, and asks for the code at sign-in", async () => {
        await twoFactorOn();

        await enable(" - ").expect(400);
        await disable("---").expect(400);
        await newCodes("   ").expect(400);
        expect((await login(" - ")).body.requires2FA).toBe(true);
    });
});

describe("new recovery codes asked for together", () => {
    it("leave exactly one list in force: the loser is told to try again, or its list was the one replaced", async () => {
        await twoFactorOn();

        const results = await Promise.all([newCodes(codeAt(-1)), newCodes(codeAt(0))]);

        const lists = results.filter((r) => r.status === 200).map((r) => r.body.recoveryCodes as string[]);
        expect(lists.length).toBeGreaterThanOrEqual(1);
        for (const r of results.filter((r) => r.status !== 200)) expect([400, 409]).toContain(r.status);
        const working = [];
        for (const list of lists) if ((await login(list[0])).status === 200) working.push(list);
        expect(working).toHaveLength(1);
    });

    /** Runs `change` once, right after the request has read the list it will write over (the read that selects only the list). */
    function afterListIsRead(change: () => Promise<void>): jest.SpyInstance {
        const real = prisma.user.findUnique.bind(prisma.user);
        let done = false;
        return jest.spyOn(prisma.user, "findUnique").mockImplementation(((args: any) => {
            const result = real(args);
            const keys = Object.keys(args?.select ?? {});
            if (!done && keys.length === 1 && keys[0] === "twoFactorRecoveryCodes") {
                done = true;
                return result.then(async (r: any) => { await change(); return r; });
            }
            return result;
        }) as any);
    }

    it("answers 409 to the one whose list was replaced after it read it, and keeps the list that replaced it", async () => {
        await twoFactorOn();
        const interloper = encrypt("not-a-hash");
        const spy = afterListIsRead(async () => {
            await prisma.user.update({ where: { id: USER }, data: { twoFactorRecoveryCodes: interloper } });
        });

        const res = await newCodes(codeNow());
        spy.mockRestore();

        expect([res.status, res.body.error]).toEqual([409, "Recovery codes changed, try again"]);
        expect((await stored()).twoFactorRecoveryCodes).toBe(interloper);
    });

    it("answers 409 as well when a sign-in spent one of the codes in between, and the sign-in's spend stands", async () => {
        const codes = await twoFactorOn();
        const spy = afterListIsRead(async () => { await login(codes[4]).expect(200); });

        const res = await newCodes(codeNow());
        spy.mockRestore();

        expect(res.status).toBe(409);
        expect((await login(codes[4])).status).toBe(401);
        expect((await login(codes[5])).status).toBe(200);
    });

    it("writes over the list it read after spending a recovery code of its own, which is the usual case", async () => {
        const [code] = await twoFactorOn();

        const res = await newCodes(code).expect(200);

        expect((await login(res.body.recoveryCodes[0])).status).toBe(200);
        expect((await login(code)).status).toBe(401);
    });
});

describe("bodies that are not what the route wants", () => {
    const post = (path: string, body: unknown) => request(app).post(path).set("Authorization", bearer()).send(body as object);

    it.each([
        ["enable, a number for the code", "/auth/2fa/enable", { token: 123456 }],
        ["enable, an object for the code", "/auth/2fa/enable", { token: { a: 1 } }],
        ["enable, no code", "/auth/2fa/enable", {}],
        ["enable, a list for the secret it ignores", "/auth/2fa/enable", { secret: ["x"], token: "123456" }],
        ["disable, a number for the code", "/auth/2fa/disable", { password: PASSWORD, token: 123456 }],
        ["disable, an object for the password", "/auth/2fa/disable", { password: { $ne: "" }, token: "123456" }],
        ["disable, nothing", "/auth/2fa/disable", {}],
        ["recovery codes, a number for the password", "/auth/2fa/recovery-codes", { password: 5, token: "123456" }],
        ["recovery codes, a list for the code", "/auth/2fa/recovery-codes", { password: PASSWORD, token: ["1"] }],
        ["recovery codes, nothing", "/auth/2fa/recovery-codes", {}],
    ])("answers 400, never 500: %s", async (_name, path, body) => {
        await twoFactorOn();
        const before = await stored();

        const res = await post(path, body);

        expect(res.status).toBe(400);
        expect(await stored()).toEqual(before);
    });

    it("answers 400 to a setup body that is a list, and makes no pending secret", async () => {
        const res = await post("/auth/2fa/setup", []);

        expect(res.status).toBe(400);
        expect((await stored()).twoFactorPendingSecret).toBeNull();
    });

    it("answers 400 to a body that is not JSON text at all", async () => {
        const res = await request(app).post("/auth/2fa/disable").set("Authorization", bearer()).set("Content-Type", "application/json").send("{nope");

        expect(res.status).toBe(400);
    });
});

it("answers a disable with 2FA already off as before, whatever code it carries", async () => {
    await disable("000000").expect(200);
});

it("refuses an unknown name and a wrong password alike", async () => {
    const unknown = await request(app).post("/auth/login").send({ username: "zz-2fa-nobody", password: PASSWORD });
    const wrong = await request(app).post("/auth/login").send({ username: USER, password: "nope" });
    expect([unknown.status, unknown.body]).toEqual([401, { error: "Invalid credentials" }]);
    expect([wrong.status, wrong.body]).toEqual([401, { error: "Invalid credentials" }]);
});

describe("an admin turning off someone's 2FA", () => {
    const ADMIN = "zz-2fa-admin";
    const adminBearer = () => `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
    const reset = (id: string, auth = adminBearer()) => request(app).post(`/auth/users/${id}/reset-2fa`).set("Authorization", auth);

    beforeAll(async () => {
        await prisma.user.deleteMany({ where: { id: ADMIN } });
        await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: await bcrypt.hash(PASSWORD, 10), role: "admin", tokenVersion: 0 } });
    });
    afterAll(async () => { await prisma.user.deleteMany({ where: { id: ADMIN } }); });

    it("lets an account whose secret cannot be read sign in again with its password, and clears everything stored", async () => {
        await twoFactorOn();
        await setupDone();
        await prisma.user.update({ where: { id: USER }, data: { twoFactorSecret: UNREADABLE, twoFactorRecoveryCodes: UNREADABLE, twoFactorLastStep: 77 } });
        jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);
        expect((await login()).status).toBe(401);

        await reset(USER).expect(200);

        expect(await stored()).toEqual({
            twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: null, twoFactorLastStep: 0, twoFactorPendingSecret: null, twoFactorPendingAt: null,
        });
        expect((await login().expect(200)).body.token).toEqual(expect.any(String));
        jest.mocked(logger.warn).mockRestore();
    });

    it("also works on an account whose secret reads fine, and the person can set it up again", async () => {
        await twoFactorOn();

        await reset(USER).expect(200);

        const made = (await setup().expect(200)).body.secret as string;
        await enable(codeFor(made)).expect(200);
    });

    it("answers 404 for a person who does not exist", async () => {
        await reset("zz-2fa-nobody-at-all").expect(404);
    });

    it("shows on the users list which accounts have 2FA on, and nothing of what is stored", async () => {
        await twoFactorOn();
        const list = () => request(app).get("/auth/users").set("Authorization", adminBearer()).expect(200);
        const row = (body: Array<Record<string, unknown>>) => body.find((u) => u.id === USER)!;

        const on = row((await list()).body);
        expect(on.twoFactorEnabled).toBe(true);
        expect(Object.keys(on).filter((k) => /secret|recovery|step|pending/i.test(k))).toEqual([]);

        await reset(USER).expect(200);
        expect(row((await list()).body).twoFactorEnabled).toBe(false);
    });

    it("is for admins: a member is refused and the account keeps its 2FA", async () => {
        await twoFactorOn();
        const before = await stored();

        await reset(USER, bearer()).expect(403);

        expect(await stored()).toEqual(before);
    });

    it("is refused to someone who is not signed in", async () => {
        await request(app).post(`/auth/users/${USER}/reset-2fa`).expect(401);
    });
});
