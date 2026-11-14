/**
 * Subsonic's cover route carries a runaway limit of its own, per address: an app loads a page of covers at once, and each
 * may be a fetch from another site, so covers are counted apart from the rest of Subsonic (1500 a minute) and bounded
 * higher, as the web cover route is. A request is counted once, by the one limit that owns its path, and a path that only
 * starts like the cover route's is counted by the general limit. The limits sit in front of sign-in, so they count requests
 * sign-in refuses as well. Through the real Subsonic router.
 */

import express from "express";
import request from "supertest";
import { subsonicRouter } from "../index";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const app = express();
app.use("/rest", subsonicRouter);

const limitOf = (res: request.Response) => Number(res.headers["ratelimit-limit"]);
const remainingOf = (res: request.Response) => Number(res.headers["ratelimit-remaining"]);

afterAll(closeEngineConnections);

describe("Subsonic cover requests", () => {
    it.each(["/rest/getCoverArt.view", "/rest/getCoverArt", "/rest/GETCOVERART"])(
        "%s is counted by the cover limit, once, and not by the general limit",
        async (path) => {
            const before = await request(app).get("/rest/ping.view?f=json");
            const first = await request(app).get(path);
            const second = await request(app).get(path);
            const after = await request(app).get("/rest/ping.view?f=json");

            expect(limitOf(first)).toBe(3000);
            expect(remainingOf(second)).toBe(remainingOf(first) - 1);
            // Only the two pings are counted by the general limit.
            expect(limitOf(before)).toBe(1500);
            expect(remainingOf(after)).toBe(remainingOf(before) - 1);
        },
    );

    it("a path that only starts like the cover route's is counted by the general limit", async () => {
        const first = await request(app).get("/rest/getCoverArtX.view");
        const second = await request(app).get("/rest/getCoverArtX.view");

        expect(limitOf(first)).toBe(1500);
        expect(remainingOf(second)).toBe(remainingOf(first) - 1);
    });
});
