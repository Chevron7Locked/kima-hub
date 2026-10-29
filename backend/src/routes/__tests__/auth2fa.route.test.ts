/**
 * Two-factor sign-in end to end: turning it on checks a code against the new secret and hands out ten one-time
 * recovery codes; signing in then needs a current code or one recovery code, once; turning it off needs the password
 * and a current code. Real database, real encryption, real codes from the secret.
 */
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/rateLimiter", () => {
    const pass = (_req: any, _res: any, next: any) => next();
    return new Proxy({}, { get: () => pass });
});

import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import speakeasy from "speakeasy";
import { prisma } from "../../utils/db";
import { generateToken, clearUserCache } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import authRoutes from "../auth";

const USER = "zz-2fa-user";
const PASSWORD = "correct horse";
const app = express().use(express.json()).use("/auth", authRoutes);
const bearer = () => `Bearer ${generateToken({ id: USER, username: USER, role: "user", tokenVersion: 0 })}`;
const login = (token?: string) => request(app).post("/auth/login").send({ username: USER, password: PASSWORD, ...(token ? { token } : {}) });
const secret = speakeasy.generateSecret({ length: 20 }).base32;
const codeNow = () => speakeasy.totp({ secret, encoding: "base32" });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: await bcrypt.hash(PASSWORD, 10), role: "user", tokenVersion: 0 } });
});

beforeEach(() => clearUserCache());

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

let recoveryCodes: string[] = [];

it("turning it on refuses a wrong code, and a right one hands out ten recovery codes", async () => {
    await request(app).post("/auth/2fa/enable").set("Authorization", bearer()).send({ secret, token: "000000" }).expect(400);

    const res = await request(app).post("/auth/2fa/enable").set("Authorization", bearer()).send({ secret, token: codeNow() }).expect(200);

    recoveryCodes = res.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[0-9A-F]{8}$/);
});

it("signing in then asks for a code, and takes a current one", async () => {
    expect((await login().expect(200)).body).toMatchObject({ requires2FA: true });
    expect((await login("000000")).status).toBe(401);
    expect((await login(codeNow()).expect(200)).body.token).toEqual(expect.any(String));
});

it("reads a code sent as a number like one sent as text, and never fails on one", async () => {
    const send = (token: unknown) => request(app).post("/auth/login").send({ username: USER, password: PASSWORD, token });
    expect((await send(12345678)).status).toBe(401);
    expect((await send(Number(codeNow()))).status).toBe(codeNow().startsWith("0") ? 401 : 200);
});

it("takes a recovery code once", async () => {
    const code = recoveryCodes[0];
    expect((await login(code.toLowerCase()).expect(200)).body.token).toEqual(expect.any(String));
    expect((await login(code)).status).toBe(401);
});

it("turning it off needs the password and a current code", async () => {
    await request(app).post("/auth/2fa/disable").set("Authorization", bearer()).send({ password: "wrong", token: codeNow() }).expect(400);
    await request(app).post("/auth/2fa/disable").set("Authorization", bearer()).send({ password: PASSWORD, token: "000000" }).expect(400);
    await request(app).post("/auth/2fa/disable").set("Authorization", bearer()).send({ password: PASSWORD, token: codeNow() }).expect(200);
    expect((await login().expect(200)).body.token).toEqual(expect.any(String));
});

it("refuses an unknown name and a wrong password alike", async () => {
    const unknown = await request(app).post("/auth/login").send({ username: "zz-2fa-nobody", password: PASSWORD });
    const wrong = await request(app).post("/auth/login").send({ username: USER, password: "nope" });
    expect([unknown.status, unknown.body]).toEqual([401, { error: "Invalid credentials" }]);
    expect([wrong.status, wrong.body]).toEqual([401, { error: "Invalid credentials" }]);
});
