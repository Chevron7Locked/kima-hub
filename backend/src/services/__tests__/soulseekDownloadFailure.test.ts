/**
 * A Soulseek transfer whose connection fails reaches the download service with the connection's real cause, so
 * the service sorts it (connection reset, timeout...) and cools the peer down. The reader is driven by chunks;
 * there is no socket.
 */
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import stream from "stream";

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import type {
    DownloadWithToken,
    SlskDownloadEventEmitter,
} from "../../lib/soulseek/downloads";
import { FileTransferReader } from "../../lib/soulseek/fileTransfer";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

// The Soulseek client under test is built with no sockets: the server and listen connections are stubbed.
jest.mock("../../lib/soulseek/server");
jest.mock("../../lib/soulseek/listen");

let before: Record<string, unknown> | null;
let soulseekService: typeof import("../soulseek").soulseekService;
let dir: string;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    // Soulseek starts connecting as it loads when it is enabled; it is not.
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", soulseekEnabled: false }, update: { soulseekEnabled: false } });
    invalidateSystemSettingsCache();
    ({ soulseekService } = await import("../soulseek"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-slsk-"));
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    soulseekService.disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

afterEach(() => {
    jest.restoreAllMocks();
    (soulseekService as any).client = null;
});

const TOKEN_HEX = "deadbeef";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeDownload(): DownloadWithToken {
    return {
        status: "connected",
        username: "peer",
        filename: "a.flac",
        receivedBytes: 0n,
        stream: new stream.PassThrough(),
        events: new EventEmitter() as SlskDownloadEventEmitter,
        requestQueuePosition: () => {},
        queuePosition: 0,
        token: TOKEN_HEX,
        totalBytes: 10n,
    } as DownloadWithToken;
}

/** A transfer in progress through the service, and the reader that feeds it. */
async function startTransfer() {
    const service = soulseekService as any;
    const download = makeDownload();
    const reader = new FileTransferReader({
        findDownload: () => download,
        reply: () => {},
        end: () => {},
        settle: () => {},
        pause: () => {},
        resume: () => {},
    });
    service.client = { download: async () => download, removeDownload: jest.fn() };
    jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
    const markUserFailed = jest.spyOn(service, "markUserFailed").mockResolvedValue(undefined);
    const categorize = jest.spyOn(service, "categorizeError");
    const result = service.downloadTrack(
        { username: "peer", filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 },
        path.join(dir, "a.flac"),
    ) as Promise<{ success: boolean; error?: string }>;
    while (download.stream.listenerCount("error") === 0) await tick();
    reader.push(Buffer.concat([Buffer.from(TOKEN_HEX, "hex"), Buffer.from("abc")]));
    return { reader, result, markUserFailed, categorize };
}

it("sorts a reset connection as a connection failure and cools the peer down", async () => {
    expectLog("error");
    const t = await startTransfer();
    // the socket's 'error' and 'close' arrive back to back, error first
    t.reader.fail(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    t.reader.close();

    const result = await t.result;
    expect(result).toEqual({ success: false, error: "read ECONNRESET" });
    expect(t.categorize).toHaveBeenCalledTimes(1);
    expect(t.categorize.mock.results[0].value).toEqual({ type: "connection", skipUser: true });
    expect(t.markUserFailed).toHaveBeenCalledWith("peer");
});

/** Runs downloadTrack for a fake download; `onPipe` fires once the service has attached everything. */
async function failEarly(name: string, onPipe: (download: DownloadWithToken) => void, timeout?: number) {
    expectLog("error");
    const service = soulseekService as any;
    const download = makeDownload();
    (download as any).username = name;
    // the write stream is still opening when the failure arrives: microtasks run before the file system answers
    const pipe = download.stream.pipe.bind(download.stream);
    (download.stream as any).pipe = (dest: any) => {
        const piped = pipe(dest);
        queueMicrotask(() => onPipe(download));
        return piped;
    };
    service.client = { download: async () => download, removeDownload: jest.fn() };
    jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
    jest.spyOn(service, "markUserFailed").mockResolvedValue(undefined);
    const limit = service.DOWNLOAD_TIMEOUT_INITIAL;
    if (timeout !== undefined) service.DOWNLOAD_TIMEOUT_INITIAL = timeout;
    const dest = path.join(dir, `${name}.flac`);
    let result;
    try {
        result = await service.downloadTrack(
            { username: name, filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 },
            dest,
        );
    } finally {
        service.DOWNLOAD_TIMEOUT_INITIAL = limit;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { result, leftBehind: fs.existsSync(dest) };
}

describe("a failed download leaves no partial file", () => {
    it("after an error on the download's events, even one that arrives while the file is opening", async () => {
        const { result, leftBehind } = await failEarly("events-err", (d) =>
            d.events.emit("error", new Error("peer went away")),
        );
        expect(result).toEqual({ success: false, error: "peer went away" });
        expect(leftBehind).toBe(false);
    });

    it("after an error on the stream, even one that arrives while the file is opening", async () => {
        const { result, leftBehind } = await failEarly("stream-err", (d) => d.stream.destroy(new Error("read ECONNRESET")));
        expect(result).toEqual({ success: false, error: "read ECONNRESET" });
        expect(leftBehind).toBe(false);
    });

    it("after a timeout", async () => {
        const { result, leftBehind } = await failEarly("timed-out", () => {}, 1);
        expect(result).toEqual({ success: false, error: "Download timed out" });
        expect(leftBehind).toBe(false);
    });
});

it("fails a download whose file cannot be written, with the write error, and cools the peer down", async () => {
    expectLog("error");
    const service = soulseekService as any;
    const download = makeDownload();
    (download as any).username = "unwritable";
    service.client = { download: async () => download, removeDownload: jest.fn() };
    jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
    const markUserFailed = jest.spyOn(service, "markUserFailed").mockResolvedValue(undefined);
    // a folder where the file should go: the file system refuses to open it for writing
    const dest = path.join(dir, "unwritable.flac");
    fs.mkdirSync(dest);

    const result = await service.downloadTrack(
        { username: "unwritable", filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 },
        dest,
    );

    expect(result).toEqual({ success: false, error: expect.stringMatching(/^Write error: EISDIR/) });
    expect(markUserFailed).toHaveBeenCalledWith("unwritable");
});

it("fails a download that sat unfinished past its limit at once, with a stuck-download reason", async () => {
    expectLog("error");
    const { SlskClient } = await import("../../lib/soulseek/p2p-client");
    const real = new SlskClient();
    real.peers.set("stuck", { username: "stuck", send: jest.fn(), destroy: jest.fn() } as any);
    const service = soulseekService as any;
    service.client = real;
    jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
    jest.spyOn(service, "markUserFailed").mockResolvedValue(undefined);
    const waiting = service.downloadTrack(
        { username: "stuck", filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 },
        path.join(dir, "stuck.flac"),
    ) as Promise<{ success: boolean; error?: string }>;
    while (real.downloads.length === 0 || real.downloads[0].stream.listenerCount("error") < 2) await tick();
    (real.downloads[0] as any).startedAt = Date.now() - 6 * 60 * 1000;

    (real as any).cleanupStuckDownloads();

    await expect(waiting).resolves.toEqual({ success: false, error: expect.stringMatching(/stuck download/i) });
    expect(real.downloads).toHaveLength(0);
    real.destroy();
});

it("keeps a denial that lands before the service listens, and fails the download with its reason", async () => {
    expectLog("error");
    const { SlskClient } = await import("../../lib/soulseek/p2p-client");
    const real = new SlskClient();
    const peer = { username: "denier", send: jest.fn(), destroy: jest.fn() };
    real.peers.set("denier", peer as any);
    const service = soulseekService as any;
    service.client = {
        download: async (username: string, filename: string) => {
            const download = await real.download(username, filename);
            // the peer refuses, and the stream's error fires before downloadTrack has attached its listener
            real.peerMessages.emit("message", { kind: "uploadDenied", filename, reason: "Banned" }, peer as any);
            await tick();
            return download;
        },
        removeDownload: (d: any) => real.removeDownload(d),
    };
    jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
    const markUserFailed = jest.spyOn(service, "markUserFailed").mockResolvedValue(undefined);
    const categorize = jest.spyOn(service, "categorizeError");

    try {
        const result = await service.downloadTrack(
            { username: "denier", filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 },
            path.join(dir, "denied.flac"),
        );
        expect(result).toEqual({ success: false, error: "Upload denied: Banned" });
        expect(categorize).toHaveBeenCalledTimes(1);
        expect((categorize.mock.calls[0][0] as Error).message).toBe("Upload denied: Banned");
        expect(real.downloads).toHaveLength(0);
        // the file the write stream was opening is gone too, however early the denial was replayed
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(fs.existsSync(path.join(dir, "denied.flac"))).toBe(false);
        // sorted like a live error: a denial is an unknown failure, which cools the peer down
        expect(categorize.mock.results[0].value).toEqual({ type: "unknown", skipUser: true });
        expect(markUserFailed).toHaveBeenCalledWith("denier");
    } finally {
        real.destroy();
    }
});
