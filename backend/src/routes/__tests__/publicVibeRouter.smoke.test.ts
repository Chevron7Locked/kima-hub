/**
 * The public vibe routes as a consuming server calls them: the token guard,
 * the gzipped library export with its ETag, the live state and its event
 * stream, text search and covers.
 */
import zlib from "zlib";

const TOKEN = "s".repeat(40);

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../config", () => ({
    USER_AGENT: "kima-test",
    config: { publicVibe: { token: "s".repeat(40), username: "listener" } },
}));
jest.mock("../../utils/db", () => ({
    prisma: { track: { findFirst: jest.fn() }, user: { findUnique: jest.fn() } },
}));
jest.mock("../../services/publicLibraryExport", () => ({ latestLibraryExport: jest.fn() }));
jest.mock("../../services/textEmbeddingBridge", () => ({ searchTracksByText: jest.fn() }));
jest.mock("../../services/artwork", () => ({ findAlbumArtwork: jest.fn(async () => null) }));
jest.mock("../../services/imageStorage", () => ({ getLocalImagePath: jest.fn(() => null) }));

import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { AddressInfo } from "net";
import express from "express";
import request from "supertest";
import publicVibeRouter from "../publicVibe";
import { prisma } from "../../utils/db";
import { latestLibraryExport } from "../../services/publicLibraryExport";
import { searchTracksByText } from "../../services/textEmbeddingBridge";
import { getLocalImagePath } from "../../services/imageStorage";
import { reportLive, resetLive, setLiveHidden } from "../../services/liveListening";

const app = express();
app.use(express.json());
app.use("/api/public/vibe", publicVibeRouter);
const auth = { Authorization: `Bearer ${TOKEN}` };

const TRACK = "ctrackaaaaaaaaaaaaaaaaaa1";
const LIBRARY = { version: 1, tracks: [{ id: TRACK }] };
const ETAG = '"abc123"';

let server: http.Server;
let port: number;

beforeAll(async () => {
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
    resetLive();
    (latestLibraryExport as jest.Mock).mockReturnValue({
        etag: ETAG,
        gzipped: zlib.gzipSync(JSON.stringify(LIBRARY)),
    });
});

// Opens the event stream, collects what arrives within `ms`, then hangs up.
function readStream(ms: number, during?: () => void): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: "127.0.0.1", port, path: "/api/public/vibe/live/events", headers: auth },
            (res) => {
                let body = "";
                res.on("data", (c) => (body += c));
                setTimeout(() => during?.(), ms / 3);
                setTimeout(() => {
                    req.destroy();
                    resolve({ status: res.statusCode ?? 0, body });
                }, ms);
            },
        );
        req.on("error", reject);
    });
}

describe("token guard", () => {
    it.each([
        ["no header", {}],
        ["a wrong token", { Authorization: "Bearer " + "x".repeat(40) }],
        ["the token without Bearer", { Authorization: TOKEN }],
    ])("refuses %s", async (_label, headers) => {
        const res = await request(app).get("/api/public/vibe/live").set(headers);
        expect(res.status).toBe(401);
    });
});

describe("GET /library", () => {
    it("sends the gzipped export with its ETag", async () => {
        const res = await request(app).get("/api/public/vibe/library").set(auth).set("Accept-Encoding", "gzip");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("gzip");
        expect(res.headers.etag).toBe(ETAG);
        expect(res.headers["cache-control"]).toBe("no-cache");
        expect(res.body).toEqual(LIBRARY);
    });

    it("sends plain JSON to a client that does not take gzip", async () => {
        const res = await request(app).get("/api/public/vibe/library").set(auth).set("Accept-Encoding", "identity");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBeUndefined();
        expect(res.body).toEqual(LIBRARY);
    });

    it("answers 304 when the client already has this version", async () => {
        const res = await request(app).get("/api/public/vibe/library").set(auth).set("If-None-Match", ETAG);
        expect(res.status).toBe(304);
    });

    it("answers 503 with a retry time before the first export is built", async () => {
        (latestLibraryExport as jest.Mock).mockReturnValue(null);
        const res = await request(app).get("/api/public/vibe/library").set(auth);
        expect(res.status).toBe(503);
        expect(res.headers["retry-after"]).toBe("30");
    });
});

describe("live", () => {
    it("GET /live reports nothing playing before any report", async () => {
        const res = await request(app).get("/api/public/vibe/live").set(auth);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: "stopped", trackId: null });
    });

    it("GET /live reports the playing track", async () => {
        reportLive({ status: "playing", trackId: TRACK, position: 1_000, duration: 180_000, queue: [] });
        const res = await request(app).get("/api/public/vibe/live").set(auth);
        expect(res.body).toMatchObject({ status: "playing", trackId: TRACK, duration: 180_000 });
    });

    it("GET /live reads hidden while sharing is off, and the stream says so when it turns off", async () => {
        reportLive({ status: "playing", trackId: TRACK, position: 0, duration: 180_000, queue: [] });
        const { body } = await readStream(300, () => setLiveHidden(true));
        expect(body.split("\n\n").filter(Boolean).map((frame) => frame.split("\n")[0])).toEqual([
            "event: state",
            "event: hidden",
        ]);
        const res = await request(app).get("/api/public/vibe/live").set(auth);
        expect(res.body).toMatchObject({ status: "hidden", trackId: null });
    });

    it("the event stream opens with the state, then carries each change", async () => {
        const { status, body } = await readStream(300, () =>
            reportLive({ status: "playing", trackId: TRACK, position: 0, duration: 180_000, queue: [] }),
        );
        expect(status).toBe(200);
        const events = body.split("\n\n").filter(Boolean).map((frame) => frame.split("\n")[0]);
        expect(events).toEqual(["event: state", "event: started"]);
        expect(body).toContain(`"trackId":"${TRACK}"`);
    });

    it("refuses a fifth stream before sending any stream headers", async () => {
        const open = [0, 1, 2, 3].map(() => readStream(500));
        await new Promise((r) => setTimeout(r, 150));
        const res = await request(app).get("/api/public/vibe/live/events").set(auth);
        expect(res.status).toBe(429);
        expect(res.headers["content-type"]).toMatch(/json/);
        await Promise.all(open);
    });
});

describe("POST /search", () => {
    it("ranks tracks for a description", async () => {
        (searchTracksByText as jest.Mock).mockResolvedValueOnce([
            { id: TRACK, title: "Match", distance: 0.25, albumId: "al", albumTitle: "Al", artistId: "ar", artistName: "Ar" },
        ]);
        const res = await request(app).post("/api/public/vibe/search?limit=5").set(auth).send({ query: "slow rain" });
        expect(res.status).toBe(200);
        expect(searchTracksByText).toHaveBeenCalledWith("slow rain", 5);
        expect(res.body.tracks).toEqual([
            { trackId: TRACK, title: "Match", similarity: 0.75, album: { id: "al", title: "Al" }, artist: { id: "ar", name: "Ar" } },
        ]);
    });

    it("refuses a query under two characters", async () => {
        const res = await request(app).post("/api/public/vibe/search").set(auth).send({ query: "a" });
        expect(res.status).toBe(400);
    });

    it("answers 503 when the text model is down", async () => {
        (searchTracksByText as jest.Mock).mockRejectedValueOnce(new Error("analyzer offline"));
        const res = await request(app).post("/api/public/vibe/search").set(auth).send({ query: "slow rain" });
        expect(res.status).toBe(503);
    });
});

describe("GET /cover/:trackId", () => {
    const file = path.join(os.tmpdir(), `kima-public-cover-${process.pid}.jpg`);
    const bytes = Buffer.from("ffd8ffe000104a464946", "hex");

    beforeAll(() => fs.writeFileSync(file, bytes));
    afterAll(() => fs.rmSync(file, { force: true }));

    it("refuses an id that is not a track id", async () => {
        const res = await request(app).get("/api/public/vibe/cover/..%2Fetc").set(auth);
        expect(res.status).toBe(400);
    });

    it("serves the stored cover with an ETag, then 304 for it", async () => {
        (prisma.track.findFirst as jest.Mock).mockResolvedValue({
            album: { coverUrl: "native:al.jpg", rgMbid: null, title: "Al", artist: { name: "Ar" } },
        });
        (getLocalImagePath as jest.Mock).mockReturnValue(file);
        const res = await request(app).get(`/api/public/vibe/cover/${TRACK}`).set(auth);
        expect(res.status).toBe(200);
        expect(Buffer.from(res.body)).toEqual(bytes);
        const again = await request(app).get(`/api/public/vibe/cover/${TRACK}`).set(auth).set("If-None-Match", res.headers.etag);
        expect(again.status).toBe(304);
    });

    it("answers 404 for a track with no stored cover", async () => {
        (prisma.track.findFirst as jest.Mock).mockResolvedValue({
            album: { coverUrl: null, rgMbid: null, title: "Al", artist: { name: "Ar" } },
        });
        const res = await request(app).get(`/api/public/vibe/cover/${TRACK}`).set(auth);
        expect(res.status).toBe(404);
    });
});
