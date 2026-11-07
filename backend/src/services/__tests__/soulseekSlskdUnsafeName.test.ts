/**
 * With slskd, a source whose file name leads outside the downloads folder fails that download, the failure names the
 * peer, and the next source is tried. The service, the settings row, the folder, the files and the links are real;
 * slskd is a local HTTP server answering with its transfer reply shape.
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { configureSlskd, peekSlskdConfig } from "../../lib/soulseek/slskd-client";
import { soulseekService } from "../soulseek";

const SETTINGS = { id: "default" };

let base: string;
let downloads: string;
let library: string;
let server: http.Server;
let savedClient: ReturnType<typeof peekSlskdConfig>;
let savedRow: Awaited<ReturnType<typeof prisma.systemSettings.findUnique>>;

const FILES: Record<string, string> = {
    badpeer: "../secret.flac",
    goodpeer: "Artist\\Album\\good.flac",
};

function transfers() {
    return Object.entries(FILES).map(([username, filename]) => ({
        username,
        directories: [
            {
                directory: "Music\\Album",
                fileCount: 1,
                files: [
                    {
                        id: `00000000-0000-4000-8000-00000000000${username.length}`,
                        username,
                        direction: "Download",
                        filename,
                        size: 10,
                        state: "Completed, Succeeded",
                        bytesTransferred: 10,
                        percentComplete: 100,
                    },
                ],
            },
        ],
    }));
}

function match(username: string, fullPath: string, filename: string) {
    return { username, filename, fullPath, size: 10, quality: "FLAC", score: 10 };
}

beforeAll(async () => {
    savedClient = peekSlskdConfig();
    savedRow = await prisma.systemSettings.findUnique({ where: SETTINGS });
    server = http.createServer((req, res) => {
        const json = (status: number, body?: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(body === undefined ? undefined : JSON.stringify(body));
        };
        if (req.method === "GET" && req.url === "/api/v0/application") {
            return json(200, { server: { isConnected: true, isLoggedIn: true } });
        }
        if (req.method === "POST" && req.url?.startsWith("/api/v0/transfers/downloads/")) {
            return json(201, { enqueued: [], failed: [] });
        }
        if (req.method === "GET" && req.url === "/api/v0/transfers/downloads") return json(200, transfers());
        if (req.method === "DELETE") return json(204);
        return json(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
    soulseekService.disconnect();
    configureSlskd({ url: savedClient.url, apiKey: savedClient.apiKey, downloads: savedClient.downloads });
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    base = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "slskd-unsafe-name-")));
    downloads = path.join(base, "downloads");
    library = path.join(base, "library");
    await fs.promises.mkdir(downloads);
    await fs.promises.mkdir(library);
    const data = {
        soulseekEnabled: true,
        soulseekMode: "slskd",
        slskdUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        soulseekDownloadPath: downloads,
    };
    await prisma.systemSettings.upsert({ where: SETTINGS, update: data, create: { ...SETTINGS, ...data } });
    invalidateSystemSettingsCache();
});

afterEach(async () => {
    soulseekService.disconnect();
    if (savedRow) {
        await prisma.systemSettings.update({ where: SETTINGS, data: savedRow });
    } else {
        await prisma.systemSettings.deleteMany({ where: SETTINGS });
    }
    invalidateSystemSettingsCache();
    await fs.promises.rm(base, { recursive: true, force: true });
});

const bad = () => match("badpeer", "../secret.flac", "secret.flac");
const good = () => match("goodpeer", "Artist\\Album\\good.flac", "good.flac");

it("names the peer when its file name leads outside the downloads folder, and writes nothing", async () => {
    await fs.promises.writeFile(path.join(base, "secret.flac"), "TOP-SECRET");
    const result = await soulseekService.downloadBestMatch("A", "T", "Alb", [bad()], library);
    expect(result).toEqual({
        success: false,
        error:
            "All 1 attempts failed: badpeer: Soulseek peer badpeer sent a file name outside the downloads folder: ../secret.flac",
    });
    const written = await fs.promises.readdir(library, { recursive: true });
    expect(written.filter((f) => f.endsWith(".flac"))).toEqual([]);
}, 30000);

it("tries the next source after such a failure", async () => {
    await fs.promises.writeFile(path.join(base, "secret.flac"), "TOP-SECRET");
    await fs.promises.mkdir(path.join(downloads, "Artist", "Album"), { recursive: true });
    await fs.promises.writeFile(path.join(downloads, "Artist", "Album", "good.flac"), "good-bytes");
    const result = await soulseekService.downloadBestMatch("A", "T", "Alb", [bad(), good()], library);
    expect(result.success).toBe(true);
    expect(await fs.promises.readFile(result.filePath!, "utf8")).toBe("good-bytes");
}, 40000);
