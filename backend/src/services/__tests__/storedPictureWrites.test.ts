/**
 * The audiobook cover cache and the scanner's embedded-art extractor write pictures the way every other stored picture is
 * written: converted to JPEG, whole or not at all. Real files in a temp folder; Audiobookshelf and the tag reader are
 * stubbed.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-picwrites-${process.pid}`;

jest.mock("../../config", () => ({
    config: {
        music: {
            transcodeCachePath: `/tmp/kima-test-picwrites-${process.pid}/transcode`,
            musicPath: `/tmp/kima-test-picwrites-${process.pid}/music`,
        },
    },
    USER_AGENT: "Kima/test",
}));
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({ audiobookshelfApiKey: "key", audiobookshelfUrl: "http://abs" })),
}));
jest.mock("../audiobookshelf", () => ({ audiobookshelfService: {} }));
jest.mock("music-metadata", () => ({ parseFile: jest.fn() }));

import { parseFile } from "music-metadata";
import { audiobookCacheService } from "../audiobookCache";
import { CoverArtExtractor } from "../coverArtExtractor";

const audiobooks = path.join(ROOT, "music", "cover-cache", "audiobooks");
const covers = path.join(ROOT, "covers");

async function picture(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp(randomBytes(100 * 100 * 3), { raw: { width: 100, height: 100, channels: 3 } })[format]().toBuffer();
}
async function formatOf(file: string): Promise<string | undefined> {
    const sharp = (await import("sharp")).default;
    return (await sharp(file).metadata()).format;
}
const CAP = 20 * 1024 * 1024;
/** A body of `total` bytes sent in 1 MB chunks, noting how much was asked for and whether the reader gave up. */
function streamOf(total: number) {
    const state = { sent: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            const size = Math.min(1024 * 1024, total - state.sent);
            if (size <= 0) return controller.close();
            state.sent += size;
            controller.enqueue(new Uint8Array(size));
        },
        cancel() {
            state.cancelled = true;
        },
    });
    return { state, body };
}
/** A picture that reads fine but is over the cap: trailing bytes after the end of the image are ignored by the decoder. */
async function oversized(): Promise<Buffer> {
    return Buffer.concat([await picture("jpeg"), Buffer.alloc(CAP)]);
}
const answer = (body: Buffer) => jest.spyOn(global, "fetch").mockResolvedValue(new Response(new Uint8Array(body), { status: 200 }));

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("an audiobook cover downloaded to the cover cache", () => {
    const service = audiobookCacheService as any;
    beforeEach(async () => {
        fs.mkdirSync(audiobooks, { recursive: true });
        service.coverCacheAvailable = true;
    });

    it("is saved as a jpeg, whatever format Audiobookshelf sent", async () => {
        answer(await picture("png"));

        const saved = await service.downloadCover("book1", "http://abs/api/items/book1/cover");

        expect(saved.path).toBe(path.join(audiobooks, "book1.jpg"));
        expect(await formatOf(saved.path)).toBe("jpeg");
        expect(saved.version).toMatch(/^[0-9a-f]{10}$/);
    });

    it("keeps a jpeg as it came", async () => {
        const jpeg = await picture("jpeg");
        answer(jpeg);

        const saved = await service.downloadCover("book2", "http://abs/api/items/book2/cover");

        expect(fs.readFileSync(saved.path).equals(jpeg)).toBe(true);
    });

    it("saves nothing when the bytes are no picture", async () => {
        answer(Buffer.from("<html>login</html>"));

        expect(await service.downloadCover("book3", "http://abs/api/items/book3/cover")).toBeNull();
        expect(fs.readdirSync(audiobooks)).toEqual([]);
    });

    it("is refused over the 20 MB cap by its Content-Length, without reading the body", async () => {
        const { state, body } = streamOf(CAP + 1);
        jest.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 200, headers: { "content-length": String(CAP + 1) } }));

        expect(await service.downloadCover("big1", "http://abs/api/items/big1/cover")).toBeNull();

        expect(state.sent).toBeLessThan(CAP / 2);
        expect(fs.readdirSync(audiobooks)).toEqual([]);
    });

    it("is aborted once the streamed bytes pass the cap, when no length was sent", async () => {
        const { state, body } = streamOf(CAP * 3);
        jest.spyOn(global, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

        expect(await service.downloadCover("big2", "http://abs/api/items/big2/cover")).toBeNull();

        expect(state.cancelled).toBe(true);
        expect(state.sent).toBeLessThanOrEqual(CAP + 2 * 1024 * 1024);
        expect(fs.readdirSync(audiobooks)).toEqual([]);
    });

    it("leaves no file, whole or partial, when the write fails midway, and keeps an earlier cover whole", async () => {
        const earlier = await picture("jpeg");
        fs.writeFileSync(path.join(audiobooks, "book4.jpg"), earlier);
        answer(await picture("jpeg"));
        const realWrite = fs.promises.writeFile;
        jest.spyOn(fs.promises, "writeFile").mockImplementationOnce(async (file, data) => {
            await realWrite(file, (data as Buffer).subarray(0, 100));
            throw new Error("disk full");
        });

        expect(await service.downloadCover("book4", "http://abs/api/items/book4/cover")).toBeNull();
        expect(fs.readdirSync(audiobooks)).toEqual(["book4.jpg"]);
        expect(fs.readFileSync(path.join(audiobooks, "book4.jpg")).equals(earlier)).toBe(true);
    });
});

describe("the scanner's embedded cover art", () => {
    const embedded = (data: Buffer | null) =>
        (parseFile as jest.Mock).mockResolvedValue({ common: { picture: data ? [{ data, format: "image/png" }] : undefined } });

    it("is saved as a jpeg when the file embeds a png", async () => {
        embedded(await picture("png"));

        const name = await new CoverArtExtractor(covers).extractCoverArt("/music/a.flac", "alb1");

        // Filed where every album cover is, so the value stored for it is `native:albums/<id>.jpg`.
        expect(name).toBe("albums/alb1.jpg");
        expect(await formatOf(path.join(covers, "albums", "alb1.jpg"))).toBe("jpeg");
    });

    it("saves nothing, and finds no cover, when the embedded bytes are no picture", async () => {
        embedded(Buffer.alloc(500, 3));

        expect(await new CoverArtExtractor(covers).extractCoverArt("/music/a.flac", "alb2")).toBeNull();
        expect(fs.readdirSync(path.join(covers, "albums"))).toEqual([]);
    });

    it("finds no cover when the file embeds none", async () => {
        embedded(null);

        expect(await new CoverArtExtractor(covers).extractCoverArt("/music/a.flac", "alb3")).toBeNull();
    });

    it("is skipped, and finds no cover, when the embedded picture is over the 20 MB cap", async () => {
        embedded(await oversized());

        expect(await new CoverArtExtractor(covers).extractCoverArt("/music/a.flac", "alb4")).toBeNull();
        expect(fs.readdirSync(path.join(covers, "albums"))).toEqual([]);
    });

    it("still stores an embedded picture just under the cap's reach, a normal one", async () => {
        embedded(await picture("jpeg"));

        expect(await new CoverArtExtractor(covers).extractCoverArt("/music/a.flac", "alb5")).toBe("albums/alb5.jpg");
    });

    it("finds the cover already stored under the albums folder and does not read the file again", async () => {
        embedded(await picture("jpeg"));
        const extractor = new CoverArtExtractor(covers);
        await extractor.extractCoverArt("/music/a.flac", "alb6");
        (parseFile as jest.Mock).mockClear();

        expect(await extractor.extractCoverArt("/music/a.flac", "alb6")).toBe("albums/alb6.jpg");
        expect(parseFile).not.toHaveBeenCalled();
    });
});
