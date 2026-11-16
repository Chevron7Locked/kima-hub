/**
 * A Subsonic call is served whatever letter case the app writes the endpoint and its `.view` suffix in, as the router
 * matches any case; the suffix a call lacks is added, but one written in capitals is already there. Through the real
 * Subsonic router and a real sign-in.
 */

import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { prisma } from "../../../utils/db";

// BullMQ hangs on the shared ioredis mock, so the queues the router imports are mocked.
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

const PASSWORD = "correct horse battery staple";
let user: { username: string };

beforeAll(async () => {
    user = await prisma.user.create({
        data: { username: `viewcase_${Date.now()}`, passwordHash: await bcrypt.hash(PASSWORD, 10) },
    });
});
afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: "viewcase_" } } });
    await prisma.$disconnect();
});

describe("a Subsonic call in any letter case", () => {
    it.each([
        ["/rest/search3.view", "searchResult3"],
        ["/rest/Search3.view", "searchResult3"],
        ["/rest/Search3.VIEW", "searchResult3"],
        ["/rest/SEARCH3.View", "searchResult3"],
        ["/rest/SEARCH3", "searchResult3"],
        ["/rest/Search2.VIEW", "searchResult2"],
        ["/rest/GetSimilarSongs2.VIEW", "similarSongs2"],
        ["/rest/getSimilarSongs.View", "similarSongs"],
    ])("%s is answered under %s", async (path, key) => {
        const res = await request(app).get(path).query({ u: user.username, p: PASSWORD, f: "json", query: "zz-none", id: "zz-none" });

        expect(res.status).toBe(200);
        expect(Object.keys(res.body["subsonic-response"])).toContain(key);
    });
});
