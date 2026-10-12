/**
 * The preview proxy advertises `Accept-Ranges` when the CDN does, so it must
 * also honor the client's Range: forward it upstream and mirror the 206/416.
 * Proven against a real HTTP upstream on localhost, not a mocked socket.
 */

import http from "http";
import express from "express";
import request from "supertest";
import { AddressInfo } from "net";
import type { Response as SuperAgentResponse } from "superagent";
import { proxyPreviewStream } from "../previewProxy";

const BODY = Buffer.from("0123456789");

let upstream: http.Server;
let upstreamUrl: string;

beforeAll(async () => {
    upstream = http.createServer((req, res) => {
        if (req.url?.startsWith("/no-range")) {
            res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": BODY.length });
            res.end(BODY);
            return;
        }
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
        if (!range) {
            res.writeHead(200, {
                "Content-Type": "audio/mpeg",
                "Content-Length": BODY.length,
                "Accept-Ranges": "bytes",
            });
            res.end(BODY);
            return;
        }
        const start = range[1] === "" ? 0 : parseInt(range[1], 10);
        const end = range[2] === "" ? BODY.length - 1 : parseInt(range[2], 10);
        if (start >= BODY.length || start > end) {
            res.writeHead(416, {
                "Content-Range": `bytes */${BODY.length}`,
                "Accept-Ranges": "bytes",
            });
            res.end();
            return;
        }
        const slice = BODY.subarray(start, end + 1);
        res.writeHead(206, {
            "Content-Type": "audio/mpeg",
            "Content-Length": slice.length,
            "Content-Range": `bytes ${start}-${end}/${BODY.length}`,
            "Accept-Ranges": "bytes",
        });
        res.end(slice);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function makeApp(path: string) {
    const app = express();
    app.get("/", async (req, res) => {
        await proxyPreviewStream(res, `${upstreamUrl}${path}`, {
            notFoundMessage: "Preview not found",
            logLabel: "test preview",
            rangeHeader: req.headers.range,
        });
    });
    return app;
}

function parseBinary(res: SuperAgentResponse, cb: (err: Error | null, body?: Buffer) => void) {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
}

describe("preview proxy range support", () => {
    it("passes the full body through when no Range is sent", async () => {
        const res = await request(makeApp("/preview")).get("/").buffer().parse(parseBinary).expect(200);
        expect(res.headers["accept-ranges"]).toBe("bytes");
        expect(res.headers["content-range"]).toBeUndefined();
        expect(res.body.toString()).toBe(BODY.toString());
    });

    it("forwards Range and mirrors the upstream 206 with the right slice", async () => {
        const res = await request(makeApp("/preview"))
            .get("/")
            .set("Range", "bytes=2-4")
            .buffer()
            .parse(parseBinary)
            .expect(206);
        expect(res.headers["content-range"]).toBe(`bytes 2-4/${BODY.length}`);
        expect(res.headers["content-length"]).toBe("3");
        expect(res.body.toString()).toBe("234");
    });

    it("mirrors 416 for an unsatisfiable range", async () => {
        const res = await request(makeApp("/preview"))
            .get("/")
            .set("Range", "bytes=999-1000")
            .buffer()
            .parse(parseBinary)
            .expect(416);
        expect(res.headers["content-range"]).toBe(`bytes */${BODY.length}`);
    });

    it("does not claim a 206 when the upstream ignores Range", async () => {
        const res = await request(makeApp("/no-range"))
            .get("/")
            .set("Range", "bytes=2-4")
            .buffer()
            .parse(parseBinary)
            .expect(200);
        expect(res.headers["content-range"]).toBeUndefined();
        expect(res.body.toString()).toBe(BODY.toString());
    });
});
