import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter, PassThrough } from "stream";
import { parseRangeHeader } from "../../utils/rangeParser";
import { AudioStreamingService } from "../audioStreaming";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock("../../utils/db", () => ({
    prisma: {
        transcodedFile: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            upsert: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
    },
}));

jest.mock("music-metadata");

const mockSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({ getSystemSettings: async () => mockSettings() }));

// fluent-ffmpeg mock factory -- each test replaces this to control behavior
let ffmpegCommandFactory: (() => FakeCommand) | null = null;

class FakeCommand extends EventEmitter {
    audioBitrate() { return this; }
    audioCodec() { return this; }
    format() { return this; }
    save(_p: string) { return this; }
    kill(_sig: string) { this.emit("error", new Error("Killed: " + _sig)); }
}

jest.mock("fluent-ffmpeg", () => {
    const mock = jest.fn((_src: string) => {
        return ffmpegCommandFactory ? ffmpegCommandFactory() : new FakeCommand();
    });
    (mock as any).setFfmpegPath = jest.fn();
    return mock;
});

jest.mock("@ffmpeg-installer/ffmpeg", () => ({ path: "/fake/ffmpeg" }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { prisma } from "../../utils/db";

const mockPrisma = prisma.transcodedFile as jest.Mocked<typeof prisma.transcodedFile>;

function makeTmpFile(dir: string, content: string = "audio data"): string {
    const p = path.join(dir, `file-${Math.random().toString(36).slice(2)}.mp3`);
    fs.writeFileSync(p, content);
    return p;
}

function makeReq(headers: Record<string, string> = {}) {
    return { headers } as any;
}

/**
 * Build a mock Express response that IS a proper Writable stream (PassThrough),
 * so that fs.createReadStream(...).pipe(res) works in tests.
 * Express-specific API (status/set/end) is layered on top.
 */
function makeRes() {
    const through = new PassThrough({ autoDestroy: false });
    const state = {
        status: 200,
        ended: false,
        headers: {} as Record<string, string>,
        headersSent: false,
    };

    (through as any).status = function(code: number) {
        state.status = code;
        return this;
    };
    (through as any).set = function(h: Record<string, string>) {
        Object.assign(state.headers, h);
        return this;
    };

    const origEnd = through.end.bind(through);
    (through as any).end = function(...args: any[]) {
        state.ended = true;
        origEnd(...args);
        return this;
    };

    Object.defineProperty(through, "_status", {
        get: () => state.status,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(through, "_ended", {
        get: () => state.ended,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(through, "_headers", {
        get: () => state.headers,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(through, "headersSent", {
        get: () => state.headersSent,
        set: (v: boolean) => { state.headersSent = v; },
        enumerable: true,
        configurable: true,
    });

    return through as any;
}

/**
 * A minimal PQueue-compatible class that enforces real concurrency limits.
 */
class RealConcurrencyQueue {
    private concurrency: number;
    private running = 0;
    private queue: Array<() => void> = [];

    constructor(opts: { concurrency: number }) {
        this.concurrency = opts.concurrency;
    }

    add<T>(fn: () => Promise<T>, _opts?: any): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const run = () => {
                this.running++;
                Promise.resolve().then(() => fn()).then(
                    (v) => { this.running--; this.dequeue(); resolve(v); },
                    (e) => { this.running--; this.dequeue(); reject(e); }
                );
            };
            if (this.running < this.concurrency) {
                run();
            } else {
                this.queue.push(run);
            }
        });
    }

    private dequeue() {
        if (this.queue.length > 0 && this.running < this.concurrency) {
            const next = this.queue.shift()!;
            next();
        }
    }
}

// ---------------------------------------------------------------------------
// parseRangeHeader -- updated for reason field
// ---------------------------------------------------------------------------

const FILE_SIZE = 10000;

describe("parseRangeHeader", () => {
    describe("standard ranges", () => {
        it("parses bytes=0-499", () => {
            expect(parseRangeHeader("bytes=0-499", FILE_SIZE)).toEqual({ ok: true, start: 0, end: 499 });
        });

        it("parses bytes=9000-9999", () => {
            expect(parseRangeHeader("bytes=9000-9999", FILE_SIZE)).toEqual({ ok: true, start: 9000, end: 9999 });
        });
    });

    describe("open-ended ranges", () => {
        it("parses bytes=500- as 500 to end", () => {
            expect(parseRangeHeader("bytes=500-", FILE_SIZE)).toEqual({ ok: true, start: 500, end: 9999 });
        });

        it("parses bytes=0- as entire file", () => {
            expect(parseRangeHeader("bytes=0-", FILE_SIZE)).toEqual({ ok: true, start: 0, end: 9999 });
        });
    });

    describe("suffix ranges (Firefox/Safari metadata probing)", () => {
        it("parses bytes=-500 as last 500 bytes", () => {
            expect(parseRangeHeader("bytes=-500", FILE_SIZE)).toEqual({ ok: true, start: 9500, end: 9999 });
        });

        it("clamps suffix larger than file to start=0", () => {
            expect(parseRangeHeader("bytes=-12345", FILE_SIZE)).toEqual({ ok: true, start: 0, end: 9999 });
        });

        it("handles suffix equal to file size", () => {
            expect(parseRangeHeader("bytes=-10000", FILE_SIZE)).toEqual({ ok: true, start: 0, end: 9999 });
        });
    });

    describe("zero suffix rejection", () => {
        it("rejects bytes=-0 with 416 unsatisfiable", () => {
            expect(parseRangeHeader("bytes=-0", FILE_SIZE)).toEqual({ ok: false, status: 416, reason: "unsatisfiable" });
        });
    });

    describe("RFC 7233 end clamping", () => {
        it("clamps end beyond file size to fileSize-1", () => {
            expect(parseRangeHeader("bytes=0-99999", FILE_SIZE)).toEqual({ ok: true, start: 0, end: 9999 });
        });

        it("clamps end beyond file size with non-zero start", () => {
            expect(parseRangeHeader("bytes=5000-50000", FILE_SIZE)).toEqual({ ok: true, start: 5000, end: 9999 });
        });
    });

    describe("invalid ranges", () => {
        it("rejects start >= fileSize", () => {
            expect(parseRangeHeader("bytes=10000-10500", FILE_SIZE)).toEqual({ ok: false, status: 416, reason: "unsatisfiable" });
        });

        it("rejects start beyond fileSize", () => {
            expect(parseRangeHeader("bytes=20000-", FILE_SIZE)).toEqual({ ok: false, status: 416, reason: "unsatisfiable" });
        });

        it("rejects NaN start", () => {
            expect(parseRangeHeader("bytes=abc-500", FILE_SIZE)).toEqual({ ok: false, status: 416, reason: "unsatisfiable" });
        });

        it("rejects start > end (after clamping)", () => {
            expect(parseRangeHeader("bytes=600-400", FILE_SIZE)).toEqual({ ok: false, status: 416, reason: "unsatisfiable" });
        });
    });

    describe("multi-range", () => {
        it("returns reason multi for bytes=0-99,200-299", () => {
            expect(parseRangeHeader("bytes=0-99,200-299", FILE_SIZE)).toEqual({ ok: false, status: 200, reason: "multi" });
        });
    });

    describe("edge cases", () => {
        it("handles single-byte file", () => {
            expect(parseRangeHeader("bytes=0-0", 1)).toEqual({ ok: true, start: 0, end: 0 });
        });

        it("handles suffix on single-byte file", () => {
            expect(parseRangeHeader("bytes=-1", 1)).toEqual({ ok: true, start: 0, end: 0 });
        });

        it("handles last byte of file", () => {
            expect(parseRangeHeader("bytes=9999-9999", FILE_SIZE)).toEqual({ ok: true, start: 9999, end: 9999 });
        });
    });
});

// ---------------------------------------------------------------------------
// streamFileWithRangeSupport -- range matrix
// ---------------------------------------------------------------------------

describe("getStreamFilePath for a file that is gone", () => {
    it.each(["original", "low"] as const)("says so at %s quality, the same way each time", async (quality) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gone-source-"));
        const svc = new AudioStreamingService(dir, 10);
        try {
            await expect(
                svc.getStreamFilePath("t1", quality, new Date(), path.join(dir, "nothing.flac")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            svc.destroy();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("streamFileWithRangeSupport for a file that is gone", () => {
    it("answers not available, and a real failure stays a server error", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gone-range-"));
        const svc = new AudioStreamingService(dir, 10);
        const answer = () => {
            const res: any = { headersSent: false, statusCode: 0, body: undefined };
            res.status = (code: number) => ((res.statusCode = code), res);
            res.json = (body: unknown) => ((res.body = body), res);
            res.end = () => res;
            return res;
        };
        try {
            const gone = answer();
            await svc.streamFileWithRangeSupport({ headers: {} } as any, gone, path.join(dir, "nothing.flac"), "audio/flac");
            expect(gone.statusCode).toBe(404);
            expect(gone.body).toEqual({ error: "Track not available" });

            const empty = answer();
            const emptyFile = path.join(dir, "empty.flac");
            fs.writeFileSync(emptyFile, "");
            await svc.streamFileWithRangeSupport({ headers: {} } as any, empty, emptyFile, "audio/flac");
            expect(empty.statusCode).toBe(404);

            const denied = answer();
            jest.spyOn(fs.promises, "stat").mockRejectedValueOnce(Object.assign(new Error("no"), { code: "EACCES" }));
            await svc.streamFileWithRangeSupport({ headers: {} } as any, denied, path.join(dir, "locked.flac"), "audio/flac");
            expect(denied.statusCode).toBe(500);
        } finally {
            jest.restoreAllMocks();
            svc.destroy();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("streamFileWithRangeSupport range matrix", () => {
    let tmpDir: string;
    let svc: AudioStreamingService;
    let filePath: string;
    const CONTENT_SIZE = 1000;
    const content = "A".repeat(CONTENT_SIZE);

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-range-"));
        svc = new AudioStreamingService(tmpDir, 10);
        filePath = path.join(tmpDir, "test.mp3");
        fs.writeFileSync(filePath, content);
    });

    afterAll(() => {
        svc.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("suffix range bytes=-100 -> 206 with last 100 bytes", async () => {
        const req = makeReq({ range: "bytes=-100" });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(206);
        expect(res._headers["Content-Range"]).toBe(`bytes 900-999/${CONTENT_SIZE}`);
        expect(res._headers["Content-Length"]).toBe("100");
    });

    it("open-ended range bytes=500- -> 206 from offset 500", async () => {
        const req = makeReq({ range: "bytes=500-" });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(206);
        expect(res._headers["Content-Range"]).toBe(`bytes 500-999/${CONTENT_SIZE}`);
        expect(res._headers["Content-Length"]).toBe("500");
    });

    it("out-of-range bytes=9999- -> 416 with Content-Range: bytes */fileSize", async () => {
        const req = makeReq({ range: "bytes=9999-" });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(416);
        expect(res._headers["Content-Range"]).toBe(`bytes */${CONTENT_SIZE}`);
        expect(res._ended).toBe(true);
    });

    it("multi-range bytes=0-99,200-299 -> 200 full file (RFC 9110: ignore multi-range)", async () => {
        const req = makeReq({ range: "bytes=0-99,200-299" });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(200);
        expect(res._headers["Content-Length"]).toBe(String(CONTENT_SIZE));
        expect(res._headers["Content-Range"]).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// streamFileWithRangeSupport -- conditional requests
// ---------------------------------------------------------------------------

describe("streamFileWithRangeSupport conditional requests", () => {
    let tmpDir: string;
    let svc: AudioStreamingService;
    let filePath: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-cond-"));
        svc = new AudioStreamingService(tmpDir, 10);
        filePath = path.join(tmpDir, "song.mp3");
        fs.writeFileSync(filePath, "X".repeat(500));
    });

    afterAll(() => {
        svc.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function computeEtag(): string {
        const s = fs.statSync(filePath);
        return `"${s.ino}-${s.size}-${s.mtimeMs}"`;
    }

    it("If-None-Match matching ETag -> 304 no body", async () => {
        const etag = computeEtag();
        const req = makeReq({ "if-none-match": etag });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(304);
        expect(res._ended).toBe(true);
        expect(res._headers["ETag"]).toBe(etag);
        expect(res._headers["Cache-Control"]).toBe("private, max-age=3600, must-revalidate");
    });

    it("If-None-Match not matching -> 200 with bytes", async () => {
        const req = makeReq({ "if-none-match": '"stale-etag"' });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(200);
    });

    it("If-None-Match with Range header still returns 304 (RFC 9110: conditionals before Range)", async () => {
        const etag = computeEtag();
        const req = makeReq({ "if-none-match": etag, range: "bytes=0-99" });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(304);
        expect(res._ended).toBe(true);
    });

    it("If-Modified-Since >= mtime -> 304", async () => {
        const s = fs.statSync(filePath);
        const future = new Date(s.mtime.getTime() + 1000).toUTCString();
        const req = makeReq({ "if-modified-since": future });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(304);
        expect(res._ended).toBe(true);
    });

    it("If-Modified-Since < mtime -> 200", async () => {
        const s = fs.statSync(filePath);
        const past = new Date(s.mtime.getTime() - 5000).toUTCString();
        const req = makeReq({ "if-modified-since": past });
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._status).toBe(200);
    });

    it("Cache-Control is private, max-age=3600, must-revalidate on 200 response", async () => {
        const req = makeReq({});
        const res = makeRes();
        await svc.streamFileWithRangeSupport(req, res, filePath, "audio/mpeg");
        expect(res._headers["Cache-Control"]).toBe("private, max-age=3600, must-revalidate");
    });
});

// ---------------------------------------------------------------------------
// getCachedTranscode freshness -- mtime equality + size
// ---------------------------------------------------------------------------

describe("getCachedTranscode freshness", () => {
    let tmpDir: string;
    let svc: AudioStreamingService;
    let sourcePath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-fresh-"));
        svc = new AudioStreamingService(tmpDir, 10);
        sourcePath = path.join(tmpDir, "source.flac");
        fs.writeFileSync(sourcePath, "Z".repeat(2000));
        jest.clearAllMocks();
    });

    afterEach(() => {
        svc.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function cachedRow(id: string, overrides: Record<string, unknown>) {
        const sourceStat = fs.statSync(sourcePath);
        return {
            id,
            cachePath: `${id}.mp3`,
            sourceModified: sourceStat.mtime,
            sourceSize: BigInt(sourceStat.size),
            cacheSize: BigInt(8),
            quality: "high",
            trackId: "t1",
            lastAccessed: new Date(),
            createdAt: new Date(),
            ...overrides,
        } as any;
    }

    async function lookup(row: ReturnType<typeof cachedRow>) {
        fs.writeFileSync(path.join(tmpDir, row.cachePath), "mp3 data");
        mockPrisma.findFirst.mockResolvedValue(row);
        mockPrisma.update.mockResolvedValue({} as any);
        mockPrisma.delete.mockResolvedValue({} as any);
        return (svc as any).getCachedTranscode(
            "t1", "high", fs.statSync(sourcePath).mtime, sourcePath
        );
    }

    it("same mtime + same size -> cache hit (does not delete)", async () => {
        const result = await lookup(cachedRow("row-1", {}));
        expect(result).toBe(path.join(tmpDir, "row-1.mp3"));
        expect(mockPrisma.delete).not.toHaveBeenCalled();
    });

    it("same mtime but different size -> cache miss and row deleted", async () => {
        const result = await lookup(
            cachedRow("row-2", { sourceSize: BigInt(fs.statSync(sourcePath).size + 999) })
        );
        expect(result).toBeNull();
        expect(mockPrisma.delete).toHaveBeenCalledWith({ where: { id: "row-2" } });
    });

    it("sourceSize 0 (legacy row) -> cache miss and row deleted", async () => {
        const result = await lookup(cachedRow("row-3", { sourceSize: 0n }));
        expect(result).toBeNull();
        expect(mockPrisma.delete).toHaveBeenCalledWith({ where: { id: "row-3" } });
    });

    it("different mtime -> cache miss and row deleted", async () => {
        const olderMtime = new Date(fs.statSync(sourcePath).mtime.getTime() - 10000);
        const result = await lookup(cachedRow("row-4", { sourceModified: olderMtime }));
        expect(result).toBeNull();
        expect(mockPrisma.delete).toHaveBeenCalledWith({ where: { id: "row-4" } });
    });
});

// ---------------------------------------------------------------------------
// transcodeToCache watchdog
// ---------------------------------------------------------------------------

describe("transcodeToCache watchdog", () => {
    let tmpDir: string;
    let svc: AudioStreamingService;

    beforeEach(() => {
        jest.useFakeTimers();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-wdog-"));
        svc = new AudioStreamingService(tmpDir, 10);
        jest.clearAllMocks();
        ffmpegCommandFactory = null;
    });

    afterEach(() => {
        svc.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        jest.useRealTimers();
        ffmpegCommandFactory = null;
    });

    it("rejects with TRANSCODE_FAILED after 120s when ffmpeg never ends", async () => {
        ffmpegCommandFactory = () => {
            const cmd = new FakeCommand();
            cmd.kill = jest.fn(); // suppress kill->error emission
            return cmd;
        };

        const sourcePath = makeTmpFile(tmpDir);
        const promise = (svc as any).transcodeToCache(
            "track-watchdog", "high", sourcePath, new Date()
        );

        jest.advanceTimersByTime(120_001);

        const { ErrorCode } = await import("../../utils/errors");
        await expect(promise).rejects.toMatchObject({
            code: ErrorCode.TRANSCODE_FAILED,
            message: expect.stringContaining("timed out"),
        });

        expect(mockPrisma.upsert).not.toHaveBeenCalled();
    });

    it("partial cache file is unlinked on watchdog timeout", async () => {
        ffmpegCommandFactory = () => {
            const cmd = new FakeCommand();
            cmd.kill = jest.fn();
            return cmd;
        };

        const sourcePath = makeTmpFile(tmpDir);
        const crypto = require("crypto");
        const hash = crypto.createHash("md5").update("track-partial-high").digest("hex");
        const cacheFilePath = path.join(tmpDir, `${hash}.mp3`);
        fs.writeFileSync(cacheFilePath, "partial data");

        const promise = (svc as any).transcodeToCache(
            "track-partial", "high", sourcePath, new Date()
        );

        jest.advanceTimersByTime(120_001);
        await expect(promise).rejects.toMatchObject({ message: expect.stringContaining("timed out") });

        expect(fs.existsSync(cacheFilePath)).toBe(false);
    });

    it("kill-induced error event after watchdog does not double-settle the promise", async () => {
        ffmpegCommandFactory = () => {
            const cmd = new FakeCommand();
            cmd.kill = jest.fn((_sig: string) => {
                // Emit error asynchronously as real ffmpeg would after SIGKILL
                Promise.resolve().then(() => {
                    cmd.emit("error", new Error("SIGKILL"));
                });
            });
            return cmd;
        };

        const sourcePath = makeTmpFile(tmpDir);
        const promise = (svc as any).transcodeToCache(
            "track-double", "high", sourcePath, new Date()
        );

        jest.advanceTimersByTime(120_001);

        // Flush microtask queue so the kill-induced error can fire
        await Promise.resolve();
        await Promise.resolve();

        const { ErrorCode } = await import("../../utils/errors");
        await expect(promise).rejects.toMatchObject({
            code: ErrorCode.TRANSCODE_FAILED,
            message: expect.stringContaining("timed out"),
        });
        expect(mockPrisma.upsert).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// transcodeQueue max concurrency
// ---------------------------------------------------------------------------

describe("transcodeQueue max concurrency", () => {
    let tmpDir: string;
    let svc: AudioStreamingService;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-conc-"));
        svc = new AudioStreamingService(tmpDir, 10);
        // Replace the CJS stub with a real concurrency-enforcing queue
        (svc as any).transcodeQueue = new RealConcurrencyQueue({ concurrency: 3 });
    });

    afterAll(() => {
        svc.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("10 parallel distinct-track transcode requests execute at most 3 concurrently", async () => {
        let active = 0;
        let maxObservedConcurrency = 0;

        jest.spyOn(svc as any, "transcodeToCache").mockImplementation(async () => {
            active++;
            maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
            active--;
            return path.join(tmpDir, "fake.mp3");
        });

        jest.spyOn(svc as any, "getCachedTranscode").mockResolvedValue(null);
        jest.spyOn(svc, "getCacheSize").mockResolvedValue(0);
        const { parseFile } = require("music-metadata");
        (parseFile as jest.Mock).mockResolvedValue({ format: { bitrate: null } });

        const promises = Array.from({ length: 10 }, (_, i) =>
            svc.getStreamFilePath(
                `track-c-${i}`,
                "high",
                new Date(),
                makeTmpFile(tmpDir, `src-${i}`)
            ).catch(() => {})
        );

        await Promise.all(promises);

        expect(maxObservedConcurrency).toBeLessThanOrEqual(3);
        expect(maxObservedConcurrency).toBeGreaterThan(0);

        jest.restoreAllMocks();
    });
});

// ---------------------------------------------------------------------------
// The web player's order (no Subsonic options): original as is; else a cached
// transcode before any look at the file; else the file itself when already
// within the tier; else a transcode.
// ---------------------------------------------------------------------------

describe("getStreamFilePath without options (the web player)", () => {
    let tmpDir: string;
    let svc: AudioStreamingService;
    const { parseFile } = require("music-metadata");

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-web-order-"));
        svc = new AudioStreamingService(tmpDir, 10);
        (parseFile as jest.Mock).mockReset();
    });

    afterEach(() => {
        svc.destroy();
        jest.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("original is the file, with no look at its bitrate or the cache", async () => {
        const cache = jest.spyOn(svc as any, "getCachedTranscode");
        const src = makeTmpFile(tmpDir, "orig.flac");
        expect((await svc.getStreamFilePath("t1", "original", new Date(), src)).filePath).toBe(src);
        expect(parseFile).not.toHaveBeenCalled();
        expect(cache).not.toHaveBeenCalled();
    });

    it("a cached transcode is served before the file is read", async () => {
        const cached = path.join(tmpDir, "cached.mp3");
        jest.spyOn(svc as any, "getCachedTranscode").mockResolvedValue(cached);
        const out = await svc.getStreamFilePath("t2", "medium", new Date(), makeTmpFile(tmpDir, "src.flac"));
        expect(out).toEqual({ filePath: cached, mimeType: "audio/mpeg" });
        expect(parseFile).not.toHaveBeenCalled();
    });

    it("with nothing cached, a file already within the tier is served as it is, in its own format", async () => {
        jest.spyOn(svc as any, "getCachedTranscode").mockResolvedValue(null);
        (parseFile as jest.Mock).mockResolvedValue({ format: { bitrate: 96_000 } });
        const src = path.join(tmpDir, "small.m4a");
        fs.writeFileSync(src, "audio data");
        expect(await svc.getStreamFilePath("t3", "medium", new Date(), src)).toEqual({ filePath: src, mimeType: "audio/mp4" });
    });
});

describe("a file's bitrate read", () => {
    let tmpDir: string;
    let svc: AudioStreamingService;
    const { parseFile } = require("music-metadata");

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-kbps-"));
        svc = new AudioStreamingService(tmpDir, 10);
        (parseFile as jest.Mock).mockReset();
    });

    afterEach(() => {
        svc.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("is kept while the file is unchanged, and a failed one is tried again", async () => {
        const src = path.join(tmpDir, "song.m4a");
        fs.writeFileSync(src, "audio data");
        (parseFile as jest.Mock)
            .mockRejectedValueOnce(Object.assign(new Error("too many open files"), { code: "EMFILE" }))
            .mockResolvedValue({ format: { bitrate: 96_000 } });

        expect(await svc.servesOriginal(src, "medium", { keepUnderKbps: 128 })).toBe(false);
        expect(await svc.servesOriginal(src, "medium", { keepUnderKbps: 128 })).toBe(true);
        expect(await svc.servesOriginal(src, "medium", { keepUnderKbps: 128 })).toBe(true);
        expect(parseFile).toHaveBeenCalledTimes(2);
    });
});

describe("transcode cache limit", () => {
    let dir: string;
    let service: AudioStreamingService;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "kima-cache-limit-"));
        service = new AudioStreamingService(dir, 10);
        service.getCacheSize = jest.fn().mockResolvedValue(0.95);
        service.evictCache = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        service.destroy();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("follows the size saved in settings, without a restart", async () => {
        mockSettings.mockResolvedValue({ transcodeCacheMaxGb: 1 });
        await service.trimCacheIfNearFull();
        expect(service.evictCache).toHaveBeenCalledWith(0.8);
    });

    it("leaves a cache under 90% of the saved size alone", async () => {
        mockSettings.mockResolvedValue({ transcodeCacheMaxGb: 10 });
        await service.trimCacheIfNearFull();
        expect(service.evictCache).not.toHaveBeenCalled();
    });

    it("uses the size it started with when the settings cannot be read", async () => {
        mockSettings.mockRejectedValue(new Error("db down"));
        (service.getCacheSize as jest.Mock).mockResolvedValue(9.5);
        await service.trimCacheIfNearFull();
        expect(service.evictCache).toHaveBeenCalledWith(8);
    });
});
