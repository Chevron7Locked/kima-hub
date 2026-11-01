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

import { coverFileForWidth, nativeFileExists } from "../imageStorage";

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
        const rename = jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
            throw new Error("disk full");
        });
        await expect(coverFileForWidth(path.join(dir, "wide.jpg"), "albums/wide.jpg", 200)).rejects.toThrow("disk full");
        rename.mockRestore();
        expect(fs.readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
    });

    afterAll(() => {
        fs.rmSync(`/tmp/kima-test-cache-${process.pid}`, { recursive: true, force: true });
    });
});
