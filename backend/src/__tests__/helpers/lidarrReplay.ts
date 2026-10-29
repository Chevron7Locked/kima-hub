/**
 * A local web server that answers as Lidarr did: it serves the exchanges
 * `scripts/record-lidarr.ts` recorded while Kima ran a scenario against a real
 * Lidarr (fixtures under `__tests__/fixtures/lidarr/`). `moment(seq)` winds
 * Lidarr back to that point of the run: each request gets the last reply
 * recorded for it at or before it. A request with no recorded reply gets a
 * 599 naming it, so a test never runs on an answer nobody recorded. Every
 * request is kept in `asked`, with its body, for the test to check.
 */
import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";

interface Exchange {
    seq: number;
    at: string;
    method: string;
    path: string;
    request: unknown;
    status: number;
    response: unknown;
}

export interface LidarrScenario {
    name: string;
    exchanges: Exchange[];
    webhooks: { eventType: string; payload: any; createdAt: string }[];
}

export function loadScenario(name: string): LidarrScenario {
    const file = path.join(__dirname, "..", "fixtures", "lidarr", `${name}.json`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** History reads carry the time they start from, which differs on every run. */
function key(method: string, url: string): string {
    const [p, q] = url.split("?");
    const params = new URLSearchParams(q ?? "");
    params.delete("date");
    const rest = params.toString();
    return `${method} ${p}${rest ? `?${rest}` : ""}`;
}

export interface LidarrReplay {
    url: string;
    asked: { method: string; path: string; body: unknown }[];
    /** Answer in recorded order, up to and including exchange `upTo`. */
    replay: (upTo: number) => void;
    /** Answer with Lidarr's state at exchange `seq`. */
    at: (seq: number) => void;
    close: () => Promise<void>;
}

export async function startLidarrReplay(scenario: LidarrScenario): Promise<LidarrReplay> {
    const byKey = new Map<string, Exchange[]>();
    for (const e of [...scenario.exchanges].sort((a, b) => a.seq - b.seq)) {
        const k = key(e.method, e.path);
        byKey.set(k, [...(byKey.get(k) ?? []), e]);
    }
    let cursor = Infinity;
    let inOrder = false;
    const served = new Map<string, number>();

    const pick = (k: string): Exchange | undefined => {
        const recorded = (byKey.get(k) ?? []).filter((e) => e.seq <= cursor);
        if (!inOrder) return recorded.at(-1);
        const next = served.get(k) ?? 0;
        served.set(k, next + 1);
        return recorded[Math.min(next, recorded.length - 1)];
    };

    const lidarr: LidarrReplay = {
        url: "",
        asked: [],
        replay: (upTo) => {
            cursor = upTo;
            inOrder = true;
            served.clear();
        },
        at: (seq) => {
            cursor = seq;
            inOrder = false;
        },
        close: async () => undefined,
    };
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8");
        const url = req.url ?? "";
        lidarr.asked.push({ method: req.method ?? "", path: url, body: text ? JSON.parse(text) : null });

        const reply = pick(key(req.method ?? "", url));
        if (!reply) {
            res.writeHead(599, { "content-type": "text/plain" });
            res.end(`no recorded Lidarr reply for ${req.method} ${url} at or before ${cursor}`);
            return;
        }
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.response === null ? "" : JSON.stringify(reply.response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    lidarr.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    lidarr.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return lidarr;
}
