/**
 * Subsonic auth over real HTTP and Postgres: a 2FA account cannot log in with
 * `p=` alone, and startScan.view needs an admin.
 */
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { prisma } from "../../../utils/db";
import { createApiKey } from "../../../services/users/apiKeyStore";

// BullMQ hangs on the shared ioredis mock, so the queues startScan.view uses
// are mocked.
jest.mock("../../../workers/queues", () => ({
    scanQueue: {
        add: jest.fn().mockResolvedValue(undefined),
        getJobCounts: jest.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0 }),
    },
}));

import { subsonicRouter } from "../index";

jest.setTimeout(30_000);

const app = express();
app.use("/rest", subsonicRouter);

let seq = 0;
const PLAIN_PASSWORD = "correct horse battery staple";

async function mkUser(tag: string, opts: { twoFactorEnabled?: boolean } = {}) {
    seq += 1;
    return prisma.user.create({
        data: {
            username: `subauth_${tag}_${seq}`,
            passwordHash: await bcrypt.hash(PLAIN_PASSWORD, 10),
            twoFactorEnabled: opts.twoFactorEnabled ?? false,
            // No TOTP secret: these tests only reach the password path's 2FA gate.
        },
    });
}

async function wipe() {
    // Cascades ApiKey (relation FK, onDelete: Cascade).
    await prisma.user.deleteMany({ where: { username: { startsWith: "subauth_" } } });
}

beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
});
beforeEach(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("subsonicAuth: 2FA on the password path", () => {
    it("refuses a 2FA-enabled account that sends the correct password", async () => {
        const user = await mkUser("2fa", { twoFactorEnabled: true });
        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        expect(body.status).toBe("failed");
        expect(body.error.code).toBe(40); // WRONG_CREDENTIALS
    });

    it("tells a 2FA user with no API key yet to create an app key in Settings", async () => {
        const user = await mkUser("noKeyYet", { twoFactorEnabled: true });
        // No ApiKey rows exist for this user.
        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        const message: string = res.body["subsonic-response"].error.message;
        expect(message).toContain("app key");
        expect(message).toContain("Settings");
    });

    it("accepts the password for an account without 2FA", async () => {
        const user = await mkUser("plain");
        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    it("accepts an API key for a 2FA-enabled account", async () => {
        const user = await mkUser("2faWithKey", { twoFactorEnabled: true });
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, apiKey: key, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    // Native clients are told to paste their API key into the password field.
    it("accepts an API key sent as p= for an account without 2FA", async () => {
        const user = await mkUser("keyViaP");
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: key, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    it("accepts an API key sent as p= for a 2FA-enabled account", async () => {
        const user = await mkUser("keyViaP2fa", { twoFactorEnabled: true });
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: key, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    it("refuses another user's API key sent as p=", async () => {
        const owner = await mkUser("keyOwner");
        const claimant = await mkUser("keyClaimant");
        const { key } = await createApiKey(owner.id, "owner's device");

        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: claimant.username, p: key, f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        expect(body.status).toBe("failed");
        expect(body.error.code).toBe(40); // WRONG_CREDENTIALS -- falls through to the (wrong) password check, same as any other non-matching p=
    });

    it("refuses a p= value that is neither a key nor the password, with or without 2FA", async () => {
        const plain = await mkUser("wrongValuePlain");
        const twoFa = await mkUser("wrongValue2fa", { twoFactorEnabled: true });

        const resPlain = await request(app)
            .get("/rest/ping.view")
            .query({ u: plain.username, p: "not-the-password-and-not-a-key", f: "json", v: "1.16.1", c: "test" });
        const res2fa = await request(app)
            .get("/rest/ping.view")
            .query({ u: twoFa.username, p: "not-the-password-and-not-a-key", f: "json", v: "1.16.1", c: "test" });

        expect(resPlain.body["subsonic-response"].error.code).toBe(40);
        expect(res2fa.body["subsonic-response"].error.code).toBe(40);
    });
});

describe("startScan.view admin check", () => {
    it("refuses a non-admin user", async () => {
        const user = await mkUser("scanner");
        const res = await request(app)
            .get("/rest/startScan.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        expect(body.status).toBe("failed");
        expect(body.error.code).toBe(50); // NOT_AUTHORIZED
    });

    it("lets an admin through the admin check", async () => {
        seq += 1;
        const admin = await prisma.user.create({
            data: {
                username: `subauth_admin_${seq}`,
                passwordHash: await bcrypt.hash(PLAIN_PASSWORD, 10),
                role: "admin",
            },
        });
        const res = await request(app)
            .get("/rest/startScan.view")
            .query({ u: admin.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        // The scan job itself is queued; only the admin check is under test.
        expect(body.error?.code).not.toBe(50);
    });
});
