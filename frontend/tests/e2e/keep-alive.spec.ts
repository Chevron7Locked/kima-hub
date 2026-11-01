import { test, expect } from "@playwright/test";
import net from "node:net";
import tls from "node:tls";
import { requireBaseUrl } from "./fixtures/target";

/**
 * The web server must keep an idle connection open longer than a reverse proxy does (nginx closes idle upstream
 * connections after 60 s), or a proxy can send a POST down a connection the server is closing and answer 502. One raw
 * connection, so nothing quietly opens a new one; KIMA_UI_BASE_URL must reach the web server itself, not a proxy.
 */

const IDLE_MS = 10_000;

/** Sends one request and resolves with the reply's head once the whole reply has arrived. */
function ask(socket: net.Socket, host: string, path: string, lastError: () => string): Promise<string> {
    return new Promise((resolve, reject) => {
        if (socket.destroyed) {
            reject(new Error(`the connection was already closed before asking ${path}${lastError()}`));
            return;
        }
        let raw = "";
        const onData = (chunk: Buffer) => {
            raw += chunk.toString("latin1");
            const end = raw.indexOf("\r\n\r\n");
            if (end < 0) return;
            const head = raw.slice(0, end);
            const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1]);
            const chunked = /^transfer-encoding:\s*chunked/im.test(head);
            if (!Number.isFinite(length) && !chunked) {
                done();
                reject(new Error(`${path} answered with neither a length nor chunks, so the connection cannot be reused:\n${head}`));
                return;
            }
            const body = raw.slice(end + 4);
            if ((Number.isFinite(length) && body.length >= length) || (chunked && /(^|\r\n)0\r\n\r\n$/.test(body))) {
                done();
                resolve(head);
            }
        };
        const onClose = () => {
            done();
            reject(new Error(`the server closed the connection before answering ${path}${lastError()}`));
        };
        const done = () => {
            socket.off("data", onData);
            socket.off("close", onClose);
        };
        socket.on("data", onData);
        socket.on("close", onClose);
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`);
    });
}

test.describe("Idle connections", () => {
    test.skip(!!process.env.KIMA_E2E_START_WEB, "the dev server has no keep-alive setting; this checks the shipped server");

    for (const path of ["/login", "/api/health"]) {
        test(`${path}: an idle connection stays open past 10 s and answers again, and the reply says how long it stays`, async () => {
            test.setTimeout(IDLE_MS + 30_000);
            const url = new URL(requireBaseUrl());
            const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
            const socket: net.Socket =
                url.protocol === "https:"
                    ? tls.connect({ host: url.hostname, port, servername: url.hostname })
                    : net.connect({ host: url.hostname, port });
            // An error closes the socket, which the checks below report with the error's own words.
            let error: Error | null = null;
            socket.on("error", (e) => (error = e));
            const lastError = () => (error ? ` (${error.message})` : "");
            let closedAt: number | null = null;
            const opened = Date.now();
            socket.on("close", () => (closedAt ??= Date.now() - opened));
            try {
                await new Promise<void>((resolve, reject) => {
                    socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => resolve());
                    socket.once("close", () => reject(new Error(`could not connect to ${url.host}${lastError()}`)));
                });
                const first = await ask(socket, url.host, path, lastError);
                expect(first, "first reply").toMatch(/^HTTP\/1\.1 200/);
                const hintHeader = /^keep-alive:\s*timeout=(\d+)/im.exec(first)?.[1];
                expect(hintHeader, "the reply has no keep-alive hint; is KIMA_UI_BASE_URL a proxy?").toBeDefined();
                const hint = Number(hintHeader);
                expect(hint, "the reply's keep-alive hint, in seconds").toBeGreaterThanOrEqual(60);

                await new Promise((r) => setTimeout(r, IDLE_MS));
                expect(closedAt, "the server closed the idle connection").toBeNull();

                const second = await ask(socket, url.host, path, lastError);
                expect(second, "reply on the same connection after the wait").toMatch(/^HTTP\/1\.1 200/);
            } finally {
                socket.destroy();
            }
        });
    }
});
