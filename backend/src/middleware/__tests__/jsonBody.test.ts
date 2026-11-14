// The playback state save takes up to 5 MB of queue; every other address takes 1 MB. The large parser goes by whole
// path segment, so an address that only starts like the playback state's does not get it.

import express from "express";
import request from "supertest";
import { jsonBodyParser } from "../jsonBody";

const app = express();
app.use(jsonBodyParser);
app.post("*", (req, res) => void res.json({ bytes: JSON.stringify(req.body).length }));

const twoMegabytes = { queue: "x".repeat(2 * 1024 * 1024) };

describe("the JSON body limit", () => {
    it.each(["/api/playback-state", "/api/playback-state/", "/api/playback-state/sync"])("%s takes 2 MB", async (path) => {
        const res = await request(app).post(path).send(twoMegabytes);
        expect(res.status).toBe(200);
    });

    it.each(["/api/playback-stateX", "/api/playback-state-old", "/api/playback-statement/x", "/api/plays"])(
        "%s refuses 2 MB",
        async (path) => {
            const res = await request(app).post(path).send(twoMegabytes);
            expect(res.status).toBe(413);
        },
    );

    it("takes 1 MB everywhere", async () => {
        const res = await request(app).post("/api/plays").send({ queue: "x".repeat(512 * 1024) });
        expect(res.status).toBe(200);
    });

    it("refuses more than 5 MB even on the playback state", async () => {
        const res = await request(app).post("/api/playback-state").send({ queue: "x".repeat(6 * 1024 * 1024) });
        expect(res.status).toBe(413);
    });
});
