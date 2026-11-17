/**
 * A Soulseek transfer whose connection fails reaches the download service with the connection's real cause, so
 * the service sorts it (connection reset, timeout...) and cools the peer down. The reader is driven by chunks;
 * there is no socket.
 */
import { EventEmitter } from "events";
import crypto from "crypto";
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
import PQueue from "p-queue";
import { soulseekDownloadsTotal } from "../../utils/metrics";
import { logger } from "../../utils/logger";

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

/** The hidden `.part` files written beside `dest`: each try gives its own a name of its own, not `dest`'s. */
const HIDDEN_PART = /^\.[0-9a-f-]{36}\.part$/;
const partsBeside = (dest: string) => fs.readdirSync(path.dirname(dest)).filter((n) => HIDDEN_PART.test(n));

/**
 * Runs downloadTrack for a fake download; `onPipe` fires once the service has attached everything, while the
 * write stream is still opening. `folderAtDest` puts a folder where the file is written, so it cannot be.
 */
async function runEarly(
    name: string,
    onPipe: (download: DownloadWithToken) => void,
    options: { timeout?: number; folderAtDest?: boolean; recordingFails?: boolean; existing?: string } = {},
) {
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
    const removeDownload = jest.fn();
    service.client = { download: async () => download, removeDownload };
    jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
    const markUserFailed = jest.spyOn(service, "markUserFailed");
    // `recordingFails`: noting the peer's failure throws (the database is down)
    if (options.recordingFails) markUserFailed.mockRejectedValue(new Error("db down"));
    else markUserFailed.mockResolvedValue(undefined);
    const limit = service.DOWNLOAD_TIMEOUT_INITIAL;
    if (options.timeout !== undefined) service.DOWNLOAD_TIMEOUT_INITIAL = options.timeout;
    const dest = path.join(dir, `${name}.flac`);
    // the file is written beside its destination and moved in, so the folder goes where the file is written
    if (options.folderAtDest) {
        jest.spyOn(crypto, "randomUUID").mockReturnValue("blocked-0000-0000-0000-000000000000");
        fs.mkdirSync(path.join(path.dirname(dest), ".blocked-0000-0000-0000-000000000000.part"), { recursive: true });
    }
    // `existing`: a good file is already at the destination
    if (options.existing !== undefined) fs.writeFileSync(dest, options.existing);
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
    return {
        result,
        download,
        dest,
        removeDownload,
        markUserFailed,
        cooledDown: service.userConnectionCooldowns.has(name) as boolean,
        leftBehind: fs.existsSync(dest) || partsBeside(dest).some((n) => !fs.statSync(path.join(dir, n)).isDirectory()),
        partLeft: partsBeside(dest).some((n) => !fs.statSync(path.join(dir, n)).isDirectory()),
    };
}

/** The peer sends the whole file, in the same breath as the connection opens. */
function sendWholeFile(download: DownloadWithToken) {
    const reader = new FileTransferReader({
        findDownload: () => download,
        reply: () => {},
        end: () => {},
        settle: () => {},
        pause: () => {},
        resume: () => {},
    });
    reader.push(Buffer.concat([Buffer.from(TOKEN_HEX, "hex"), Buffer.alloc(10, 1)]));
}

describe("a failed download leaves no partial file", () => {
    it("after an error on the download's events, even one that arrives while the file is opening", async () => {
        const { result, leftBehind } = await runEarly("events-err", (d) =>
            d.events.emit("error", new Error("peer went away")),
        );
        expect(result).toEqual({ success: false, error: "peer went away" });
        expect(leftBehind).toBe(false);
    });

    it("after an error on the stream, even one that arrives while the file is opening", async () => {
        const { result, leftBehind } = await runEarly("stream-err", (d) => d.stream.destroy(new Error("read ECONNRESET")));
        expect(result).toEqual({ success: false, error: "read ECONNRESET" });
        expect(leftBehind).toBe(false);
    });

    it("after a timeout", async () => {
        const { result, leftBehind } = await runEarly("timed-out", () => {}, { timeout: 1 });
        expect(result).toEqual({ success: false, error: "Download timed out" });
        expect(leftBehind).toBe(false);
    });
});

it("closes the download's own stream when its events report an error", async () => {
    const { download } = await runEarly("events-destroy", (d) => d.events.emit("error", new Error("peer went away")));
    expect(download.stream.destroyed).toBe(true);
});

describe("a finished download", () => {
    it("is reported only once the whole file is on disk, even when the peer's last byte lands while the file is opening", async () => {
        const { result, dest } = await runEarly("whole-file", sendWholeFile);
        expect(result).toEqual({ success: true });
        expect(fs.statSync(dest).size).toBe(10);
    });

    it("is dropped from the client's list", async () => {
        const { download, removeDownload } = await runEarly("dropped", sendWholeFile);
        expect(removeDownload).toHaveBeenCalledWith(download);
    });

    it("fails with the write error when the file cannot be written, though the peer sent every byte", async () => {
        const { result } = await runEarly("whole-unwritable", sendWholeFile, { folderAtDest: true });
        expect(result).toEqual({ success: false, error: expect.stringMatching(/^Write error: EISDIR/) });
    });
});

it("fails a download whose file cannot be written with the write error, and leaves the peer alone", async () => {
    // a folder where the file should go: the file system refuses to open it for writing
    const { result, markUserFailed, cooledDown } = await runEarly("unwritable", () => {}, { folderAtDest: true });
    expect(result).toEqual({ success: false, error: expect.stringMatching(/^Write error: EISDIR/) });
    // the fault is this machine's, not the peer's
    expect(markUserFailed).not.toHaveBeenCalled();
    expect(cooledDown).toBe(false);
});

describe("a download always settles", () => {
    it("with a failure when the work after its ending throws, and leaves nothing behind", async () => {
        // the timeout ends it, and noting the peer's failure throws
        const { result, leftBehind, download, removeDownload } = await runEarly("throws", () => {}, {
            timeout: 1,
            recordingFails: true,
        });
        expect(result).toEqual({ success: false, error: "db down" });
        expect(leftBehind).toBe(false);
        expect(removeDownload).toHaveBeenCalledWith(download);
        expect(download.stream.destroyed).toBe(true);
    });

    it("with a failure when noting a stream error's peer throws, and leaves nothing behind", async () => {
        const { result, leftBehind, download, removeDownload } = await runEarly(
            "stream-throws",
            (d) => d.stream.destroy(new Error("read ECONNRESET")),
            { recordingFails: true }
        );
        expect(result).toEqual({ success: false, error: "db down" });
        expect(leftBehind).toBe(false);
        expect(removeDownload).toHaveBeenCalledWith(download);
    });

    it("with a failure when the file cannot be opened at all, and drops and closes the download", async () => {
        jest.spyOn(fs, "createWriteStream").mockImplementation(() => {
            throw new Error("EMFILE: too many open files");
        });
        const { result, download, removeDownload } = await runEarly("no-file", () => {});
        expect(result).toEqual({ success: false, error: "EMFILE: too many open files" });
        expect(removeDownload).toHaveBeenCalledWith(download);
        expect(download.stream.destroyed).toBe(true);
    });
});

describe("a finished download's size", () => {
    it("must equal what was transferred, else it fails and the file is removed", async () => {
        // the peer's count says 12 bytes arrived; 10 are on disk
        const { result, leftBehind } = await runEarly("short-file", (d) => {
            sendWholeFile(d);
            d.receivedBytes = 12n;
        });
        expect(result).toEqual({ success: false, error: expect.stringMatching(/10 bytes.*12/) });
        expect(leftBehind).toBe(false);
    });
});

it("does not cool the peer down when the timeout comes after the peer sent everything", async () => {
    // the peer's last byte is in and the stream ended; only the file is slow to finish
    const { result, markUserFailed, cooledDown } = await runEarly("slow-flush", (d) => d.stream.end(), { timeout: 1 });
    expect(result).toEqual({ success: false, error: "Download timed out" });
    expect(markUserFailed).not.toHaveBeenCalled();
    expect(cooledDown).toBe(false);
});

describe("a disk that is full or read-only", () => {
    /** The file system refuses the write with `code`, as it does when the disk is full. */
    function failWritesWith(code: string) {
        const real = fs.createWriteStream.bind(fs);
        jest.spyOn(fs, "createWriteStream").mockImplementation(((...args: Parameters<typeof fs.createWriteStream>) => {
            const file = real(...args);
            queueMicrotask(() => file.destroy(Object.assign(new Error(`${code}: write failed`), { code })));
            return file;
        }) as typeof fs.createWriteStream);
    }

    it.each(["ENOSPC", "EROFS", "EDQUOT"])("%s marks the failure as the disk's, with its error", async (code) => {
        failWritesWith(code);
        const { result, markUserFailed } = await runEarly(`disk-${code}`, () => {});
        expect(result).toEqual({ success: false, error: `Write error: ${code}: write failed`, diskFault: true });
        expect(markUserFailed).not.toHaveBeenCalled();
    });

    it("a refused folder is not a disk fault", async () => {
        const { result } = await runEarly("not-disk", () => {}, { folderAtDest: true });
        expect(result.diskFault).toBeUndefined();
    });

    const match = (username: string) => ({ username, filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 });
    const diskFull = { success: false, error: "Write error: ENOSPC: write failed", diskFault: true };

    it("stops downloadBestMatch at the first one and reports the disk error", async () => {
        const service = soulseekService as any;
        const track = jest.spyOn(service, "downloadTrack").mockResolvedValue(diskFull);
        const result = await service.downloadBestMatch("artist", "title", "album", [match("a"), match("b"), match("c")], dir);
        expect(track).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/disk.*ENOSPC/i);
    });

    it("stops the retry loop at the first one and reports the disk error", async () => {
        const service = soulseekService as any;
        const track = jest.spyOn(service, "downloadTrack").mockResolvedValue(diskFull);
        const result = await service.downloadWithRetry("artist", "title", "album", [match("a"), match("b"), match("c")], dir);
        expect(track).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/disk.*ENOSPC/i);
    });

    it("still tries the next peer after an ordinary failure", async () => {
        const service = soulseekService as any;
        const track = jest
            .spyOn(service, "downloadTrack")
            .mockResolvedValueOnce({ success: false, error: "read ECONNRESET" })
            .mockResolvedValueOnce({ success: true });
        const result = await service.downloadBestMatch("artist", "title", "album", [match("a"), match("b")], dir);
        expect(track).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true);
    });
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

describe("a download is written beside its destination and moved in once whole", () => {
    it("writes to a .part file of its own, then leaves only the finished file", async () => {
        const created: string[] = [];
        const real = fs.createWriteStream.bind(fs);
        jest.spyOn(fs, "createWriteStream").mockImplementation(((p: any, ...rest: any[]) => {
            created.push(String(p));
            return (real as any)(p, ...rest);
        }) as typeof fs.createWriteStream);
        const { result, dest, partLeft } = await runEarly("part-ok", sendWholeFile);
        expect(result).toEqual({ success: true });
        expect(created).toHaveLength(1);
        expect(path.dirname(created[0])).toBe(path.dirname(dest));
        expect(path.basename(created[0])).toMatch(HIDDEN_PART);
        expect(fs.statSync(dest).size).toBe(10);
        expect(partLeft).toBe(false);
    });

    it("gives each try its own name, so two downloads to one destination never share a partial file", async () => {
        const created: string[] = [];
        const real = fs.createWriteStream.bind(fs);
        jest.spyOn(fs, "createWriteStream").mockImplementation(((p: any, ...rest: any[]) => {
            created.push(String(p));
            return (real as any)(p, ...rest);
        }) as typeof fs.createWriteStream);
        await runEarly("part-twice", sendWholeFile);
        await runEarly("part-twice", sendWholeFile);
        expect(created).toHaveLength(2);
        expect(created[0]).not.toBe(created[1]);
    });

    it("replaces a file already at the destination when the new one is whole", async () => {
        const { result, dest } = await runEarly("part-replace", sendWholeFile, { existing: "old" });
        expect(result).toEqual({ success: true });
        expect(fs.statSync(dest).size).toBe(10);
    });

    it.each([
        ["timeout", () => {}, { timeout: 1 }],
        ["stream-error", (d: DownloadWithToken) => d.stream.destroy(new Error("read ECONNRESET")), {}],
        [
            "size-mismatch",
            (d: DownloadWithToken) => {
                sendWholeFile(d);
                d.receivedBytes = 12n;
            },
            {},
        ],
    ])("never touches a good file already at the destination when the try fails (%s)", async (label, onPipe, options) => {
        const { result, dest, partLeft } = await runEarly(`part-keep-${label}`, onPipe, {
            ...options,
            existing: "old",
        });
        expect(result.success).toBe(false);
        expect(fs.readFileSync(dest, "utf8")).toBe("old");
        expect(partLeft).toBe(false);
    });

    it("fails, and leaves the destination alone, when the finished file cannot be moved in", async () => {
        // a folder where the file belongs: nothing can be renamed over it
        const service = soulseekService as any;
        const dest = path.join(dir, "part-blocked.flac");
        fs.mkdirSync(dest);
        expectLog("error");
        const download = makeDownload();
        const pipe = download.stream.pipe.bind(download.stream);
        (download.stream as any).pipe = (to: any) => {
            const piped = pipe(to);
            queueMicrotask(() => sendWholeFile(download));
            return piped;
        };
        service.client = { download: async () => download, removeDownload: jest.fn() };
        jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
        const markUserFailed = jest.spyOn(service, "markUserFailed").mockResolvedValue(undefined);
        const result = await service.downloadTrack(
            { username: "part-blocked", filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 },
            dest,
        );
        expect(result.success).toBe(false);
        expect(fs.statSync(dest).isDirectory()).toBe(true);
        expect(partsBeside(dest)).toEqual([]);
        // this machine's folder is in the way, not the peer's fault
        expect(markUserFailed).not.toHaveBeenCalled();
    });
});

describe("a finished file that cannot be moved in because of this machine", () => {
    it.each(["ENOSPC", "EROFS", "EDQUOT"])("%s is a disk fault and leaves no .part", async (code) => {
        jest.spyOn(fs.promises, "rename").mockRejectedValue(
            Object.assign(new Error(`${code}: no room`), { code }),
        );
        expectLog("error");
        const { result, partLeft, markUserFailed } = await runEarly(`rename-${code}`, sendWholeFile);
        expect(result).toEqual({
            success: false,
            error: `Cannot move the download into place: ${code}: no room`,
            diskFault: true,
        });
        expect(partLeft).toBe(false);
        expect(markUserFailed).not.toHaveBeenCalled();
    });
});

describe("a name too long for the file system", () => {
    it("is this machine's fault: the peer is not cooled down", async () => {
        jest.spyOn(fs, "createWriteStream").mockImplementation(() => {
            throw Object.assign(new Error("ENAMETOOLONG: name too long"), { code: "ENAMETOOLONG" });
        });
        const { result, markUserFailed, cooledDown } = await runEarly("toolong", () => {});
        expect(result.success).toBe(false);
        expect(markUserFailed).not.toHaveBeenCalled();
        expect(cooledDown).toBe(false);
    });
});

describe("the active download count", () => {
    const active = () => (soulseekService as any).activeDownloads as number;
    const match = { username: "cooling", filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 };

    it("is released exactly once when the download finishes and the work after it throws", async () => {
        const start = active();
        jest.spyOn(soulseekDownloadsTotal, "inc").mockImplementation(() => {
            throw new Error("metrics down");
        });
        await runEarly("count-metrics", sendWholeFile);
        expect(active()).toBe(start);
    });

    it("is released exactly once for a timeout", async () => {
        const start = active();
        await runEarly("count-timeout", () => {}, { timeout: 1 });
        expect(active()).toBe(start);
    });

    it("is released exactly once for a peer in cooldown", async () => {
        const start = active();
        const service = soulseekService as any;
        service.client = { download: jest.fn(), removeDownload: jest.fn() };
        jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
        service.userConnectionCooldowns.set("cooling", Date.now() + 60_000);
        expect(await service.downloadTrack(match, path.join(dir, "cool.flac"))).toEqual({
            success: false,
            error: "User in cooldown",
        });
        expect(active()).toBe(start);
    });

    it("is released exactly once for a folder that cannot be made", async () => {
        const start = active();
        const service = soulseekService as any;
        service.client = { download: jest.fn(), removeDownload: jest.fn() };
        jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
        jest.spyOn(fs.promises, "mkdir").mockRejectedValue(Object.assign(new Error("EACCES: nope"), { code: "EACCES" }));
        expectLog("error");
        const result = await service.downloadTrack({ ...match, username: "other" }, path.join(dir, "x", "y.flac"));
        expect(result.success).toBe(false);
        expect(active()).toBe(start);
    });
});

describe("the peer is cooled down before the failure is written to the database", () => {
    it("so a database that fails still leaves the peer cooled down", async () => {
        const { cooledDown } = await runEarly("cool-first", (d) => d.stream.destroy(new Error("read ECONNRESET")), {
            recordingFails: true,
        });
        expect(cooledDown).toBe(true);
    });
});

describe("a fault on this machine while setting a download up", () => {
    it.each(["EMFILE", "ENFILE", "EACCES"])("%s does not cool the peer down", async (code) => {
        jest.spyOn(fs, "createWriteStream").mockImplementation(() => {
            throw Object.assign(new Error(`${code}: local fault`), { code });
        });
        const { result, markUserFailed, cooledDown } = await runEarly(`setup-${code}`, () => {});
        expect(result).toEqual({ success: false, error: `${code}: local fault` });
        expect(markUserFailed).not.toHaveBeenCalled();
        expect(cooledDown).toBe(false);
    });

    it("an unknown setup error still cools the peer down", async () => {
        jest.spyOn(fs, "createWriteStream").mockImplementation(() => {
            throw new Error("something odd");
        });
        const { cooledDown } = await runEarly("setup-odd", () => {});
        expect(cooledDown).toBe(true);
    });

    it.each(["ENOSPC", "EROFS", "EDQUOT"])("%s is a disk fault", async (code) => {
        jest.spyOn(fs, "createWriteStream").mockImplementation(() => {
            throw Object.assign(new Error(`${code}: local fault`), { code });
        });
        const { result } = await runEarly(`setup-disk-${code}`, () => {});
        expect(result).toEqual({ success: false, error: `${code}: local fault`, diskFault: true });
    });
});

describe("a destination folder that cannot be made", () => {
    const match = { username: "mk", filename: "a.flac", fullPath: "a.flac", size: 10, quality: "flac", score: 10 };

    function refuseFolder(code: string, message: string) {
        const service = soulseekService as any;
        service.client = { download: jest.fn(), removeDownload: jest.fn() };
        jest.spyOn(service, "ensureConnected").mockResolvedValue(undefined);
        jest.spyOn(fs.promises, "mkdir").mockRejectedValue(Object.assign(new Error(message), { code }));
        expectLog("error");
        return service.downloadTrack(match, path.join(dir, "nofolder", "a.flac"));
    }

    it.each(["ENOSPC", "EROFS", "EDQUOT"])("%s is a disk fault", async (code) => {
        expect(await refuseFolder(code, `${code}: no room`)).toEqual({
            success: false,
            error: `Cannot create destination directory: ${code}: no room`,
            diskFault: true,
        });
    });

    it("another failure to make it is not a disk fault", async () => {
        const result = await refuseFolder("EACCES", "EACCES: no");
        expect(result.diskFault).toBeUndefined();
    });
});

describe("an album search on a full disk", () => {
    const file = (user: string, n: number) => ({
        filename: `${user}\\album\\${String(n).padStart(2, "0")} - song ${n}.flac`,
        size: 10n,
        attrs: new Map(),
    });
    const responses = ["u1", "u2"].map((user) => ({
        username: user,
        slotsFree: true,
        files: [1, 2, 3, 4, 5].map((n) => file(user, n)),
    }));
    const tracks = [1, 2, 3, 4, 5].map((n) => ({ title: `song ${n}`, position: n }));

    it("stops at the first disk fault: no more tracks, no other group, no per-track fallback", async () => {
        const service = soulseekService as any;
        // the test double starts everything at once; the real queue starts the rest as earlier ones end
        let chain: Promise<unknown> = Promise.resolve();
        jest.spyOn(PQueue.prototype, "add").mockImplementation(((fn: () => Promise<unknown>) => {
            const run = chain.then(fn);
            chain = run.then(() => undefined, () => undefined);
            return run;
        }) as any);
        jest.spyOn(service, "rateLimitedSearch").mockResolvedValue(responses);
        jest.spyOn(service, "isUserBlocked").mockResolvedValue(false);
        const track = jest
            .spyOn(service, "downloadTrack")
            .mockResolvedValue({ success: false, error: "Write error: ENOSPC: write failed", diskFault: true });
        const batch = jest
            .spyOn(service, "searchAndDownloadBatch")
            .mockResolvedValue({ successful: 0, failed: 0, files: [], errors: [] });
        const result = await service.searchAndDownloadAlbum("artist", "album", tracks, dir);
        const users = new Set(track.mock.calls.map((c: any[]) => c[0].username));
        expect(users.size).toBe(1);
        expect(track).toHaveBeenCalledTimes(1);
        expect(batch).not.toHaveBeenCalled();
        expect(result.successful).toBe(0);
        expect(result.failed).toBe(5);
        expect(result.errors.join(" ")).toMatch(/disk.*ENOSPC/i);
    });
});

describe("stale partial files under the downloads folder", () => {
    const service = () => soulseekService as any;
    const hoursAgo = (file: string, hours: number) => {
        const when = new Date(Date.now() - hours * 3600_000);
        fs.utimesSync(file, when, when);
    };

    // Each test sweeps a music folder of its own: a folder is swept once an hour, so a shared one would be skipped.
    const musicRoot = () => fs.mkdtempSync(path.join(dir, "music-"));
    const OLD_PART = ".11111111-1111-1111-1111-111111111111.part";

    function seed(root: string) {
        const album = path.join(root, "Singles", "Artist", "Album");
        fs.mkdirSync(album, { recursive: true });
        const old = path.join(album, OLD_PART);
        const fresh = path.join(album, ".22222222-2222-2222-2222-222222222222.part");
        const song = path.join(album, "c.flac");
        const oldSong = path.join(album, "d.flac");
        // files of someone else's that merely end in .part, one of them hidden too
        const foreign = path.join(album, "notes.part");
        const foreignHidden = path.join(album, ".notes.part");
        // the name earlier versions gave their partial files, beside the file's own name
        const legacy = path.join(album, "a.flac.44444444-4444-4444-4444-444444444444.part");
        for (const f of [old, fresh, song, oldSong, foreign, foreignHidden, legacy]) fs.writeFileSync(f, "x");
        for (const f of [old, oldSong, foreign, foreignHidden, legacy]) hoursAgo(f, 2);
        return { album, old, fresh, song, oldSong, foreign, foreignHidden, legacy };
    }

    it("removes the hidden partial files it wrote that are older than an hour, and nothing else", async () => {
        const root = musicRoot();
        const { old, fresh, song, oldSong, foreign, foreignHidden, legacy } = seed(root);
        await service().sweepStalePartFiles(root);
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(song)).toBe(true);
        expect(fs.existsSync(oldSong)).toBe(true);
        expect(fs.existsSync(foreign)).toBe(true);
        expect(fs.existsSync(foreignHidden)).toBe(true);
        expect(fs.existsSync(legacy)).toBe(true);
    });

    it("carries on when the folder is missing or cannot be read", async () => {
        await expect(service().sweepStalePartFiles(path.join(dir, "nowhere"))).resolves.toBeUndefined();
        const root = musicRoot();
        const { old } = seed(root);
        jest.spyOn(fs.promises, "readdir").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
        await expect(service().sweepStalePartFiles(root)).resolves.toBeUndefined();
        expect(fs.existsSync(old)).toBe(true);
    });

    it("carries on past a file that cannot be removed", async () => {
        const root = musicRoot();
        const { album, old } = seed(root);
        const second = path.join(album, ".33333333-3333-3333-3333-333333333333.part");
        fs.writeFileSync(second, "x");
        hoursAgo(second, 3);
        const rm = fs.promises.rm.bind(fs.promises);
        jest.spyOn(fs.promises, "rm").mockImplementation(((p: any, ...rest: any[]) =>
            String(p) === old ? Promise.reject(new Error("EBUSY")) : (rm as any)(p, ...rest)) as any);
        await service().sweepStalePartFiles(root);
        expect(fs.existsSync(old)).toBe(true);
        expect(fs.existsSync(second)).toBe(false);
    });

    it("walks a music folder at most once an hour", async () => {
        const root = musicRoot();
        const { album, old } = seed(root);
        await service().sweepStalePartFiles(root);
        expect(fs.existsSync(old)).toBe(false);

        // another stale file, and a second search (or the album's per-track fallback) an instant later
        const later = path.join(album, ".55555555-5555-5555-5555-555555555555.part");
        fs.writeFileSync(later, "x");
        hoursAgo(later, 2);
        await service().sweepStalePartFiles(root);
        expect(fs.existsSync(later)).toBe(true);

        // an hour on, it walks again
        const now = Date.now();
        jest.spyOn(Date, "now").mockReturnValue(now + 61 * 60_000);
        await service().sweepStalePartFiles(root);
        expect(fs.existsSync(later)).toBe(false);
    });

    it("lets each music folder be swept on its own", async () => {
        const [a, b] = [musicRoot(), musicRoot()];
        await service().sweepStalePartFiles(a);
        const { old } = seed(b);
        await service().sweepStalePartFiles(b);
        expect(fs.existsSync(old)).toBe(false);
    });

    it("runs when an album search starts", async () => {
        const sweep = jest.spyOn(service(), "sweepStalePartFiles").mockResolvedValue(undefined);
        jest.spyOn(service(), "rateLimitedSearch").mockResolvedValue([]);
        jest.spyOn(service(), "searchAndDownloadBatch").mockResolvedValue({ successful: 0, failed: 0, files: [], errors: [] });
        await service().searchAndDownloadAlbum("artist", "album", [{ title: "song", position: 1 }], dir);
        expect(sweep).toHaveBeenCalledWith(dir);
    });

    it("runs when a batch of tracks starts", async () => {
        const sweep = jest.spyOn(service(), "sweepStalePartFiles").mockResolvedValue(undefined);
        jest.spyOn(service(), "searchTrack").mockResolvedValue({ found: false, bestMatch: null, allMatches: [] });
        await service().searchAndDownloadBatch([{ artist: "a", title: "t", album: "b" }], dir);
        expect(sweep).toHaveBeenCalledWith(dir);
    });
});

describe("an album search and its abort listener", () => {
    it("takes the listener off the signal when each group ends", async () => {
        const service = soulseekService as any;
        const file = (n: number) => ({ filename: `u1\\album\\0${n} - song ${n}.flac`, size: 10n, attrs: new Map() });
        jest.spyOn(service, "sweepStalePartFiles").mockResolvedValue(undefined);
        jest.spyOn(service, "rateLimitedSearch").mockResolvedValue([
            { username: "u1", slotsFree: true, files: [1, 2].map(file) },
        ]);
        jest.spyOn(service, "isUserBlocked").mockResolvedValue(false);
        jest.spyOn(service, "downloadTrack").mockResolvedValue({ success: true });
        const signal = new AbortController().signal;
        const added: unknown[] = [];
        const removed: unknown[] = [];
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        jest.spyOn(signal, "addEventListener").mockImplementation(((t: string, fn: unknown, o?: unknown) => {
            if (t === "abort") added.push(fn);
            return (add as any)(t, fn, o);
        }) as any);
        jest.spyOn(signal, "removeEventListener").mockImplementation(((t: string, fn: unknown, o?: unknown) => {
            if (t === "abort") removed.push(fn);
            return (remove as any)(t, fn, o);
        }) as any);
        const result = await service.searchAndDownloadAlbum(
            "artist",
            "album",
            [1, 2].map((n) => ({ title: `song ${n}`, position: n })),
            dir,
            signal,
        );
        expect(result.successful).toBe(2);
        expect(added.length).toBeGreaterThan(0);
        for (const fn of added) expect(removed).toContain(fn);
    });
});

/** Adds an `abort` listener spy to `signal`, recording what is added and what is taken off. */
function watchAbortListeners(signal: AbortSignal) {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    jest.spyOn(signal, "addEventListener").mockImplementation(((t: string, fn: unknown, o?: unknown) => {
        if (t === "abort") added.push(fn);
        return (add as any)(t, fn, o);
    }) as any);
    jest.spyOn(signal, "removeEventListener").mockImplementation(((t: string, fn: unknown, o?: unknown) => {
        if (t === "abort") removed.push(fn);
        return (remove as any)(t, fn, o);
    }) as any);
    return { added, removed };
}

describe("an abort listener on a batch of tracks", () => {
    const service = () => soulseekService as any;

    it("is a named handler, and comes off the signal when the batch is done", async () => {
        jest.spyOn(service(), "sweepStalePartFiles").mockResolvedValue(undefined);
        jest.spyOn(service(), "searchTrack").mockResolvedValue({ found: false, bestMatch: null, allMatches: [] });
        const signal = new AbortController().signal;
        const { added, removed } = watchAbortListeners(signal);
        await service().searchAndDownloadBatch([{ artist: "a", title: "t", album: "b" }], dir, 2, signal);
        expect(added).toHaveLength(1);
        expect(removed).toEqual(added);
    });

    it("comes off the signal when the batch throws", async () => {
        jest.spyOn(service(), "sweepStalePartFiles").mockResolvedValue(undefined);
        jest.spyOn(PQueue.prototype, "add").mockImplementation(() => {
            throw new Error("queue broke");
        });
        const signal = new AbortController().signal;
        const { added, removed } = watchAbortListeners(signal);
        await expect(
            service().searchAndDownloadBatch([{ artist: "a", title: "t", album: "b" }], dir, 2, signal),
        ).rejects.toThrow("queue broke");
        expect(added).toHaveLength(1);
        expect(removed).toEqual(added);
    });
});

describe("an album search with groups to try", () => {
    const service = () => soulseekService as any;
    const file = (user: string, n: number, title: string) => ({
        filename: `${user}\\album\\0${n} - ${title}.flac`,
        size: 10n,
        attrs: new Map(),
    });
    const respond = (titles: string[]) =>
        ["u1", "u2"].map((user) => ({
            username: user,
            slotsFree: true,
            files: titles.map((t, i) => file(user, i + 1, t)),
        }));

    function setUp(titles: string[]) {
        jest.spyOn(service(), "sweepStalePartFiles").mockResolvedValue(undefined);
        jest.spyOn(service(), "rateLimitedSearch").mockResolvedValue(respond(titles));
        jest.spyOn(service(), "isUserBlocked").mockResolvedValue(false);
        // no fallback walk to the network
        jest.spyOn(service(), "searchAndDownloadBatch").mockResolvedValue({ successful: 0, failed: 0, files: [], errors: [] });
    }

    it("gives two songs of one title names of their own, so both land and each is listed once", async () => {
        setUp(["Intro", "Intro"]);
        const track = jest.spyOn(service(), "downloadTrack").mockResolvedValue({ success: true });
        const result = await service().searchAndDownloadAlbum(
            "artist",
            "album",
            [{ title: "Intro", position: 1 }, { title: "Intro", position: 2 }],
            dir,
        );
        const names = track.mock.calls.map((c: any[]) => path.basename(c[1]));
        expect(names.sort()).toEqual(["Intro (2).flac", "Intro.flac"]);
        expect(result.successful).toBe(2);
        expect(result.files.map((f: string) => path.basename(f)).sort()).toEqual(["Intro (2).flac", "Intro.flac"]);
        expect(new Set(result.files).size).toBe(2);
    });

    it("lets a name go when its download fails, so the next group's try takes the same name", async () => {
        setUp(["Intro", "Intro"]);
        const track = jest
            .spyOn(service(), "downloadTrack")
            .mockImplementation((async (match: any) =>
                match.username === "u1" ? { success: false, error: "peer went away" } : { success: true }) as any);
        const result = await service().searchAndDownloadAlbum(
            "artist",
            "album",
            [{ title: "Intro", position: 1 }, { title: "Intro", position: 2 }],
            dir,
        );
        const names = new Set(track.mock.calls.map((c: any[]) => path.basename(c[1])));
        expect([...names].sort()).toEqual(["Intro (2).flac", "Intro.flac"]);
        expect(result.successful).toBe(2);
        expect(result.files.map((f: string) => path.basename(f)).sort()).toEqual(["Intro (2).flac", "Intro.flac"]);
    });

    it("takes the group's listener off the signal when the group throws", async () => {
        setUp(["one", "two"]);
        jest.spyOn(PQueue.prototype, "add").mockImplementation(() => {
            throw new Error("queue broke");
        });
        const signal = new AbortController().signal;
        const { added, removed } = watchAbortListeners(signal);
        await expect(
            service().searchAndDownloadAlbum(
                "artist",
                "album",
                [{ title: "one", position: 1 }, { title: "two", position: 2 }],
                dir,
                signal,
            ),
        ).rejects.toThrow("queue broke");
        expect(added.length).toBeGreaterThan(0);
        for (const fn of added) expect(removed).toContain(fn);
    });

    it("tries no further group once the search is aborted", async () => {
        setUp(["one", "two"]);
        const controller = new AbortController();
        const add = jest.spyOn(PQueue.prototype, "add");
        jest.spyOn(service(), "downloadTrack").mockImplementation((async () => {
            controller.abort();
            return { success: false, error: "peer went away" };
        }) as any);
        await service().searchAndDownloadAlbum(
            "artist",
            "album",
            [{ title: "one", position: 1 }, { title: "two", position: 2 }],
            dir,
            controller.signal,
        );
        // the first group's two tracks were queued; the second group never was
        expect(add).toHaveBeenCalledTimes(2);
    });
});

describe("a finished file that is not on disk", () => {
    it("is 'File not written' when the file system says it is not there", async () => {
        const stat = fs.promises.stat.bind(fs.promises);
        jest.spyOn(fs.promises, "stat").mockImplementation(((p: any, ...rest: any[]) =>
            HIDDEN_PART.test(path.basename(String(p)))
                ? Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))
                : (stat as any)(p, ...rest)) as any);
        const { result, dest } = await runEarly("stat-enoent", sendWholeFile);
        expect(result).toEqual({ success: false, error: "File not written" });
        // the file the mocked answer hid is really there: take it away
        for (const n of partsBeside(dest)) fs.rmSync(path.join(path.dirname(dest), n), { force: true });
    });

    it("does not block the event loop while it is checked", async () => {
        const statSync = jest.spyOn(fs, "statSync");
        const existsSync = jest.spyOn(fs, "existsSync");
        const { result } = await runEarly("stat-async", sendWholeFile);
        expect(result).toEqual({ success: true });
        const partChecks = (spy: jest.SpyInstance) => spy.mock.calls.filter((c) => HIDDEN_PART.test(path.basename(String(c[0]))));
        expect(partChecks(statSync)).toHaveLength(0);
        expect(partChecks(existsSync)).toHaveLength(0);
    });
});

describe("a partial file that cannot be removed", () => {
    it("is logged at debug, and the failure is still reported", async () => {
        const rm = fs.promises.rm.bind(fs.promises);
        jest.spyOn(fs.promises, "rm").mockImplementation(((p: any, ...rest: any[]) =>
            HIDDEN_PART.test(path.basename(String(p))) ? Promise.reject(new Error("EBUSY: file busy")) : (rm as any)(p, ...rest)) as any);
        const debug = jest.spyOn(logger, "debug");
        const { result } = await runEarly("rm-fails", (d) => d.events.emit("error", new Error("peer went away")));
        expect(result).toEqual({ success: false, error: "peer went away" });
        expect(debug.mock.calls.some((c) => /EBUSY: file busy/.test(String(c[0])))).toBe(true);
        // the file that could not be removed is left for the sweep
        for (const n of fs.readdirSync(dir).filter((n) => HIDDEN_PART.test(n))) fs.rmSync(path.join(dir, n), { force: true });
    });
});
