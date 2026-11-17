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
import PQueue from "p-queue";
import { soulseekDownloadsTotal } from "../../utils/metrics";

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
    if (options.folderAtDest) fs.mkdirSync(`${dest}.part`);
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
        leftBehind: fs.existsSync(dest) || (fs.existsSync(`${dest}.part`) && !options.folderAtDest),
        partLeft: fs.existsSync(`${dest}.part`) && !options.folderAtDest,
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
    it("writes to a .part file, then leaves only the finished file", async () => {
        const created: string[] = [];
        const real = fs.createWriteStream.bind(fs);
        jest.spyOn(fs, "createWriteStream").mockImplementation(((p: any, ...rest: any[]) => {
            created.push(String(p));
            return (real as any)(p, ...rest);
        }) as typeof fs.createWriteStream);
        const { result, dest, partLeft } = await runEarly("part-ok", sendWholeFile);
        expect(result).toEqual({ success: true });
        expect(created).toEqual([`${dest}.part`]);
        expect(fs.statSync(dest).size).toBe(10);
        expect(partLeft).toBe(false);
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
        expect(fs.existsSync(`${dest}.part`)).toBe(false);
        // this machine's folder is in the way, not the peer's fault
        expect(markUserFailed).not.toHaveBeenCalled();
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
