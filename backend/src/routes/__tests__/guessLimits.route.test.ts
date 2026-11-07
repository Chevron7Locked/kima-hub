// Guessing a password is capped whatever address the guesser claims. Real database, real routes
// and middleware, mounted as index.ts mounts them. Each request claims a new address unless a test says otherwise.

import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import speakeasy from "speakeasy";
import { createHash } from "crypto";
import { prisma } from "../../utils/db";
import { authLimiter, trustOneProxyHop } from "../../middleware/rateLimiter";
import { encrypt } from "../../utils/encryption";
import { createApiKey } from "../../services/users/apiKeyStore";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { GuessLimit } from "../../services/users/guessLimits";
import authRoutes from "../auth";
import { subsonicRouter } from "../subsonic";

jest.setTimeout(60_000);

const PREFIX = "zz-guess-";
const PASSWORD = "the right password";
const FIFTEEN_MINUTES = 15 * 60_000;

const app = express();
trustOneProxyHop(app);
app.use(express.json());
app.use("/api/auth/login", authLimiter);
app.use("/api/auth", authRoutes);
app.use("/rest", subsonicRouter);

let address = 0;
const newAddress = () => {
    address++;
    return `203.0.${address >> 8}.${address & 255}`;
};

let users = 0;
async function user(extra: Record<string, unknown> = {}) {
    users++;
    return prisma.user.create({
        data: { username: `${PREFIX}${users}`, passwordHash: await bcrypt.hash(PASSWORD, 4), ...extra },
    });
}

const nobody = () => `${PREFIX}nobody-${++users}`;

const login = (username: string, password: string, from = newAddress(), token?: string) =>
    request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", from)
        .send({ username, password, ...(token ? { token } : {}) });

const subsonic = (query: Record<string, string>) =>
    request(app)
        .get("/rest/ping.view")
        .set("X-Forwarded-For", newAddress())
        .query({ f: "json", v: "1.16.1", c: "test", ...query });
const reply = (res: request.Response) => res.body["subsonic-response"];

async function times(count: number, send: (i: number) => PromiseLike<unknown>) {
    for (let i = 0; i < count; i++) await send(i);
}

const passTime = (ms: number) => {
    const start = Date.now();
    return jest.spyOn(Date, "now").mockImplementation(() => start + ms);
};

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await closeEngineConnections();
});

describe("web login", () => {
    it("refuses the 21st wrong password for a username, whatever address it comes from", async () => {
        const { username } = await user();

        await times(20, async () => expect((await login(username, "wrong")).status).toBe(401));

        const locked = await login(username, "wrong");
        expect(locked.status).toBe(429);
        expect(locked.body.error).toMatch(/15 minutes/);
    });

    it("refuses even the right password while locked, until the 15 minutes pass", async () => {
        const { username } = await user();
        await times(20, () => login(username, "wrong"));

        expect((await login(username, PASSWORD)).status).toBe(429);

        passTime(FIFTEEN_MINUTES + 1);
        expect((await login(username, PASSWORD)).status).toBe(200);
    });

    it("does not count a right password", async () => {
        const { username } = await user();

        await times(25, async () => expect((await login(username, PASSWORD)).status).toBe(200));
    });

    it("counts wrong two-factor codes too", async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const { username } = await user({ twoFactorEnabled: true, twoFactorSecret: encrypt(secret) });

        await times(20, async () => expect((await login(username, PASSWORD, newAddress(), "000000")).status).toBe(401));

        const rightCode = speakeasy.totp({ secret, encoding: "base32" });
        expect((await login(username, PASSWORD, newAddress(), rightCode)).status).toBe(429);
    });

    it("does not count the step that only asks for a two-factor code", async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const { username } = await user({ twoFactorEnabled: true, twoFactorSecret: encrypt(secret) });

        await times(25, async () => expect((await login(username, PASSWORD)).body.requires2FA).toBe(true));
    });

    it("answers an unknown username exactly as it answers a real one", async () => {
        const { username } = await user();
        const unknown = nobody();

        for (let i = 0; i < 22; i++) {
            const real = await login(username, "wrong");
            const fake = await login(unknown, "wrong");
            expect([fake.status, fake.body]).toEqual([real.status, real.body]);
        }
    });

    it("gives guesses sent all at once no extra tries", async () => {
        const { username } = await user();

        const replies = await Promise.all(Array.from({ length: 40 }, () => login(username, "wrong")));

        expect(replies.filter((r) => r.status === 401)).toHaveLength(20);
        expect(replies.filter((r) => r.status === 429)).toHaveLength(20);
    });

    it("keeps the per-address runaway limit, across usernames", async () => {
        const from = newAddress();
        const names = await Promise.all(Array.from({ length: 21 }, () => user()));

        await times(20, async (i) => expect((await login(names[i].username, "wrong", from)).status).toBe(401));

        expect((await login(names[20].username, PASSWORD, from)).status).toBe(429);
    });

    it("leaves a signed-in session working on a locked account", async () => {
        const { username } = await user();
        const { body } = await login(username, PASSWORD);
        await times(21, () => login(username, "wrong"));

        const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${body.token}`);

        expect(me.status).toBe(200);
    });
});

describe("two-factor sign-in", () => {
    it("counts a wrong recovery code as a wrong try: 20 lock the account", async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const stored = createHash("sha256").update("BBBBBBBB").digest("hex");
        const { username } = await user({
            twoFactorEnabled: true,
            twoFactorSecret: encrypt(secret),
            twoFactorRecoveryCodes: encrypt(stored),
        });

        await times(20, async () => expect((await login(username, PASSWORD, newAddress(), "AAAAAAAA")).status).toBe(401));

        expect((await login(username, PASSWORD, newAddress(), "AAAAAAAA")).status).toBe(429);
    });

    it("gives the try back for a right code, so 25 two-factor sign-ins in a row are never refused", async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const { username } = await user({ twoFactorEnabled: true, twoFactorSecret: encrypt(secret) });

        await times(25, async () => {
            const code = speakeasy.totp({ secret, encoding: "base32" });
            expect((await login(username, PASSWORD, newAddress(), code)).status).toBe(200);
        });
    });
});

describe("Subsonic", () => {
    it("refuses even the right password after 20 wrong ones, with its wrong-credentials error, until the 15 minutes pass", async () => {
        const { username } = await user();
        await times(20, async () => expect(reply(await subsonic({ u: username, p: "wrong" })).error.code).toBe(40));

        const locked = await subsonic({ u: username, p: PASSWORD });

        expect(locked.status).toBe(200);
        expect(reply(locked).error).toEqual({ code: 40, message: expect.stringMatching(/too many wrong passwords/i) });

        passTime(FIFTEEN_MINUTES + 1);
        expect(reply(await subsonic({ u: username, p: PASSWORD })).status).toBe("ok");
    });

    it("gives the try back for a right password on a two-factor account, and keeps its own refusal message", async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const { username } = await user({ twoFactorEnabled: true, twoFactorSecret: encrypt(secret) });

        await times(25, async () => {
            const { error } = reply(await subsonic({ u: username, p: PASSWORD }));
            expect(error).toEqual({ code: 40, message: expect.stringMatching(/2FA is on/) });
        });
    });

    it("does not count a right password", async () => {
        const { username } = await user();

        await times(25, async () => expect(reply(await subsonic({ u: username, p: PASSWORD })).status).toBe("ok"));
    });

    it("answers an unknown username exactly as it answers a real one", async () => {
        const { username } = await user();
        const unknown = nobody();

        for (let i = 0; i < 22; i++) {
            const real = reply(await subsonic({ u: username, p: "wrong" }));
            const fake = reply(await subsonic({ u: unknown, p: "wrong" }));
            expect(fake.error).toEqual(real.error);
        }
    });
});

describe("app keys", () => {
    it("keep working on a locked account, in the apiKey field and in the password field, however often", async () => {
        const { id, username } = await user();
        const { key } = await createApiKey(id, "an app");
        await times(21, () => subsonic({ u: username, p: "wrong" }));

        await times(25, async () => {
            expect(reply(await subsonic({ u: username, apiKey: key })).status).toBe("ok");
            expect(reply(await subsonic({ u: username, p: key })).status).toBe("ok");
        });
    });
});

describe("the two sign-in surfaces", () => {
    it("an old password in a Subsonic app cannot lock its owner out of web login", async () => {
        const { username } = await user();
        await times(21, () => subsonic({ u: username, p: "the old one" }));

        expect((await login(username, PASSWORD)).status).toBe(200);
    });

    it("wrong web logins cannot lock a Subsonic app out", async () => {
        const { username } = await user();
        await times(21, () => login(username, "wrong"));

        expect(reply(await subsonic({ u: username, p: PASSWORD })).status).toBe("ok");
    });
});

describe("a forged address", () => {
    it("behind a reverse proxy that appends the real address, shares the real address's runaway limit", async () => {
        const behindProxy = (username: string, forged: string) =>
            login(username, "wrong", `${forged}, 198.51.100.7`);

        await times(20, async () => expect((await behindProxy(nobody(), newAddress())).status).toBe(401));

        expect((await behindProxy(nobody(), newAddress())).status).toBe(429);
    });
});

describe("guess counters", () => {
    // No route shows what the server holds in memory, so this reads the counter itself.
    it("drop finished counters, so made-up usernames cannot grow memory without end", () => {
        const limit = new GuessLimit(20, FIFTEEN_MINUTES);
        for (let i = 0; i < 50; i++) limit.take(`made-up-${i}`);
        expect(limit.size).toBe(50);

        passTime(FIFTEEN_MINUTES + 1);
        limit.take("someone-real");

        expect(limit.size).toBe(1);
    });
});
