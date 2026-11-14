/**
 * A stored cover's address carries a version set when the cover is stored: a short digest of the bytes, so it changes when
 * the picture does and not when the same picture is stored again. The address still finds its file without the version,
 * and an address without one (stored before versions) still works. Real files in a temp folder.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-coververs-${process.pid}`;

jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: `/tmp/kima-test-coververs-${process.pid}/transcode` } },
    USER_AGENT: "Kima/test",
}));
jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

import { fetchChecked } from "../../utils/ssrf";
import {
    audiobookCoverAddress,
    coverCacheControl,
    downloadAndStoreImage,
    findLocalArtistImage,
    getLocalImagePath,
    getResizedImagePath,
    MAX_PICTURE_BYTES,
    nativeFileExists,
    parseStoredCover,
    readPicture,
    storeAsJpeg,
    storedCoverValue,
    versionOfFile,
} from "../imageStorage";

const albums = path.join(ROOT, "covers", "albums");
const music = path.join(ROOT, "music");
const VERSION = /^[0-9a-f]{10}$/;

async function picture(seed: number): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    const noise = randomBytes(300 * 300 * 3);
    noise.fill(seed, 0, 3);
    return sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).jpeg().toBuffer();
}

afterEach(() => {
    (fetchChecked as jest.Mock).mockReset();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("storeAsJpeg answers the version of what it stored", () => {
    it("is a short digest, the same for the same picture and different for another", async () => {
        fs.mkdirSync(albums, { recursive: true });
        const one = await picture(1);

        const first = await storeAsJpeg(path.join(albums, "a.jpg"), one);
        const again = await storeAsJpeg(path.join(albums, "b.jpg"), one);
        const other = await storeAsJpeg(path.join(albums, "a.jpg"), await picture(2));

        expect(first).toMatch(VERSION);
        expect(again).toBe(first);
        expect(other).toMatch(VERSION);
        expect(other).not.toBe(first);
    });

    it("answers null when the bytes are no picture", async () => {
        fs.mkdirSync(albums, { recursive: true });

        expect(await storeAsJpeg(path.join(albums, "a.jpg"), Buffer.alloc(2000, 7))).toBeNull();
    });

    it("is the version of the file that is on disk", async () => {
        fs.mkdirSync(albums, { recursive: true });
        const file = path.join(albums, "a.jpg");

        const stored = await storeAsJpeg(file, await picture(4));

        expect(await versionOfFile(file)).toBe(stored);
        expect(await versionOfFile(path.join(albums, "none.jpg"))).toBeNull();
    });
});

describe("a stored cover's address", () => {
    it("is the stored path, then the version", () => {
        expect(storedCoverValue("albums/a1.jpg", "abc123")).toBe("native:albums/a1.jpg?v=abc123");
        expect(storedCoverValue("albums/a1.jpg", null)).toBe("native:albums/a1.jpg");
    });

    it("reads back into its path and version, or only a path when it has none", () => {
        expect(parseStoredCover("native:albums/a1.jpg?v=abc123")).toEqual({ relativePath: "albums/a1.jpg", version: "abc123" });
        expect(parseStoredCover("native:albums/a1.jpg")).toEqual({ relativePath: "albums/a1.jpg", version: null });
        expect(parseStoredCover("https://example.org/a.jpg")).toBeNull();
        expect(parseStoredCover("")).toBeNull();
    });

    it("finds its file with or without the version", async () => {
        fs.mkdirSync(albums, { recursive: true });
        const file = path.join(albums, "a1.jpg");
        await storeAsJpeg(file, await picture(5));

        expect(getLocalImagePath("native:albums/a1.jpg?v=abc123")).toBe(file);
        expect(getLocalImagePath("native:albums/a1.jpg")).toBe(file);
        expect(nativeFileExists("native:albums/a1.jpg?v=abc123")).toBe(true);
        expect(nativeFileExists("native:albums/none.jpg?v=abc123")).toBe(false);
        expect(getResizedImagePath("native:albums/a1.jpg?v=abc123", 300)).toBe(path.join(albums, "a1_w300.jpg"));
    });

    it("still refuses a path that leaves the covers folder, version or not", () => {
        expect(getLocalImagePath("native:../../etc/passwd?v=abc123")).toBeNull();
        expect(getLocalImagePath("native:../../etc/passwd")).toBeNull();
    });
});

describe("what a cover is served with", () => {
    it("is kept for a year, for good, when the address carries a version", () => {
        expect(coverCacheControl("abc123")).toBe("public, max-age=31536000, immutable");
    });

    it("is checked each time when the address has no version, as a stored cover can change under it", () => {
        expect(coverCacheControl(null)).toBe("public, no-cache");
    });
});

describe("a stored cover handed back by the writers carries its version", () => {
    it("is the address of a downloaded image", async () => {
        const bytes = await picture(6);
        (fetchChecked as jest.Mock).mockResolvedValue(
            new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
        );

        const value = await downloadAndStoreImage("https://example.org/a.jpg", "art1", "artist");

        const version = await versionOfFile(path.join(ROOT, "covers", "artists", "art1.jpg"));
        expect(value).toBe(`native:artists/art1.jpg?v=${version}`);
        expect(version).toMatch(VERSION);
    });

    it("is the address of a picture found in the artist's folder", async () => {
        fs.mkdirSync(path.join(music, "Band", "Album"), { recursive: true });
        fs.writeFileSync(path.join(music, "Band", "artist.jpg"), await picture(7));

        const value = await findLocalArtistImage(music, path.join("Band", "Album", "01.flac"), "art2");

        const version = await versionOfFile(path.join(ROOT, "covers", "artists", "art2.jpg"));
        expect(value).toBe(`native:artists/art2.jpg?v=${version}`);
    });
});

describe("an audiobook's cover address", () => {
    it("carries the version of the picture, which is taken when the cover is stored", () => {
        expect(audiobookCoverAddress({ id: "bk1", localCoverPath: "/music/cover.jpg", coverUrl: null, coverVersion: "ab12cd34ef" })).toBe(
            "/audiobooks/bk1/cover/ab12cd34ef",
        );
    });

    it("is there, without a version, when only Audiobookshelf holds the cover or the version is not known yet", () => {
        expect(audiobookCoverAddress({ id: "bk1", localCoverPath: null, coverUrl: "items/bk1/cover", coverVersion: null })).toBe("/audiobooks/bk1/cover");
    });

    it("is null when the book has no cover", () => {
        expect(audiobookCoverAddress({ id: "bk1", localCoverPath: null, coverUrl: null, coverVersion: null })).toBeNull();
    });

    it("does not change when the book is synced again with the same picture, and does when the picture changes", () => {
        const a = audiobookCoverAddress({ id: "bk1", localCoverPath: "p", coverUrl: null, coverVersion: "aaaaaaaaaa" });
        expect(audiobookCoverAddress({ id: "bk1", localCoverPath: "p", coverUrl: null, coverVersion: "aaaaaaaaaa" })).toBe(a);
        expect(audiobookCoverAddress({ id: "bk1", localCoverPath: "p", coverUrl: null, coverVersion: "bbbbbbbbbb" })).not.toBe(a);
    });
});

describe("a picture read from a proxied reply", () => {
    const reply = (body: Uint8Array | string, headers: Record<string, string>) => new Response(body, { status: 200, headers });

    it("is its bytes and its image type", async () => {
        const read = await readPicture(reply(new Uint8Array([1, 2, 3]), { "content-type": "image/png" }));
        expect(read).toEqual({ bytes: Buffer.from([1, 2, 3]), contentType: "image/png" });
    });

    it("is given as its type alone, without parameters", async () => {
        const read = await readPicture(reply(new Uint8Array([1]), { "content-type": "image/jpeg; charset=binary" }));
        expect(read?.contentType).toBe("image/jpeg");
    });

    it.each(["text/html", "application/octet-stream", "image"])("is nothing when its type is %p, not an image", async (type) => {
        expect(await readPicture(reply(new Uint8Array([1]), { "content-type": type }))).toBeNull();
    });

    // An SVG is a document that can carry script; served from Kima's own address it would run there.
    it.each(["image/svg+xml", "image/x-icon", "image/tiff"])("is nothing when its type is %p, not a picture a browser draws as a plain image", async (type) => {
        expect(await readPicture(reply(new Uint8Array([1]), { "content-type": type }))).toBeNull();
    });

    it.each(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])("is read when its type is %p", async (type) => {
        expect((await readPicture(reply(new Uint8Array([1]), { "content-type": type })))?.contentType).toBe(type);
    });

    it("is nothing when it names no type", async () => {
        expect(await readPicture(new Response(new Uint8Array([1]), { status: 200 }))).toBeNull();
    });

    it("is nothing when it is over the cap, judged by its declared length", async () => {
        const over = reply(new Uint8Array([1]), { "content-type": "image/jpeg", "content-length": String(MAX_PICTURE_BYTES + 1) });
        expect(await readPicture(over)).toBeNull();
    });

    it("is nothing when it is over the cap, judged by the bytes that arrive", async () => {
        const over = reply(new Uint8Array(MAX_PICTURE_BYTES + 1), { "content-type": "image/jpeg" });
        expect(await readPicture(over)).toBeNull();
    });
});
