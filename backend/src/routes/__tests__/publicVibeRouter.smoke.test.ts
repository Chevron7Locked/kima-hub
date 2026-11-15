/**
 * The public vibe routes as a consuming server calls them: the token guard,
 * the gzipped library export with its ETag, the live state and its event
 * stream, text search and covers.
 */
import zlib from "zlib";

const TOKEN = "s".repeat(40);

// Stored covers live beside the transcode cache; this points them at a folder of this file's own.
jest.mock("../../config", () => ({
    USER_AGENT: "kima-test",
    config: {
        publicVibe: { token: "s".repeat(40), username: "listener" },
        music: { transcodeCachePath: require("path").join(require("os").tmpdir(), `kima-pvibe-${process.pid}`, "transcodes") },
    },
}));
jest.mock("../../services/publicLibraryExport", () => ({ latestLibraryExport: jest.fn() }));
jest.mock("../../services/textEmbeddingBridge", () => ({ searchTracksByText: jest.fn() }));
jest.mock("../../services/artwork", () => ({ findAlbumArtwork: jest.fn(async () => null) }));
jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

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
import { findAlbumArtwork } from "../../services/artwork";
import { fetchChecked } from "../../utils/ssrf";
import { MAX_PICTURE_BYTES } from "../../services/imageStorage";
import { coversBasePath } from "../../services/imageStorage";
import { reportLive, resetLive, setLiveHidden } from "../../services/liveListening";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const app = express();
app.use(express.json());
mountAsServer(app, "/api/public/vibe", publicVibeRouter, "/api/public/vibe");
const auth = { Authorization: `Bearer ${TOKEN}` };

const TRACK = "ctrackaaaaaaaaaaaaaaaaaa1";
// The cover tests seed their own rows, under ids only this file uses.
const P = "pvibe_smoke";
const COVER_TRACK = "cpvibesmoketrack0001";
const NO_COVER_TRACK = "cpvibesmoketrack0002";
const MISSING_FILE_TRACK = "cpvibesmoketrack0003";
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
        expectLog("warn");
        const res = await request(app).get("/api/public/vibe/live").set(auth);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: "stopped", trackId: null });
    });

    it("GET /live reports the playing track", async () => {
        expectLog("warn");
        reportLive({ status: "playing", trackId: TRACK, position: 1_000, duration: 180_000, queue: [] });
        const res = await request(app).get("/api/public/vibe/live").set(auth);
        expect(res.body).toMatchObject({ status: "playing", trackId: TRACK, duration: 180_000 });
    });

    it("GET /live reads hidden while sharing is off, and the stream says so when it turns off", async () => {
        expectLog("warn");
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
        expectLog("warn");
        const { status, body } = await readStream(300, () =>
            reportLive({ status: "playing", trackId: TRACK, position: 0, duration: 180_000, queue: [] }),
        );
        expect(status).toBe(200);
        const events = body.split("\n\n").filter(Boolean).map((frame) => frame.split("\n")[0]);
        expect(events).toEqual(["event: state", "event: started"]);
        expect(body).toContain(`"trackId":"${TRACK}"`);
    });

    it("refuses a fifth stream before sending any stream headers", async () => {
        expectLog("warn");
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
        expectLog("warn");
        const res = await request(app).post("/api/public/vibe/search").set(auth).send({ query: "a" });
        expect([res.status, res.body]).toEqual([400, { error: "query must be 2-500 characters" }]);
    });

    it("answers 503 when the text model is down", async () => {
        expectLog("error");
        (searchTracksByText as jest.Mock).mockRejectedValueOnce(new Error("analyzer offline"));
        const res = await request(app).post("/api/public/vibe/search").set(auth).send({ query: "slow rain" });
        expect(res.status).toBe(503);
    });
});

describe("GET /cover/:trackId", () => {
    const coverDir = path.join(coversBasePath(), "albums");
    const file = path.join(coverDir, `${P}.jpg`);
    const bytes = Buffer.from("ffd8ffe000104a464946", "hex");

    async function seedTrack(id: string, key: string, coverUrl: string | null) {
        await prisma.artist.create({
            data: { id: `${P}_art_${key}`, name: "Ar", normalizedName: "ar", identityKey: `${P}_ik_${key}` },
        });
        await prisma.album.create({
            data: { id: `${P}_alb_${key}`, rgMbid: `${P}_rg_${key}`, artistId: `${P}_art_${key}`, identityKey: `${P}_ak_${key}`, title: "Al", primaryType: "Album", coverUrl },
        });
        await prisma.track.create({
            data: { id, albumId: `${P}_alb_${key}`, title: "T", trackNo: 1, duration: 100, filePath: `${P}/${key}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }

    beforeAll(async () => {
        fs.mkdirSync(coverDir, { recursive: true });
        fs.writeFileSync(file, bytes);
        await seedTrack(COVER_TRACK, "cover", `native:albums/${P}.jpg`);
        await seedTrack(NO_COVER_TRACK, "none", null);
        // A stored cover whose file has gone; the mocked artwork sources have no copy.
        await seedTrack(MISSING_FILE_TRACK, "gone", `native:albums/${P}_gone.jpg`);
    });

    afterAll(async () => {
        await prisma.track.deleteMany({ where: { id: { in: [COVER_TRACK, NO_COVER_TRACK, MISSING_FILE_TRACK] } } });
        await prisma.album.deleteMany({ where: { id: { startsWith: `${P}_alb_` } } });
        await prisma.artist.deleteMany({ where: { id: { startsWith: `${P}_art_` } } });
        fs.rmSync(path.join(os.tmpdir(), `kima-pvibe-${process.pid}`), { recursive: true, force: true });
    });

    it("refuses an id that is not a track id", async () => {
        expectLog("warn");
        const res = await request(app).get("/api/public/vibe/cover/..%2Fetc").set(auth);
        expect([res.status, res.body]).toEqual([400, { error: "Invalid request" }]);
    });

    it("serves the stored cover with an ETag, then 304 for it", async () => {
        const res = await request(app).get(`/api/public/vibe/cover/${COVER_TRACK}`).set(auth);
        expect(res.status).toBe(200);
        expect(Buffer.from(res.body)).toEqual(bytes);
        const again = await request(app).get(`/api/public/vibe/cover/${COVER_TRACK}`).set(auth).set("If-None-Match", res.headers.etag);
        expect(again.status).toBe(304);
    });

    it("answers 404 for a track with no stored cover", async () => {
        const res = await request(app).get(`/api/public/vibe/cover/${NO_COVER_TRACK}`).set(auth);
        expect(res.status).toBe(404);
    });

    it("answers 404 for a stored cover whose file has gone and no source has a copy", async () => {
        const res = await request(app).get(`/api/public/vibe/cover/${MISSING_FILE_TRACK}`).set(auth);
        expect(res.status).toBe(404);
    });

    it("answers 404 for a track that is not in the library", async () => {
        const res = await request(app).get("/api/public/vibe/cover/cpvibesmokenosuchtrack").set(auth);
        expect(res.status).toBe(404);
    });

    describe("when the stored file has gone and a source has a copy", () => {
        const ask = (reply: Response) => {
            (findAlbumArtwork as jest.Mock).mockResolvedValueOnce({ url: "https://covers.test/a.jpg" });
            (fetchChecked as jest.Mock).mockResolvedValueOnce(reply);
            return request(app).get(`/api/public/vibe/cover/${MISSING_FILE_TRACK}`).set(auth);
        };

        it("serves the copy with its image type", async () => {
            const res = await ask(new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }));
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toBe("image/png");
            expect(Buffer.from(res.body)).toEqual(bytes);
        });

        it("answers 404 for a copy over the size cap", async () => {
            expectLog("warn");
            const res = await ask(
                new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(MAX_PICTURE_BYTES + 1) } }),
            );
            expect(res.status).toBe(404);
        });

        it("answers 404 for a reply that is no image", async () => {
            expectLog("warn");
            const res = await ask(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
            expect(res.status).toBe(404);
        });
    });
});
