/**
 * Stored pictures have a size cap of 20 MB: a download over it is refused by its Content-Length or, when none is sent or
 * it understates, by the bytes counted as they stream in (the download is aborted past the cap); a local artist picture
 * is refused by its size on disk before it is read. Real files in a temp folder.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ROOT = `/tmp/kima-test-sizecap-${process.pid}`;
const CAP = 20 * 1024 * 1024;

jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: `/tmp/kima-test-sizecap-${process.pid}/transcode` } },
    USER_AGENT: "Kima/test",
}));
jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logger } from "../../utils/logger";
import { fetchChecked } from "../../utils/ssrf";
import { downloadAndStoreImage, findLocalArtistImage } from "../imageStorage";

const fetchMock = fetchChecked as jest.Mock;
const albums = path.join(ROOT, "covers", "albums");
const artistsDir = path.join(ROOT, "covers", "artists");
const music = path.join(ROOT, "music");

async function picture(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp(randomBytes(100 * 100 * 3), { raw: { width: 100, height: 100, channels: 3 } }).jpeg().toBuffer();
}

/** A body of `total` bytes sent in 1 MB chunks, counting the chunks asked for and whether the reader gave up. */
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

afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    fetchMock.mockReset();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("a downloaded picture over the cap", () => {
    it("is refused by its Content-Length, without reading the body", async () => {
        const { state, body } = streamOf(CAP + 1);
        fetchMock.mockResolvedValue(
            new Response(body, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(CAP + 1) } }),
        );

        expect(await downloadAndStoreImage("https://example.org/c.jpg", "big1", "album")).toBeNull();

        expect(state.sent).toBeLessThan(CAP / 2);
        expect(fs.existsSync(path.join(albums, "big1.jpg"))).toBe(false);
        expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes("big1"))).toBe(true);
    });

    it("is aborted once the streamed bytes pass the cap, when no length was sent", async () => {
        const { state, body } = streamOf(CAP * 3);
        fetchMock.mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } }));

        expect(await downloadAndStoreImage("https://example.org/c.jpg", "big2", "album")).toBeNull();

        expect(state.cancelled).toBe(true);
        expect(state.sent).toBeLessThanOrEqual(CAP + 2 * 1024 * 1024);
        expect(fs.existsSync(path.join(albums, "big2.jpg"))).toBe(false);
    });

    it("is aborted by the streamed count when the Content-Length understates it", async () => {
        const { state, body } = streamOf(CAP * 2);
        fetchMock.mockResolvedValue(
            new Response(body, { status: 200, headers: { "content-type": "image/jpeg", "content-length": "5000" } }),
        );

        expect(await downloadAndStoreImage("https://example.org/c.jpg", "big3", "album")).toBeNull();

        expect(state.cancelled).toBe(true);
        expect(fs.existsSync(path.join(albums, "big3.jpg"))).toBe(false);
    });

    it("leaves an earlier cover as it was", async () => {
        const earlier = await picture();
        fs.mkdirSync(albums, { recursive: true });
        fs.writeFileSync(path.join(albums, "big4.jpg"), earlier);
        const { body } = streamOf(CAP * 2);
        fetchMock.mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } }));

        expect(await downloadAndStoreImage("https://example.org/c.jpg", "big4", "album")).toBeNull();

        expect(fs.readFileSync(path.join(albums, "big4.jpg")).equals(earlier)).toBe(true);
    });
});

describe("a downloaded picture at the cap's edge", () => {
    it("still stores a normal picture streamed in pieces, and one declared with its true length", async () => {
        const jpeg = await picture();
        fetchMock.mockResolvedValueOnce(
            new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(jpeg.length) } }),
        );
        fetchMock.mockResolvedValueOnce(
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(jpeg.subarray(0, 700)));
                        controller.enqueue(new Uint8Array(jpeg.subarray(700)));
                        controller.close();
                    },
                }),
                { status: 200, headers: { "content-type": "image/jpeg" } },
            ),
        );

        expect(await downloadAndStoreImage("https://example.org/a.jpg", "ok1", "album")).toBe("native:albums/ok1.jpg");
        expect(await downloadAndStoreImage("https://example.org/b.jpg", "ok2", "album")).toBe("native:albums/ok2.jpg");

        expect(fs.readFileSync(path.join(albums, "ok1.jpg")).equals(jpeg)).toBe(true);
        expect(fs.readFileSync(path.join(albums, "ok2.jpg")).equals(jpeg)).toBe(true);
    });

    it("still refuses a placeholder under 1000 bytes", async () => {
        fetchMock.mockResolvedValue(new Response(new Uint8Array(500), { status: 200, headers: { "content-type": "image/jpeg" } }));

        expect(await downloadAndStoreImage("https://example.org/p.jpg", "tiny", "album")).toBeNull();
    });
});

describe("a local artist picture over the cap", () => {
    const trackPath = path.join("Band", "Album", "01.flac");

    it("is skipped by its size on disk, without being read, and the next candidate is used", async () => {
        const huge = path.join(music, "Band", "artist.jpg");
        fs.mkdirSync(path.dirname(huge), { recursive: true });
        fs.closeSync(fs.openSync(huge, "w"));
        fs.truncateSync(huge, CAP + 1);
        const jpeg = await picture();
        fs.writeFileSync(path.join(music, "Band", "folder.jpg"), jpeg);
        const read = jest.spyOn(fs.promises, "readFile");

        expect(await findLocalArtistImage(music, trackPath, "ar1")).toBe("native:artists/ar1.jpg");

        expect(read.mock.calls.some((c) => String(c[0]).endsWith("artist.jpg"))).toBe(false);
        expect(fs.readFileSync(path.join(artistsDir, "ar1.jpg")).equals(jpeg)).toBe(true);
        expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes("artist.jpg"))).toBe(true);
    });

    it("finds none when the only picture is over the cap", async () => {
        const huge = path.join(music, "Band", "artist.png");
        fs.mkdirSync(path.dirname(huge), { recursive: true });
        fs.closeSync(fs.openSync(huge, "w"));
        fs.truncateSync(huge, CAP + 1);

        expect(await findLocalArtistImage(music, trackPath, "ar2")).toBeNull();
        expect(fs.existsSync(path.join(artistsDir, "ar2.jpg"))).toBe(false);
    });
});
