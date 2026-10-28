/**
 * The live event stream as a browser reads it: a one-time ticket opens it, the first message says it is connected,
 * and each event arrives as one `data:` line with its payload flattened beside `type` (the app reads
 * `data.playlistId` and `data.deleted` directly). Real Redis ticket, real route over HTTP, real event bus.
 */
import express from "express";
import http from "http";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import eventsRoutes from "../events";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { announcePlaylistChange } from "../../services/playlistEvents";

const USER = "zz-events-route-user";
let server: http.Server;
let base: string;

beforeAll(async () => {
    await waitForRedisReady();
    const app = express();
    app.use("/api/events", eventsRoutes);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((ready) => server.once("listening", () => ready()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
});

/** Opens the stream with a fresh ticket and collects each `data:` message as parsed JSON. */
async function openStream(): Promise<{ messages: any[]; close: () => void; status: number }> {
    const ticket = randomUUID();
    await redisClient.setex(`sse:ticket:${ticket}`, 30, USER);
    return new Promise((resolve, reject) => {
        const messages: any[] = [];
        const req = http.get(`${base}/api/events?ticket=${ticket}`, (res) => {
            let buffer = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                buffer += chunk;
                let end;
                while ((end = buffer.indexOf("\n\n")) !== -1) {
                    const block = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    if (block.startsWith("data: ")) messages.push(JSON.parse(block.slice(6)));
                }
            });
            resolve({ messages, close: () => req.destroy(), status: res.statusCode ?? 0 });
        });
        req.on("error", (err) => (String(err).includes("socket hang up") ? undefined : reject(err)));
    });
}

const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("the live event stream", () => {
    it("says it is connected, then delivers a playlist delete with its payload beside its type", async () => {
        const stream = await openStream();
        try {
            expect(stream.status).toBe(200);
            await until(() => stream.messages.length >= 1);
            expect(stream.messages[0]).toEqual({ type: "connected" });

            announcePlaylistChange(USER, "pl-gone", true);
            await until(() => stream.messages.length >= 2);

            expect(stream.messages[1]).toEqual({ type: "playlist:updated", playlistId: "pl-gone", deleted: true });
        } finally {
            stream.close();
        }
    });

    it("opens once per ticket", async () => {
        const ticket = randomUUID();
        await redisClient.setex(`sse:ticket:${ticket}`, 30, USER);
        const first = await new Promise<http.IncomingMessage>((ok) => {
            const req = http.get(`${base}/api/events?ticket=${ticket}`, (res) => { ok(res); req.destroy(); });
            req.on("error", () => undefined);
        });
        const second = await new Promise<number>((ok) => {
            http.get(`${base}/api/events?ticket=${ticket}`, (res) => { res.resume(); ok(res.statusCode ?? 0); });
        });
        expect(first.statusCode).toBe(200);
        expect(second).toBe(401);
    });
});
