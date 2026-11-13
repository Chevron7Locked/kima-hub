/**
 * Subsonic no longer manages accounts: changePassword, createUser, updateUser and deleteUser answer the standard
 * Subsonic error (code 0, the generic one, the same answer as other actions this server does not support) and change
 * nothing, for an admin as much as for anyone. getUser and getUsers still answer. Real HTTP and Postgres.
 */
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { prisma } from "../../../utils/db";
import { createApiKey } from "../../../services/users/apiKeyStore";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

// BullMQ hangs on the shared ioredis mock, so the queues the router imports are mocked.
jest.mock("../../../workers/queues", () => ({
    scanQueue: {
        add: jest.fn().mockResolvedValue(undefined),
        getJobCounts: jest.fn().mockResolvedValue({ active: 0, waiting: 0, delayed: 0 }),
    },
}));

import { subsonicRouter } from "../index";

jest.setTimeout(30_000);

const PREFIX = "zz-subacct-";
const PASSWORD = "correct horse battery staple";
const app = express();
app.use("/rest", subsonicRouter);

let admin: { id: string; username: string };
let member: { id: string; username: string };

const ask = (action: string, as: { username: string }, query: Record<string, string> = {}) =>
    request(app)
        .get(`/rest/${action}.view`)
        .query({ u: as.username, p: PASSWORD, f: "json", v: "1.16.1", c: "test", ...query })
        .then((res) => res.body["subsonic-response"]);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    admin = await prisma.user.create({ data: { username: `${PREFIX}admin`, passwordHash, role: "admin" } });
    member = await prisma.user.create({ data: { username: `${PREFIX}member`, passwordHash, role: "user" } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await closeEngineConnections();
});

const stored = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

describe("the removed account actions", () => {
    const actions: Array<[string, (target: { username: string }) => Record<string, string>]> = [
        ["changePassword", (target) => ({ username: target.username, password: "brand-new-pass" })],
        ["createUser", () => ({ username: `${PREFIX}created`, password: "brand-new-pass", adminRole: "true" })],
        ["updateUser", (target) => ({ username: target.username, adminRole: "true", password: "brand-new-pass" })],
        ["deleteUser", (target) => ({ username: target.username })],
    ];

    it.each(actions)("%s answers the standard error to an admin", async (action, query) => {
        const answer = await ask(action, admin, query(member));

        expect(answer.status).toBe("failed");
        expect(answer.error.code).toBe(0);
        expect(answer.error.message).toMatch(/not supported/i);
    });

    it.each(actions)("%s answers the same to a member, on their own account", async (action, query) => {
        const answer = await ask(action, member, query(member));

        expect(answer.status).toBe("failed");
        expect(answer.error.code).toBe(0);
    });

    it.each(actions)("%s answers the same to an app key", async (action, query) => {
        const { key } = await createApiKey(admin.id, "test device");
        const answer = await request(app)
            .get(`/rest/${action}.view`)
            .query({ u: admin.username, apiKey: key, f: "json", v: "1.16.1", c: "test", ...query(member) })
            .then((res) => res.body["subsonic-response"]);

        expect(answer.status).toBe("failed");
        expect(answer.error.code).toBe(0);
    });

    it("changes nothing", async () => {
        const before = await stored(member.id);
        for (const [action, query] of actions) await ask(action, admin, query(member));

        const after = await stored(member.id);
        expect(after.passwordHash).toBe(before.passwordHash);
        expect(after.role).toBe("user");
        expect(after.tokenVersion).toBe(before.tokenVersion);
        expect(await prisma.user.count({ where: { username: `${PREFIX}created` } })).toBe(0);
    });

    it("still asks who is calling first", async () => {
        const answer = await ask("createUser", { username: member.username }, { p: "wrong password", username: "x", password: "y" });

        expect(answer.error.code).toBe(40);
    });
});

describe("getUser and getUsers", () => {
    it("getUsers lists every account for an admin", async () => {
        const answer = await ask("getUsers", admin);

        expect(answer.status).toBe("ok");
        const names = answer.users.user.map((u: { username: string }) => u.username);
        expect(names).toEqual(expect.arrayContaining([admin.username, member.username]));
        expect(answer.users.user.find((u: { username: string }) => u.username === admin.username).adminRole).toBe(true);
    });

    it("getUsers is for admins only", async () => {
        expect((await ask("getUsers", member)).error.code).toBe(50);
    });

    it("getUser answers the caller's own account, and any account for an admin", async () => {
        const own = await ask("getUser", member);
        expect(own.user).toMatchObject({ username: member.username, adminRole: false });

        const other = await ask("getUser", admin, { username: member.username });
        expect(other.user).toMatchObject({ username: member.username, adminRole: false });

        expect((await ask("getUser", member, { username: admin.username })).error.code).toBe(50);
    });
});
