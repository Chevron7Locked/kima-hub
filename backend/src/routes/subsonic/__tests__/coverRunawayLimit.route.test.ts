/**
 * Subsonic's cover route carries a runaway limit of its own, per address: an app loads a page of covers at once, and each
 * may be a fetch from another site, so a signed-in cover request is counted apart from the rest of Subsonic (1500 a
 * minute) and bounded higher (3000), as the web cover route is. Sign-in queries the database on every request, so the
 * general limit still counts every cover request before sign-in: a stranger's cover requests cost no more sign-in
 * queries than any other request, and are bounded by the same 1500. A signed-in cover request gives its count back to
 * the general limit when it finishes. A path that only starts like the cover route's is counted by the general limit.
 * Through the real Subsonic router and a real sign-in.
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
const limitOf = (res: request.Response) => Number(res.headers["ratelimit-limit"]);
const remainingOf = (res: request.Response) => Number(res.headers["ratelimit-remaining"]);
// A count given back happens when the response has finished, just after the client has the reply.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

let user: { username: string };

beforeAll(async () => {
    user = await prisma.user.create({
        data: { username: `covlimit_${Date.now()}`, passwordHash: await bcrypt.hash(PASSWORD, 10) },
    });
});
afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: "covlimit_" } } });
    await prisma.$disconnect();
});

const signedIn = (path: string) => request(app).get(path).query({ u: user.username, p: PASSWORD, f: "json", id: "al-none" });

describe("Subsonic cover requests that have not signed in", () => {
    it.each(["/rest/getCoverArt.view", "/rest/getCoverArt", "/rest/GETCOVERART"])(
        "%s shares the general limit of 1500 with every other call",
        async (path) => {
            const before = await request(app).get("/rest/ping.view?f=json");
            const cover = await request(app).get(path);
            const after = await request(app).get("/rest/ping.view?f=json");

            expect(limitOf(cover)).toBe(1500);
            expect(remainingOf(cover)).toBe(remainingOf(before) - 1);
            expect(remainingOf(after)).toBe(remainingOf(before) - 2);
        },
    );
});

describe("Subsonic cover requests that have signed in", () => {
    it.each(["/rest/getCoverArt.view", "/rest/getCoverArt", "/rest/GETCOVERART"])(
        "%s is counted by the cover limit of 3000, and gives its count back to the general limit",
        async (path) => {
            const before = await request(app).get("/rest/ping.view?f=json");
            const first = await signedIn(path);
            const second = await signedIn(path);
            await settle();
            const after = await request(app).get("/rest/ping.view?f=json");

            expect(limitOf(first)).toBe(3000);
            expect(remainingOf(second)).toBe(remainingOf(first) - 1);
            // Only the two pings are counted by the general limit.
            expect(limitOf(before)).toBe(1500);
            expect(remainingOf(after)).toBe(remainingOf(before) - 1);
        },
    );

    it("a path that only starts like the cover route's is counted by the general limit", async () => {
        const first = await signedIn("/rest/getCoverArtX.view");
        const second = await signedIn("/rest/getCoverArtX.view");
        await settle();
        const after = await request(app).get("/rest/ping.view?f=json");

        expect(limitOf(first)).toBe(1500);
        expect(remainingOf(second)).toBe(remainingOf(first) - 1);
        expect(remainingOf(after)).toBe(remainingOf(first) - 2);
    });
});
