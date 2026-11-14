/**
 * Leftovers around the covers folder: a crash mid-write leaves `.part` files that are swept once, the first time the
 * folder is written to after start, and `storeAsJpeg` is the one write path for a stored picture. Real files in a temp
 * folder.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-leftovers-${process.pid}`;

jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: `/tmp/kima-test-leftovers-${process.pid}/transcode` } },
    USER_AGENT: "Kima/test",
}));
jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

const albums = path.join(ROOT, "covers", "albums");

async function picture(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp(randomBytes(100 * 100 * 3), { raw: { width: 100, height: 100, channels: 3 } })[format]().toBuffer();
}

async function formatOf(file: string): Promise<string | undefined> {
    const sharp = (await import("sharp")).default;
    return (await sharp(file).metadata()).format;
}

/** A fresh copy of the module, so "first use after start" is first again. */
function freshStorage(): typeof import("../imageStorage") {
    let loaded!: typeof import("../imageStorage");
    jest.isolateModules(() => {
        loaded = require("../imageStorage");
    });
    return loaded;
}

function plant(file: string, ageMinutes: number) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "half a picture");
    const when = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(file, when, when);
}

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("storeAsJpeg", () => {
    it("keeps a jpeg as it came and turns a png or a webp into a jpeg", async () => {
        const { storeAsJpeg } = freshStorage();
        const jpeg = await picture("jpeg");
        fs.mkdirSync(albums, { recursive: true });

        expect(await storeAsJpeg(path.join(albums, "a.jpg"), jpeg)).toMatch(/^[0-9a-f]{10}$/);
        expect(await storeAsJpeg(path.join(albums, "b.jpg"), await picture("png"))).toMatch(/^[0-9a-f]{10}$/);
        expect(await storeAsJpeg(path.join(albums, "c.jpg"), await picture("webp"))).toMatch(/^[0-9a-f]{10}$/);

        expect(fs.readFileSync(path.join(albums, "a.jpg")).equals(jpeg)).toBe(true);
        expect(await formatOf(path.join(albums, "b.jpg"))).toBe("jpeg");
        expect(await formatOf(path.join(albums, "c.jpg"))).toBe("jpeg");
    });

    it("stores nothing and answers false when the bytes are no picture, leaving an earlier file as it was", async () => {
        const { storeAsJpeg } = freshStorage();
        const earlier = await picture("jpeg");
        fs.mkdirSync(albums, { recursive: true });
        fs.writeFileSync(path.join(albums, "a.jpg"), earlier);

        expect(await storeAsJpeg(path.join(albums, "a.jpg"), Buffer.alloc(2000, 7))).toBeNull();
        expect(await storeAsJpeg(path.join(albums, "n.jpg"), Buffer.alloc(2000, 7))).toBeNull();

        expect(fs.readFileSync(path.join(albums, "a.jpg")).equals(earlier)).toBe(true);
        expect(fs.existsSync(path.join(albums, "n.jpg"))).toBe(false);
    });

    it("leaves no partial file when the write fails, and says so", async () => {
        const { storeAsJpeg } = freshStorage();
        fs.mkdirSync(albums, { recursive: true });
        jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("swap failed"));

        await expect(storeAsJpeg(path.join(albums, "a.jpg"), await picture("jpeg"))).rejects.toThrow("swap failed");
        expect(fs.readdirSync(albums)).toEqual([]);
    });
});

describe("the sweep of orphan .part files", () => {
    it("removes .part files older than ten minutes the first time the folder is written to, and nothing else", async () => {
        plant(path.join(albums, "x.jpg.1.abc.part"), 11);
        plant(path.join(albums, "y.jpg.2.def.part"), 60 * 24);
        plant(path.join(albums, "live.jpg.3.ghi.part"), 9);
        plant(path.join(albums, "keep.jpg"), 60 * 24);
        plant(path.join(albums, "x.part.jpg"), 60 * 24);
        const { storeAsJpeg } = freshStorage();

        await storeAsJpeg(path.join(albums, "new.jpg"), await picture("jpeg"));

        expect(fs.readdirSync(albums).sort()).toEqual(["keep.jpg", "live.jpg.3.ghi.part", "new.jpg", "x.part.jpg"]);
    });

    it("sweeps a folder once per start: a leftover appearing later waits for the next start", async () => {
        const { storeAsJpeg } = freshStorage();
        fs.mkdirSync(albums, { recursive: true });
        await storeAsJpeg(path.join(albums, "first.jpg"), await picture("jpeg"));
        plant(path.join(albums, "late.jpg.1.abc.part"), 30);

        await storeAsJpeg(path.join(albums, "second.jpg"), await picture("jpeg"));

        expect(fs.existsSync(path.join(albums, "late.jpg.1.abc.part"))).toBe(true);
    });

    it("sweeps each folder on its own first write", async () => {
        const artists = path.join(ROOT, "covers", "artists");
        plant(path.join(albums, "x.jpg.1.abc.part"), 30);
        plant(path.join(artists, "y.jpg.1.abc.part"), 30);
        const { storeAsJpeg } = freshStorage();

        await storeAsJpeg(path.join(albums, "a.jpg"), await picture("jpeg"));
        expect(fs.existsSync(path.join(artists, "y.jpg.1.abc.part"))).toBe(true);
        await storeAsJpeg(path.join(artists, "a.jpg"), await picture("jpeg"));

        expect(fs.readdirSync(albums).sort()).toEqual(["a.jpg"]);
        expect(fs.readdirSync(artists).sort()).toEqual(["a.jpg"]);
    });

    it("does not stop the write when the sweep cannot read the folder", async () => {
        const { storeAsJpeg } = freshStorage();
        fs.mkdirSync(albums, { recursive: true });
        jest.spyOn(fs.promises, "readdir").mockRejectedValueOnce(new Error("EACCES"));

        expect(await storeAsJpeg(path.join(albums, "a.jpg"), await picture("jpeg"))).toMatch(/^[0-9a-f]{10}$/);
        expect(fs.existsSync(path.join(albums, "a.jpg"))).toBe(true);
    });

    it("also sweeps the folder of a smaller copy written for a request", async () => {
        const { coverFileForWidth } = freshStorage();
        const sharp = (await import("sharp")).default;
        const wide = await sharp(randomBytes(400 * 400 * 3), { raw: { width: 400, height: 400, channels: 3 } }).jpeg().toBuffer();
        fs.mkdirSync(albums, { recursive: true });
        fs.writeFileSync(path.join(albums, "a.jpg"), wide);
        plant(path.join(albums, "old.jpg.1.abc.part"), 30);

        const served = await coverFileForWidth(path.join(albums, "a.jpg"), "albums/a.jpg", 100);

        expect(served).toBe(path.join(albums, "a_w100.jpg"));
        expect(fs.readdirSync(albums).sort()).toEqual(["a.jpg", "a_w100.jpg"]);
    });
});
