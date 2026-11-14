// Every path takes 1 MB, except the playback state, which the global parser leaves unread: its mount reads up to 5 MB
// after the access check (routes/__tests__/lateMounts.route.test.ts covers that against the real server). The skip goes
// by whole path segment, so a path that only starts like the playback state's is still read, at 1 MB.

import express from "express";
import request from "supertest";
import { jsonBodyParser, largeJsonBody } from "../jsonBody";

const app = express();
app.use(jsonBodyParser);
app.post("*", (req, res) => void res.json({ read: req.body !== undefined && Object.keys(req.body).length > 0 }));

const twoMegabytes = { queue: "x".repeat(2 * 1024 * 1024) };

describe("the global JSON body parser", () => {
    it.each(["/api/playback-state", "/api/playback-state/", "/api/playback-state/sync"])(
        "leaves %s unread, for its mount",
        async (path) => {
            // A small body: an answer that does not read a large one can reset the connection.
            const res = await request(app).post(path).send({ queue: "x" });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ read: false });
        },
    );

    it.each(["/api/playback-stateX", "/api/playback-state-old", "/api/playback-statement/x", "/api/plays"])(
        "refuses 2 MB on %s",
        async (path) => {
            const res = await request(app).post(path).send(twoMegabytes);
            expect(res.status).toBe(413);
        },
    );

    it("takes 1 MB everywhere else", async () => {
        const res = await request(app).post("/api/plays").send({ queue: "x".repeat(512 * 1024) });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ read: true });
    });
});

describe("the large JSON body parser", () => {
    const large = express();
    large.use(largeJsonBody);
    large.post("*", (req, res) => void res.json({ bytes: JSON.stringify(req.body).length }));

    it("takes 2 MB and refuses more than 5 MB", async () => {
        expect((await request(large).post("/").send(twoMegabytes)).status).toBe(200);
        expect((await request(large).post("/").send({ queue: "x".repeat(6 * 1024 * 1024) })).status).toBe(413);
    });
});
