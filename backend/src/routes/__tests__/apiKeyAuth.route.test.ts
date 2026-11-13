/**
 * API keys are stored as SHA-256 hashes. Through the real app and database: a
 * key works as `X-API-Key` and OpenSubsonic `apiKey=`, and the MD5 `t=`/`s=`
 * path is refused.
 */
import express from "express";
import request from "supertest";
import crypto from "crypto";
import { prisma } from "../../utils/db";
import authRoutes from "../auth";
import { subsonicRouter } from "../subsonic/index";
import { createApiKey, hashApiKey } from "../../services/users/apiKeyStore";
import { queues } from "../../workers/queues";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { mountAsServer } from "./helpers/serverMount";

jest.setTimeout(30_000);

const app = express();
app.use(express.json());
mountAsServer(app, "/api/auth", authRoutes, "/api/auth");
app.use("/rest", subsonicRouter);

const PREFIX = "itapikey_";

async function mkUser(tag: string) {
    return prisma.user.create({ data: { username: `${PREFIX}${tag}`, passwordHash: "x", role: "user" } });
}

async function wipe() {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
}

beforeEach(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
    // The subsonic router mounts routes from workers/queues, whose module
    // scope builds three BullMQ queues; middleware/auth reaches the shared
    // Redis client. Left open, Jest finishes and outlives those sockets.
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

describe("API key auth, hashed at rest", () => {
    it("a freshly minted key authenticates via X-API-Key on a real protected route", async () => {
        const user = await mkUser("fresh");
        const created = await createApiKey(user.id, "test device");

        const res = await request(app).get("/api/auth/me").set("X-API-Key", created.key);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(user.id);
    });

    it("an invalid key is rejected -- 401, not authenticated -- with a REAL key already present, so a lookup that ignored the header and matched anything would be visible", async () => {
        // A real, valid key exists in the table before the bad request is
        // made -- an empty table would let a broken "match anything" lookup
        // pass this test by accident (nothing to wrongly match). This is the
        // asymmetric-fixture shape the mutation below actually needs.
        const real = await mkUser("invalidkeyctrl");
        await createApiKey(real.id, "real device");

        const res = await request(app).get("/api/auth/me").set("X-API-Key", "not-a-real-key-at-all");
        expect(res.status).toBe(401);
    });

    it("a key that existed BEFORE this migration still authenticates with its original plaintext, after being re-keyed the same way the migration re-keys every row", async () => {
        // A row as the migration leaves it: keyHash is SHA-256 of the old
        // plaintext column, written directly rather than through createApiKey.
        const user = await mkUser("premigration");
        const originalPlaintextKey = crypto.randomBytes(32).toString("hex");
        await prisma.apiKey.create({
            data: { userId: user.id, name: "pre-migration device", keyHash: hashApiKey(originalPlaintextKey) },
        });

        const res = await request(app).get("/api/auth/me").set("X-API-Key", originalPlaintextKey);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(user.id);
    });

    it("a valid key authenticates via OpenSubsonic apiKey=, an invalid one gets WRONG_CREDENTIALS -- not a crash", async () => {
        const user = await mkUser("subsonic");
        const created = await createApiKey(user.id, "subsonic client");

        const ok = await request(app).get(
            `/rest/ping.view?u=${user.username}&apiKey=${created.key}&v=1.16.1&c=test&f=json`,
        );
        expect(ok.status).toBe(200); // Subsonic is always HTTP 200; failure is in the envelope
        expect(ok.body["subsonic-response"].status).toBe("ok");

        const bad = await request(app).get(
            `/rest/ping.view?u=${user.username}&apiKey=not-a-real-key&v=1.16.1&c=test&f=json`,
        );
        expect(bad.body["subsonic-response"].status).toBe("failed");
        expect(bad.body["subsonic-response"].error.code).toBe(40); // WRONG_CREDENTIALS
    });

    it("tokenInfo.view resolves a valid key to the right username", async () => {
        const user = await mkUser("tokeninfo");
        const created = await createApiKey(user.id, "test device");

        const res = await request(app).get(`/rest/tokenInfo.view?apiKey=${created.key}&v=1.16.1&c=test&f=json`);
        expect(res.body["subsonic-response"].tokenInfo.username).toBe(user.username);
    });

    it("legacy t=/s= MD5-token auth is explicitly rejected with TOKEN_AUTH_NOT_SUPPORTED (41) -- not silently mistaken for a wrong password", async () => {
        // MD5 token auth needs the plaintext key, which is not stored. A
        // correctly computed token is still refused, so the refusal is deliberate.
        const user = await mkUser("md5legacy");
        const created = await createApiKey(user.id, "legacy client");
        const salt = "abc123";
        const correctToken = crypto.createHash("md5").update(created.key + salt).digest("hex");

        const res = await request(app).get(
            `/rest/ping.view?u=${user.username}&t=${correctToken}&s=${salt}&v=1.16.1&c=test&f=json`,
        );
        expect(res.body["subsonic-response"].status).toBe("failed");
        expect(res.body["subsonic-response"].error.code).toBe(41); // TOKEN_AUTH_NOT_SUPPORTED
    });

    it("the stored value is the SHA-256 digest of the plaintext, not the plaintext itself -- read directly off the row, not through the service layer", async () => {
        const user = await mkUser("dbcheck");
        const created = await createApiKey(user.id, "dbcheck device");

        const rows = await prisma.$queryRaw<Array<{ keyHash: string }>>`
            SELECT "keyHash" FROM "ApiKey" WHERE "userId" = ${user.id}
        `;
        expect(rows[0].keyHash).not.toBe(created.key);
        expect(rows[0].keyHash).toBe(hashApiKey(created.key));
    });
});
