/**
 * The Subsonic cover route serves a cover held at another site as Kima's own, so a page of covers must not become a page
 * of fetches: a picture is kept in memory, per address and width, for a few hours, within a small bound on how many
 * pictures and how many bytes. An address that failed is remembered for a few minutes, within a bound. The fetch itself (`fetchPicture`) is replaced; the scaling is real.
 */

jest.mock("../imageStorage", () => ({
    ...jest.requireActual("../imageStorage"),
    fetchPicture: jest.fn(),
}));

import sharp from "sharp";
import { fetchPicture } from "../imageStorage";
import { clearExternalCoverCache, EXTERNAL_COVER_CACHE, externalCoverPicture } from "../externalCoverCache";

const fetchMock = fetchPicture as jest.Mock;
const URL_A = "https://img.example/a.jpg";

async function wide(): Promise<Buffer> {
    const noise = Buffer.alloc(600 * 400 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
    return sharp(noise, { raw: { width: 600, height: 400, channels: 3 } }).jpeg().toBuffer();
}
const widthOf = async (bytes: Buffer) => (await sharp(bytes).metadata()).width;

let original: Buffer;
beforeAll(async () => {
    original = await wide();
});
beforeEach(() => {
    clearExternalCoverCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ bytes: original, contentType: "image/jpeg" }));
});
afterEach(() => jest.restoreAllMocks());

describe("externalCoverPicture", () => {
    it("fetches a picture once for the same address and width, and answers the same picture again", async () => {
        const first = await externalCoverPicture(URL_A, null);
        const second = await externalCoverPicture(URL_A, null);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);
        expect(first).toEqual({ bytes: original, contentType: "image/jpeg" });
    });

    it("keeps a width apart from the whole picture and from another width, each scaled", async () => {
        const whole = await externalCoverPicture(URL_A, null);
        const small = await externalCoverPicture(URL_A, 300);
        const smaller = await externalCoverPicture(URL_A, 100);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(await widthOf(whole!.bytes)).toBe(600);
        expect(await widthOf(small!.bytes)).toBe(300);
        expect(await widthOf(smaller!.bytes)).toBe(100);
        expect(small!.contentType).toBe("image/jpeg");
        await externalCoverPicture(URL_A, 300);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("keeps one address apart from another", async () => {
        await externalCoverPicture(URL_A, null);
        await externalCoverPicture("https://img.example/b.jpg", null);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps the type the site gave when it does not scale the picture", async () => {
        // Narrower than the width asked for, so it is served as it came.
        const tiny = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#336699" } }).png().toBuffer();
        fetchMock.mockResolvedValue({ bytes: tiny, contentType: "image/png" });

        expect(await externalCoverPicture(URL_A, 300)).toEqual({ bytes: tiny, contentType: "image/png" });
    });

    it("fetches again once the hours it is kept for have passed", async () => {
        const start = Date.now();
        const now = jest.spyOn(Date, "now").mockReturnValue(start);
        await externalCoverPicture(URL_A, null);

        now.mockReturnValue(start + EXTERNAL_COVER_CACHE.ttlMs - 1000);
        await externalCoverPicture(URL_A, null);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        now.mockReturnValue(start + EXTERNAL_COVER_CACHE.ttlMs + 1000);
        await externalCoverPicture(URL_A, null);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(EXTERNAL_COVER_CACHE.ttlMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
    });

    it("remembers a failed address for a few minutes, at any width, so a page of dead covers is not fetched again each visit", async () => {
        const start = Date.now();
        const now = jest.spyOn(Date, "now").mockReturnValue(start);
        fetchMock.mockResolvedValue(null);

        expect(await externalCoverPicture(URL_A, null)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        now.mockReturnValue(start + EXTERNAL_COVER_CACHE.failureMs - 1000);
        expect(await externalCoverPicture(URL_A, null)).toBeNull();
        expect(await externalCoverPicture(URL_A, 300)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Another address is its own question.
        fetchMock.mockResolvedValue({ bytes: original, contentType: "image/jpeg" });
        expect(await externalCoverPicture("https://img.example/b.jpg", null)).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("tries a failed address again once its few minutes have passed, and keeps the picture if the site answers now", async () => {
        const start = Date.now();
        const now = jest.spyOn(Date, "now").mockReturnValue(start);
        fetchMock.mockResolvedValueOnce(null);
        expect(await externalCoverPicture(URL_A, null)).toBeNull();

        expect(EXTERNAL_COVER_CACHE.failureMs).toBeLessThanOrEqual(10 * 60 * 1000);
        expect(EXTERNAL_COVER_CACHE.failureMs).toBeGreaterThanOrEqual(60 * 1000);
        now.mockReturnValue(start + EXTERNAL_COVER_CACHE.failureMs + 1000);
        expect(await externalCoverPicture(URL_A, null)).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await externalCoverPicture(URL_A, null);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("remembers no more failed addresses than its bound, forgetting the oldest first", async () => {
        const n = EXTERNAL_COVER_CACHE.maxFailures;
        fetchMock.mockResolvedValue(null);
        for (let i = 0; i < n + 1; i++) await externalCoverPicture(`https://img.example/dead${i}.jpg`, null);
        expect(fetchMock).toHaveBeenCalledTimes(n + 1);

        await externalCoverPicture(`https://img.example/dead${n}.jpg`, null); // the newest is still remembered
        expect(fetchMock).toHaveBeenCalledTimes(n + 1);
        await externalCoverPicture("https://img.example/dead0.jpg", null); // the oldest is not
        expect(fetchMock).toHaveBeenCalledTimes(n + 2);
    });

    it("lets requests that arrive together share one fetch", async () => {
        const [a, b, c] = await Promise.all([externalCoverPicture(URL_A, null), externalCoverPicture(URL_A, null), externalCoverPicture(URL_A, null)]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(b).toEqual(a);
        expect(c).toEqual(a);
    });

    it("keeps no more than its bound of pictures, dropping the oldest first", async () => {
        const n = EXTERNAL_COVER_CACHE.maxEntries;
        fetchMock.mockImplementation(async () => ({ bytes: Buffer.from("x"), contentType: "image/png" }));
        for (let i = 0; i < n + 1; i++) await externalCoverPicture(`https://img.example/${i}.jpg`, null);
        expect(fetchMock).toHaveBeenCalledTimes(n + 1);

        await externalCoverPicture(`https://img.example/${n}.jpg`, null); // the newest is still there
        expect(fetchMock).toHaveBeenCalledTimes(n + 1);
        await externalCoverPicture("https://img.example/0.jpg", null); // the oldest is not
        expect(fetchMock).toHaveBeenCalledTimes(n + 2);
    });

    it("keeps no more than its bound of bytes, and does not keep one picture bigger than a share of it", async () => {
        const { maxBytes, maxEntryBytes } = EXTERNAL_COVER_CACHE;
        expect(maxEntryBytes).toBeLessThan(maxBytes);

        fetchMock.mockImplementation(async () => ({ bytes: Buffer.alloc(maxEntryBytes + 1), contentType: "image/png" }));
        await externalCoverPicture(URL_A, null);
        await externalCoverPicture(URL_A, null);
        expect(fetchMock).toHaveBeenCalledTimes(2); // too big to keep, though served

        fetchMock.mockReset();
        fetchMock.mockImplementation(async () => ({ bytes: Buffer.alloc(maxEntryBytes), contentType: "image/png" }));
        const fits = Math.floor(maxBytes / maxEntryBytes);
        for (let i = 0; i < fits + 2; i++) await externalCoverPicture(`https://img.example/big${i}.jpg`, null);
        await externalCoverPicture("https://img.example/big0.jpg", null); // dropped to make room
        expect(fetchMock).toHaveBeenCalledTimes(fits + 3);
        await externalCoverPicture(`https://img.example/big${fits + 1}.jpg`, null); // the newest stays
        expect(fetchMock).toHaveBeenCalledTimes(fits + 3);
    });
});
