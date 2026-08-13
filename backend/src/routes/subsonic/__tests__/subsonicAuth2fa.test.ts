/**
 * HTTP-level tests for the Subsonic 2FA bypass fix, real Postgres + the real
 * Express router, not service functions -- the bug itself was only visible
 * at the literal HTTP response (a 2FA-enabled account getting a full session
 * back from `p=` with no code ever asked for), so that's the altitude these
 * tests run at.
 *
 * Also covers the two fixes that landed in the same pass: `startScan.view`'s
 * missing admin check, and `changePassword.view` refusing a self-change made
 * with an API key.
 *
 *   DATABASE_URL=postgresql://test:test@localhost:5433/test npx jest subsonicAuth2fa
 */
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { prisma } from "../../../utils/db";
import { createApiKey } from "../../../services/users/apiKeyStore";

// `startScan.view` (via `scanQueue.add`/`getJobCounts`) is the one route
// under test that talks to BullMQ, which wants more from its Redis
// connection than the shared `ioredis` mock (jest.config.js) gives it --
// real queues hung indefinitely here rather than erroring, confirmed by
// running this file without the mock below and watching it time out. Mocked
// at the module level, not stubbed inside the test, so `startScan.view`'s
// own import of `scanQueue` picks this up transparently; the admin-check
// fix being tested here runs entirely BEFORE either of these calls anyway.
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
            // A real secret isn't needed anywhere below -- every test here
            // exercises the PASSWORD path's 2FA gate, never the TOTP
            // verification `POST /auth/login` itself does, so a secret is
            // deliberately not set up. The column would otherwise carry a
            // NULL that reads as "somehow enabled with nothing to verify
            // against", worth naming so it isn't mistaken for an oversight.
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

describe("subsonicAuth -- 2FA on the password path", () => {
    it("LEAK CLOSED: a 2FA-enabled account with the correct password gets refused, not a session", async () => {
        const user = await mkUser("2fa", { twoFactorEnabled: true });
        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        expect(body.status).toBe("failed");
        expect(body.error.code).toBe(40); // WRONG_CREDENTIALS -- see subsonicAuth.ts's own comment on why
    });

    it("the refusal message tells a 2FA user with NO API key yet exactly what to do -- this is the person the message exists for", async () => {
        const user = await mkUser("noKeyYet", { twoFactorEnabled: true });
        // Deliberately zero ApiKey rows for this user -- confirms the
        // message doesn't depend on one already existing.
        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        const message: string = res.body["subsonic-response"].error.message;
        expect(message).toContain("app key");
        expect(message).toContain("Settings");
    });

    it("a NON-2FA account is unaffected -- same password, same route, still gets a session", async () => {
        const user = await mkUser("plain");
        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    it("a 2FA-enabled account can still connect with an API key -- the credential class that was always meant to work here", async () => {
        const user = await mkUser("2faWithKey", { twoFactorEnabled: true });
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, apiKey: key, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    // The README has always told native clients (Amperfy, Symfonium, DSub)
    // to paste their API token into the PASSWORD field -- most of them have
    // no separate token field, `apiKey=` only helps the ones that speak
    // OpenSubsonic specifically. Removing MD5 token auth without teaching
    // `p=` to accept a key too would have silently broken every one of them.
    it("an API key sent through p= (not apiKey=) authenticates a NON-2FA account", async () => {
        const user = await mkUser("keyViaP");
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: key, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    it("an API key sent through p= authenticates a 2FA-enabled account -- the whole point of it: 2FA has no route in otherwise, since t= is gone and this client only ever sends p=", async () => {
        const user = await mkUser("keyViaP2fa", { twoFactorEnabled: true });
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/ping.view")
            .query({ u: user.username, p: key, f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
    });

    it("a key that belongs to a DIFFERENT user, sent through p= while claiming this username, is refused -- not silently authenticated as its real owner or as the claimed one", async () => {
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

    it("a value through p= that is neither a real key nor the real password is refused, for both a 2FA and a non-2FA account", async () => {
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

describe("startScan.view -- the missing admin check", () => {
    it("a plain authenticated user is refused, not allowed to trigger a scan", async () => {
        const user = await mkUser("scanner");
        const res = await request(app)
            .get("/rest/startScan.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        expect(body.status).toBe("failed");
        expect(body.error.code).toBe(50); // NOT_AUTHORIZED
    });

    it("an admin is NOT blocked by the new check -- confirms the fix didn't also break the legitimate case", async () => {
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
        // Whatever else it does (queues a real scan job via BullMQ), it must
        // NOT be the admin-check failure the non-admin test above gets.
        expect(body.error?.code).not.toBe(50);
    });
});

describe("changePassword.view -- an API key can't silently take over the login password", () => {
    it("a self-change made with an API key is refused", async () => {
        const user = await mkUser("selfApiKey");
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/changePassword.view")
            .query({ u: user.username, apiKey: key, username: user.username, password: "new-password", f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        expect(body.status).toBe("failed");
        expect(body.error.code).toBe(50); // NOT_AUTHORIZED

        // Confirms this wasn't just an error response with the password
        // silently changed anyway underneath it.
        const stillOldPassword = await bcrypt.compare(
            PLAIN_PASSWORD,
            (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
        );
        expect(stillOldPassword).toBe(true);
    });

    // The SAME key, presented through p= instead of apiKey=, has to hit the
    // SAME restriction -- it's the identical credential, subsonicAuth just
    // found it in a different query parameter. If `subsonicAuthMethod` were
    // ever mislabelled "password" for a key that arrived via p=, this is the
    // one test that would notice: everything else about a key-via-p=
    // session (ping, streaming) looks identical whether the label is right
    // or wrong, only this route branches on it.
    it("a self-change made with an API key sent through p= is ALSO refused -- same restriction, same credential, different query param", async () => {
        const user = await mkUser("selfApiKeyViaP");
        const { key } = await createApiKey(user.id, "test device");

        const res = await request(app)
            .get("/rest/changePassword.view")
            .query({ u: user.username, p: key, username: user.username, password: "new-password", f: "json", v: "1.16.1", c: "test" });

        const body = res.body["subsonic-response"];
        expect(body.status).toBe("failed");
        expect(body.error.code).toBe(50); // NOT_AUTHORIZED

        const stillOldPassword = await bcrypt.compare(
            PLAIN_PASSWORD,
            (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
        );
        expect(stillOldPassword).toBe(true);
    });

    it("a self-change made with the account PASSWORD still works -- unaffected by the new check", async () => {
        const user = await mkUser("selfPassword");
        const res = await request(app)
            .get("/rest/changePassword.view")
            .query({ u: user.username, p: PLAIN_PASSWORD, username: user.username, password: "new-password-2", f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
        const nowMatchesNew = await bcrypt.compare(
            "new-password-2",
            (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
        );
        expect(nowMatchesNew).toBe(true);
    });

    it("an admin changing SOMEONE ELSE's password with an API key still works -- the restriction is on SELF-change-by-key, not on API keys generally", async () => {
        seq += 1;
        const admin = await prisma.user.create({
            data: {
                username: `subauth_admin2_${seq}`,
                passwordHash: await bcrypt.hash(PLAIN_PASSWORD, 10),
                role: "admin",
            },
        });
        const { key } = await createApiKey(admin.id, "admin device");
        const target = await mkUser("targetOfAdmin");

        const res = await request(app)
            .get("/rest/changePassword.view")
            .query({ u: admin.username, apiKey: key, username: target.username, password: "admin-set-this", f: "json", v: "1.16.1", c: "test" });

        expect(res.body["subsonic-response"].status).toBe("ok");
        const targetNowMatches = await bcrypt.compare(
            "admin-set-this",
            (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).passwordHash,
        );
        expect(targetNowMatches).toBe(true);
    });
});
