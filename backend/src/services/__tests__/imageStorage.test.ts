import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

jest.mock("../../config", () => ({
    config: {
        music: {
            transcodeCachePath: `/tmp/kima-test-cache-${process.pid}/transcode`,
        },
    },
    USER_AGENT: "Kima/test",
}));

jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

import { fetchChecked } from "../../utils/ssrf";
import { coverFileForWidth, downloadAndStoreImage, nativeFileExists } from "../imageStorage";

describe("downloadAndStoreImage and a stop", () => {
    const fetchMock = fetchChecked as jest.Mock;
    afterEach(() => {
        fetchMock.mockReset();
        fs.rmSync(`/tmp/kima-test-cache-${process.pid}`, { recursive: true, force: true });
    });

    it("gives up at once, without asking the network, when the signal is already aborted", async () => {
        const stop = new AbortController();
        stop.abort();

        expect(await downloadAndStoreImage("https://example.com/a.jpg", "a1", "artist", stop.signal)).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ends a download under way within a moment of the signal aborting, not after its own 30 s", async () => {
        // A server that never answers: the request ends only when the signal handed to the fetch aborts.
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
                }),
        );
        const stop = new AbortController();

        const started = Date.now();
        const downloading = downloadAndStoreImage("https://example.com/a.jpg", "a2", "artist", stop.signal);
        setTimeout(() => stop.abort(), 20);

        expect(await downloading).toBeNull();
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("still downloads with no signal", async () => {
        fetchMock.mockResolvedValue(imageResponse(await picture("jpeg"), "image/jpeg"));

        expect(await downloadAndStoreImage("https://example.com/a.jpg", "a3", "artist")).toBe("native:artists/a3.jpg");
    });
});

async function picture(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    // Noise, so the encoded picture is well over the 1000-byte placeholder limit.
    const noise = randomBytes(100 * 100 * 3);
    return sharp(noise, { raw: { width: 100, height: 100, channels: 3 } })[format]().toBuffer();
}

function imageResponse(body: Buffer, contentType: string): Response {
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": contentType } });
}

describe("downloadAndStoreImage writes", () => {
    const fetchMock = fetchChecked as jest.Mock;
    const albums = `/tmp/kima-test-cache-${process.pid}/covers/albums`;
    afterEach(() => {
        jest.restoreAllMocks();
        fetchMock.mockReset();
        fs.rmSync(`/tmp/kima-test-cache-${process.pid}`, { recursive: true, force: true });
    });

    it("keeps a jpeg as it came", async () => {
        const jpeg = await picture("jpeg");
        fetchMock.mockResolvedValue(imageResponse(jpeg, "image/jpeg"));

        expect(await downloadAndStoreImage("https://example.com/c", "w1", "album")).toBe("native:albums/w1.jpg");
        expect(fs.readFileSync(path.join(albums, "w1.jpg")).equals(jpeg)).toBe(true);
    });

    it("turns a png into a jpeg, so the .jpg the readers look for holds a jpeg", async () => {
        fetchMock.mockResolvedValue(imageResponse(await picture("png"), "image/png"));

        expect(await downloadAndStoreImage("https://example.com/c", "w2", "album")).toBe("native:albums/w2.jpg");
        const sharp = (await import("sharp")).default;
        expect((await sharp(path.join(albums, "w2.jpg")).metadata()).format).toBe("jpeg");
    });

    it("stores nothing when the bytes are not a picture, whatever the content type says", async () => {
        fetchMock.mockResolvedValue(imageResponse(Buffer.alloc(2000, 7), "image/png"));

        expect(await downloadAndStoreImage("https://example.com/c", "w3", "album")).toBeNull();
        expect(fs.existsSync(path.join(albums, "w3.jpg"))).toBe(false);
    });

    it("leaves no file, whole or partial, when the write fails midway", async () => {
        fetchMock.mockResolvedValue(imageResponse(await picture("jpeg"), "image/jpeg"));
        const realWrite = fs.promises.writeFile;
        jest.spyOn(fs.promises, "writeFile").mockImplementationOnce(async (file, data) => {
            await realWrite(file, (data as Buffer).subarray(0, 100));
            throw new Error("disk full");
        });

        expect(await downloadAndStoreImage("https://example.com/c", "w4", "album")).toBeNull();
        expect(fs.readdirSync(albums)).toEqual([]);
    });

    it("never shows a half-written file under the final name, and leaves the earlier file whole when the swap fails", async () => {
        const first = await picture("jpeg");
        fetchMock.mockResolvedValue(imageResponse(first, "image/jpeg"));
        await downloadAndStoreImage("https://example.com/c", "w5", "album");

        const sharp = (await import("sharp")).default;
        const second = await sharp(await picture("png")).jpeg({ quality: 30 }).toBuffer();
        fetchMock.mockResolvedValue(imageResponse(second, "image/jpeg"));
        const seenDuringWrite: string[][] = [];
        const realWrite = fs.promises.writeFile;
        jest.spyOn(fs.promises, "writeFile").mockImplementationOnce(async (file, data) => {
            await realWrite(file, data as Buffer);
            seenDuringWrite.push([String(file)]);
        });
        jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("swap failed"));

        expect(await downloadAndStoreImage("https://example.com/c", "w5", "album")).toBeNull();
        // The write went to a temporary name, not the final one, and the earlier cover is untouched.
        expect(seenDuringWrite[0][0]).not.toBe(path.join(albums, "w5.jpg"));
        expect(fs.readFileSync(path.join(albums, "w5.jpg")).equals(first)).toBe(true);
        expect(fs.readdirSync(albums)).toEqual(["w5.jpg"]);
    });
});

describe("nativeFileExists", () => {
    const cacheRoot = `/tmp/kima-test-cache-${process.pid}`;
    const coversBase = path.join(cacheRoot, "covers");

    beforeAll(() => {
        fs.mkdirSync(path.join(coversBase, "artists"), { recursive: true });
        fs.mkdirSync(path.join(coversBase, "albums"), { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(cacheRoot, { recursive: true, force: true });
    });

    it("returns true for existing native file", () => {
        const filePath = path.join(coversBase, "artists", "test123.jpg");
        fs.writeFileSync(filePath, "fake image data here!");
        expect(nativeFileExists("native:artists/test123.jpg")).toBe(true);
    });

    it("returns false for missing native file", () => {
        expect(nativeFileExists("native:artists/nonexistent.jpg")).toBe(false);
    });

    it("returns false for non-native paths", () => {
        expect(nativeFileExists("http://example.com/image.jpg")).toBe(false);
    });

    it("returns false for null/empty", () => {
        expect(nativeFileExists(null)).toBe(false);
        expect(nativeFileExists("")).toBe(false);
    });

    it("returns false for path traversal attempts", () => {
        expect(nativeFileExists("native:../../etc/passwd")).toBe(false);
    });
});

describe("coverFileForWidth", () => {
    const cacheRoot = `/tmp/kima-test-cache-${process.pid}`;
    const albums = path.join(cacheRoot, "covers", "albums");

    beforeAll(async () => {
        fs.mkdirSync(albums, { recursive: true });
        const sharp = (await import("sharp")).default;
        const square = (size: number) =>
            sharp({ create: { width: size, height: size, channels: 3, background: { r: 200, g: 40, b: 40 } } })
                .jpeg()
                .toBuffer();
        fs.writeFileSync(path.join(albums, "big.jpg"), await square(600));
        fs.writeFileSync(path.join(albums, "small.jpg"), await square(200));
    });

    afterAll(() => {
        fs.rmSync(cacheRoot, { recursive: true, force: true });
    });

    it("writes and serves a smaller copy when the cover is wider than asked", async () => {
        const file = await coverFileForWidth(path.join(albums, "big.jpg"), "albums/big.jpg", 256);
        expect(file).toBe(path.join(albums, "big_w256.jpg"));
        const sharp = (await import("sharp")).default;
        expect((await sharp(file).metadata()).width).toBe(256);
    });

    it("serves the original, and writes no copy, when the cover is no wider than asked", async () => {
        const file = await coverFileForWidth(path.join(albums, "small.jpg"), "albums/small.jpg", 512);
        expect(file).toBe(path.join(albums, "small.jpg"));
        expect(fs.existsSync(path.join(albums, "small_w512.jpg"))).toBe(false);
    });
});

describe("coverFileForWidth leaves no partial files", () => {
    it("leaves only the finished copy in the folder", async () => {
        const dir = `/tmp/kima-test-cache-${process.pid}/covers/albums`;
        fs.mkdirSync(dir, { recursive: true });
        const sharp = (await import("sharp")).default;
        fs.writeFileSync(
            path.join(dir, "wide.jpg"),
            await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer(),
        );
        await coverFileForWidth(path.join(dir, "wide.jpg"), "albums/wide.jpg", 300);
        expect(fs.readdirSync(dir).filter((f) => f.startsWith("wide")).sort()).toEqual(["wide.jpg", "wide_w300.jpg"]);
    });

    it("removes the partial file when putting the copy in place fails", async () => {
        const dir = `/tmp/kima-test-cache-${process.pid}/covers/albums`;
        const rename = jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("disk full"));
        await expect(coverFileForWidth(path.join(dir, "wide.jpg"), "albums/wide.jpg", 200)).rejects.toThrow("disk full");
        rename.mockRestore();
        expect(fs.readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
    });

    afterAll(() => {
        fs.rmSync(`/tmp/kima-test-cache-${process.pid}`, { recursive: true, force: true });
    });
});
