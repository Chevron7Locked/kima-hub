/**
 * A changed cover gets fresh resized copies: storing a cover drops that cover's smaller copies (and only its own), a
 * copy older than its cover is never served, and a copy made from bytes that were replaced meanwhile is not kept. Real
 * files in a temp folder.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-changedcover-${process.pid}`;

jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: `/tmp/kima-test-changedcover-${process.pid}/transcode` } },
    USER_AGENT: "Kima/test",
}));
jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

import { fetchChecked } from "../../utils/ssrf";
import { coverFileForWidth, downloadAndStoreImage, findLocalArtistImage, storeAsJpeg } from "../imageStorage";

const albums = path.join(ROOT, "covers", "albums");
const artistsDir = path.join(ROOT, "covers", "artists");
const music = path.join(ROOT, "music");

async function wide(color: number, size = 600): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    // Noise over a flat colour, so two covers differ in their bytes and are well over the placeholder size.
    const noise = randomBytes(size * size * 3);
    noise.fill(color, 0, 3);
    return sharp(noise, { raw: { width: size, height: size, channels: 3 } }).jpeg().toBuffer();
}
function put(file: string, bytes: Buffer | string, ageSeconds = 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    if (ageSeconds) {
        const when = new Date(Date.now() - ageSeconds * 1000);
        fs.utimesSync(file, when, when);
    }
}
async function widthOf(file: string) {
    const sharp = (await import("sharp")).default;
    return (await sharp(file).metadata()).width;
}

afterEach(() => {
    jest.restoreAllMocks();
    (fetchChecked as jest.Mock).mockReset();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("storing a cover drops its smaller copies", () => {
    it("removes every _w copy of that cover, and no other file", async () => {
        put(path.join(albums, "a1.jpg"), await wide(1));
        put(path.join(albums, "a1_w100.jpg"), "old copy");
        put(path.join(albums, "a1_w640.jpg"), "old copy");
        put(path.join(albums, "a10.jpg"), await wide(2));
        put(path.join(albums, "a10_w100.jpg"), "another cover's copy");
        put(path.join(albums, "a1_w100.png"), "not a copy name");
        put(path.join(albums, "a1_wide.jpg"), "not a copy name");
        put(path.join(albums, "a1_w100.jpg.1.abc.part"), "a write in progress");
        put(path.join(artistsDir, "a1_w100.jpg"), "same id, other folder");

        expect(await storeAsJpeg(path.join(albums, "a1.jpg"), await wide(3))).toBe(true);

        expect(fs.readdirSync(albums).sort()).toEqual([
            "a1.jpg",
            "a10.jpg",
            "a10_w100.jpg",
            "a1_w100.jpg.1.abc.part",
            "a1_w100.png",
            "a1_wide.jpg",
        ]);
        expect(fs.existsSync(path.join(artistsDir, "a1_w100.jpg"))).toBe(true);
    });

    it("keeps the copies when the bytes are no picture and nothing was stored", async () => {
        put(path.join(albums, "a1.jpg"), await wide(1));
        put(path.join(albums, "a1_w100.jpg"), "copy");

        expect(await storeAsJpeg(path.join(albums, "a1.jpg"), Buffer.alloc(2000, 7))).toBe(false);

        expect(fs.existsSync(path.join(albums, "a1_w100.jpg"))).toBe(true);
    });

    it("keeps the copies when the write fails and the old cover stays", async () => {
        put(path.join(albums, "a1.jpg"), await wide(1));
        put(path.join(albums, "a1_w100.jpg"), "copy");
        jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("disk full"));

        await expect(storeAsJpeg(path.join(albums, "a1.jpg"), await wide(2))).rejects.toThrow("disk full");

        expect(fs.existsSync(path.join(albums, "a1_w100.jpg"))).toBe(true);
    });

    it("serves a fresh copy of the new cover after a stored change", async () => {
        fs.mkdirSync(albums, { recursive: true });
        const first = path.join(albums, "a1.jpg");
        await storeAsJpeg(first, await wide(1, 600));
        expect(await widthOf(await coverFileForWidth(first, "albums/a1.jpg", 100))).toBe(100);
        const oldCopy = fs.readFileSync(path.join(albums, "a1_w100.jpg"));

        await storeAsJpeg(first, await wide(9, 700));
        const served = await coverFileForWidth(first, "albums/a1.jpg", 100);

        expect(served).toBe(path.join(albums, "a1_w100.jpg"));
        expect(fs.readFileSync(served).equals(oldCopy)).toBe(false);
    });

    it("applies to a download that replaces a cover", async () => {
        put(path.join(albums, "d1.jpg"), await wide(1));
        put(path.join(albums, "d1_w300.jpg"), "old copy");
        (fetchChecked as jest.Mock).mockResolvedValue(
            new Response(new Uint8Array(await wide(2)), { status: 200, headers: { "content-type": "image/jpeg" } }),
        );

        expect(await downloadAndStoreImage("https://example.org/c.jpg", "d1", "album")).toBe("native:albums/d1.jpg");

        expect(fs.readdirSync(albums)).toEqual(["d1.jpg"]);
    });

    it("applies to a local artist picture that replaces one", async () => {
        put(path.join(artistsDir, "ar1.jpg"), await wide(1));
        put(path.join(artistsDir, "ar1_w300.jpg"), "old copy");
        put(path.join(music, "Band", "artist.jpg"), await wide(2));

        expect(await findLocalArtistImage(music, path.join("Band", "Album", "01.flac"), "ar1")).toBe("native:artists/ar1.jpg");

        expect(fs.readdirSync(artistsDir)).toEqual(["ar1.jpg"]);
    });
});

describe("coverFileForWidth and a changed cover", () => {
    it("makes a new copy when the one on disk is older than the cover", async () => {
        const cover = path.join(albums, "o1.jpg");
        put(cover, await wide(1, 600), 10);
        put(path.join(albums, "o1_w100.jpg"), await wide(2, 100), 60);

        await coverFileForWidth(cover, "albums/o1.jpg", 100);

        expect((await fs.promises.stat(path.join(albums, "o1_w100.jpg"))).mtimeMs).toBeGreaterThan(Date.now() - 5000);
        expect(await widthOf(path.join(albums, "o1_w100.jpg"))).toBe(100);
    });

    it("serves a copy that is newer than the cover as it is", async () => {
        const cover = path.join(albums, "o2.jpg");
        put(cover, await wide(1, 600), 60);
        const copy = await wide(2, 100);
        put(path.join(albums, "o2_w100.jpg"), copy, 10);

        expect(await coverFileForWidth(cover, "albums/o2.jpg", 100)).toBe(path.join(albums, "o2_w100.jpg"));

        expect(fs.readFileSync(path.join(albums, "o2_w100.jpg")).equals(copy)).toBe(true);
    });

    it("keeps no copy made from a cover that was replaced while it was being read, and serves the cover", async () => {
        const cover = path.join(albums, "r1.jpg");
        put(cover, await wide(1, 600));
        const realRead = fs.promises.readFile;
        jest.spyOn(fs.promises, "readFile").mockImplementationOnce(async (...args: Parameters<typeof realRead>) => {
            const old = await realRead(...args);
            // The cover is stored anew (and its copies cleared) while the old bytes are being resized.
            await storeAsJpeg(cover, await wide(5, 700));
            return old;
        });

        const served = await coverFileForWidth(cover, "albums/r1.jpg", 100);

        expect(served).toBe(cover);
        expect(fs.readdirSync(albums)).toEqual(["r1.jpg"]);
    });
});
