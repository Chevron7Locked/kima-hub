/**
 * How a stored cover is converted and written: orientation and transparency survive the conversion, a local artist
 * picture goes through the one write path, and a smaller copy is read without blocking the server. Real files in a temp
 * folder.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-coverwrites-${process.pid}`;

jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: `/tmp/kima-test-coverwrites-${process.pid}/transcode` } },
    USER_AGENT: "Kima/test",
}));
jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

import { coverFileForWidth, findLocalArtistImage, storeAsJpeg } from "../imageStorage";

const albums = path.join(ROOT, "covers", "albums");
const artistsDir = path.join(ROOT, "covers", "artists");
const music = path.join(ROOT, "music");
const trackPath = path.join("Band", "Album", "01.flac");

async function picture(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp(randomBytes(100 * 100 * 3), { raw: { width: 100, height: 100, channels: 3 } })[format]().toBuffer();
}
async function metadataOf(file: string) {
    const sharp = (await import("sharp")).default;
    return sharp(file).metadata();
}
function put(file: string, bytes: Buffer) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
}

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("storeAsJpeg keeps orientation and transparency", () => {
    /** A 60 x 30 landscape picture whose orientation tag says to turn it a quarter turn: it shows as 30 x 60. */
    async function sideways(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
        const sharp = (await import("sharp")).default;
        return sharp(randomBytes(60 * 30 * 3), { raw: { width: 60, height: 30, channels: 3 } })
            .withMetadata({ orientation: 6 })
            [format]()
            .toBuffer();
    }

    it("turns a rotated jpeg upright", async () => {
        fs.mkdirSync(albums, { recursive: true });

        expect(await storeAsJpeg(path.join(albums, "r.jpg"), await sideways("jpeg"))).toBe(true);

        const stored = await metadataOf(path.join(albums, "r.jpg"));
        expect(stored).toMatchObject({ format: "jpeg", width: 30, height: 60 });
        expect(stored.orientation).toBeUndefined();
    });

    it("turns a rotated png or webp upright when converting it", async () => {
        fs.mkdirSync(albums, { recursive: true });

        await storeAsJpeg(path.join(albums, "p.jpg"), await sideways("png"));
        await storeAsJpeg(path.join(albums, "w.jpg"), await sideways("webp"));

        expect(await metadataOf(path.join(albums, "p.jpg"))).toMatchObject({ format: "jpeg", width: 30, height: 60 });
        expect(await metadataOf(path.join(albums, "w.jpg"))).toMatchObject({ format: "jpeg", width: 30, height: 60 });
    });

    it("stores a jpeg that needs no rotation as it came, even with an upright orientation tag", async () => {
        const sharp = (await import("sharp")).default;
        const upright = await sharp(randomBytes(40 * 40 * 3), { raw: { width: 40, height: 40, channels: 3 } })
            .withMetadata({ orientation: 1 })
            .jpeg()
            .toBuffer();
        fs.mkdirSync(albums, { recursive: true });

        await storeAsJpeg(path.join(albums, "u.jpg"), upright);

        expect(fs.readFileSync(path.join(albums, "u.jpg")).equals(upright)).toBe(true);
    });

    it("shows a transparent png on white, not black", async () => {
        const sharp = (await import("sharp")).default;
        const clear = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
            .png()
            .toBuffer();
        fs.mkdirSync(albums, { recursive: true });

        await storeAsJpeg(path.join(albums, "t.jpg"), clear);

        const { channels } = await sharp(path.join(albums, "t.jpg")).stats();
        for (const channel of channels) expect(channel.mean).toBeGreaterThan(250);
    });
});

describe("a local artist picture", () => {
    it("is stored as a jpeg named for the artist, whatever format the folder's picture is in", async () => {
        put(path.join(music, "Band", "artist.png"), await picture("png"));

        expect(await findLocalArtistImage(music, trackPath, "a1")).toBe("native:artists/a1.jpg");

        expect((await metadataOf(path.join(artistsDir, "a1.jpg"))).format).toBe("jpeg");
        expect(fs.readdirSync(artistsDir)).toEqual(["a1.jpg"]);
    });

    it("keeps a folder jpeg as it came", async () => {
        const jpeg = await picture("jpeg");
        put(path.join(music, "Band", "folder.jpg"), jpeg);

        expect(await findLocalArtistImage(music, trackPath, "a2")).toBe("native:artists/a2.jpg");
        expect(fs.readFileSync(path.join(artistsDir, "a2.jpg")).equals(jpeg)).toBe(true);
    });

    it("goes on to the next candidate when a file is no picture, and finds none when none is", async () => {
        put(path.join(music, "Band", "artist.jpg"), Buffer.alloc(2000, 7));
        put(path.join(music, "Band", "folder.png"), await picture("png"));

        expect(await findLocalArtistImage(music, trackPath, "a3")).toBe("native:artists/a3.jpg");
        expect((await metadataOf(path.join(artistsDir, "a3.jpg"))).format).toBe("jpeg");

        fs.rmSync(path.join(music, "Band", "folder.png"));
        expect(await findLocalArtistImage(music, trackPath, "a4")).toBeNull();
        expect(fs.existsSync(path.join(artistsDir, "a4.jpg"))).toBe(false);
    });

    it("is written atomically, never by a plain copy", async () => {
        put(path.join(music, "Band", "artist.png"), await picture("png"));
        const copy = jest.spyOn(fs.promises, "copyFile");
        const rename = jest.spyOn(fs.promises, "rename");

        await findLocalArtistImage(music, trackPath, "a5");

        expect(copy).not.toHaveBeenCalled();
        expect(rename).toHaveBeenCalledTimes(1);
    });

    it("leaves no partial file and finds no picture when the write fails", async () => {
        put(path.join(music, "Band", "artist.png"), await picture("png"));
        jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("disk full"));

        expect(await findLocalArtistImage(music, trackPath, "a6")).toBeNull();
        expect(fs.readdirSync(artistsDir)).toEqual([]);
    });

    it("still ignores a symbolic link", async () => {
        put(path.join(ROOT, "elsewhere", "pic.png"), await picture("png"));
        fs.mkdirSync(path.join(music, "Band"), { recursive: true });
        fs.symlinkSync(path.join(ROOT, "elsewhere", "pic.png"), path.join(music, "Band", "artist.png"));

        expect(await findLocalArtistImage(music, trackPath, "a7")).toBeNull();
    });
});

describe("coverFileForWidth", () => {
    it("reads the cover without blocking the server", async () => {
        const sharp = (await import("sharp")).default;
        put(
            path.join(albums, "big.jpg"),
            await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer(),
        );
        const blocking = jest.spyOn(fs, "readFileSync");

        const served = await coverFileForWidth(path.join(albums, "big.jpg"), "albums/big.jpg", 100);

        expect(served).toBe(path.join(albums, "big_w100.jpg"));
        expect(blocking).not.toHaveBeenCalled();
    });
});
