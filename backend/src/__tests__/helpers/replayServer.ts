/**
 * A local web server that answers as an outside service did: it serves the real replies recorded by
 * `scripts/record-musicbrainz.ts` or `scripts/record-apple-podcasts.ts` (fixtures under `__tests__/fixtures/<folder>/`).
 * Point the service at it (MUSICBRAINZ_BASE_URL, ITUNES_BASE_URL) before the service is imported. A request with no
 * recorded reply gets a 599 naming it and the service, so a test never runs on an answer nobody recorded.
 * `onRequest` runs before a reply is sent, which lets a test do something while Kima is waiting on the service.
 */
import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";

export interface RecordedReplies {
    source: string;
    recordedAt: string;
    replies: Record<string, { status: number; body: unknown }>;
}

export function loadRecording(folder: "musicbrainz" | "apple", name: string): RecordedReplies {
    const file = path.join(__dirname, "..", "fixtures", folder, `${name}.json`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

export interface ReplayServer {
    url: string;
    asked: string[];
    onRequest: ((request: string) => Promise<void>) | null;
    close: () => Promise<void>;
}

export async function startReplayServer(recording: RecordedReplies): Promise<ReplayServer> {
    const replay: ReplayServer = { url: "", asked: [], onRequest: null, close: async () => undefined };
    const server = http.createServer(async (req, res) => {
        const request = req.url ?? "";
        replay.asked.push(request);
        if (replay.onRequest) await replay.onRequest(request);
        const reply = recording.replies[request];
        if (!reply) {
            res.writeHead(599, { "content-type": "text/plain" });
            res.end(`no recorded reply from ${recording.source} for ${request}`);
            return;
        }
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    replay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    replay.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return replay;
}
