/**
 * The cover-art route takes a picture's address exactly as the client sent it: Express decodes the query and the path
 * once, and a second decode turned a "%25" in an address into "%" (another file) and a lone "%" into a 500. A stored
 * cover is served from the covers folder in either form with the same headers, a path outside the folder is refused,
 * and a stored cover whose file is gone is looked up again. Real files in a temporary covers folder; the network fetch
 * and the artwork sources are stood in for.
 */
const COVERS_PARENT = require("path").join(require("os").tmpdir(), `kima-cover-addr-${process.pid}`);
jest.mock("../../config", () => ({
    ...jest.requireActual("../../config"),
    config: { ...jest.requireActual("../../config").config, music: { transcodeCachePath: require("path").join(COVERS_PARENT, "transcodes") } },
}));
jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue("OK") },
}));
const mockFetchChecked = jest.fn();
jest.mock("../../utils/ssrf", () => ({
    ...jest.requireActual("../../utils/ssrf"),
    fetchChecked: (...a: unknown[]) => mockFetchChecked(...a),
}));
const mockSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({ getSystemSettings: async () => mockSettings() }));
const mockFindAlbumArtwork = jest.fn();
jest.mock("../../services/artwork", () => ({ findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a) }));

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import libraryCoverArtRoutes from "../library/coverArt";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const app = mountAsServer(express(), "/library", libraryCoverArtRoutes, "/api/library", { standIn: true });
const COVERS = path.join(COVERS_PARENT, "covers");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const picture = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
const OVER_CAP = String(20 * 1024 * 1024 + 1);
const P = "cvaddr";

beforeAll(async () => {
    fs.mkdirSync(COVERS, { recursive: true });
    fs.writeFileSync(path.join(COVERS, `${P}_stored.jpg`), JPEG);
    await prisma.artist.create({ data: { id: `${P}_art`, name: "Cover Artist", identityKey: `${P}_ik` } });
    await prisma.album.create({ data: { id: `${P}_gone`, rgMbid: `${P}_rg`, artistId: `${P}_art`, title: "Lost Cover", primaryType: "Album", coverUrl: `native:${P}_gone.jpg` } });
});

beforeEach(() => {
    mockFetchChecked.mockReset().mockImplementation(async () => picture());
    mockFindAlbumArtwork.mockReset().mockResolvedValue(null);
    mockSettings.mockReset().mockResolvedValue({ audiobookshelfUrl: "http://abs.test:13378/abs", audiobookshelfApiKey: "abs-key" });
});

afterAll(async () => {
    fs.rmSync(COVERS_PARENT, { recursive: true, force: true });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.$disconnect();
});

const fetchedAddress = () => mockFetchChecked.mock.calls[0][0];

describe("a picture's address", () => {
    it.each([
        ["an escaped percent sign", "https://covers.example.org/100%25.jpg"],
        ["a lone percent sign", "https://covers.example.org/50%off.jpg"],
        ["an escaped slash", "https://covers.example.org/a%2Fb.jpg"],
    ])("is fetched as sent, with %s, by query", async (_what, address) => {
        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(address)}`);
        expect(res.status).toBe(200);
        expect(fetchedAddress()).toBe(address);
    });

    it("is fetched as sent by path too", async () => {
        const address = "https://covers.example.org/100%25.jpg";
        const res = await request(app).get(`/library/cover-art/${encodeURIComponent(address)}`);
        expect(res.status).toBe(200);
        expect(fetchedAddress()).toBe(address);
    });

    it("given twice is refused, not a server error", async () => {
        const res = await request(app).get("/library/cover-art?url=https://a.example/1.jpg&url=https://a.example/2.jpg");
        expect(res.status).toBe(400);
        expect(mockFetchChecked).not.toHaveBeenCalled();
    });

    it("over the size cap is a 404, never sent on", async () => {
        expectLog("warn");
        mockFetchChecked.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png", "content-length": OVER_CAP } }));
        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent("https://covers.example.org/huge.png")}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });
    });

    it.each(["text/html", "application/json"])("that the host calls %s is a 404, not served as a picture", async (type) => {
        expectLog("warn");
        mockFetchChecked.mockResolvedValue(new Response("<html>", { status: 200, headers: { "content-type": type } }));
        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent("https://covers.example.org/page")}`);
        expect(res.status).toBe(404);
    });

    it("comes back with the picture's type and the cover headers", async () => {
        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent("https://covers.example.org/a.png")}`).set("Origin", "https://app.example");
        expect(res.headers).toMatchObject({
            "content-type": "image/png",
            "access-control-allow-origin": "https://app.example",
            "access-control-allow-credentials": "true",
            "cross-origin-resource-policy": "cross-origin",
            "cache-control": "public, max-age=31536000, immutable",
            etag: expect.any(String),
        });
    });
});

describe("a stored cover", () => {
    it.each([
        ["by query", `/library/cover-art?url=${encodeURIComponent(`native:${P}_stored.jpg`)}`],
        ["by path", `/library/cover-art/${encodeURIComponent(`native:${P}_stored.jpg`)}`],
    ])("is served from the covers folder %s with the cover headers", async (_how, url) => {
        const res = await request(app).get(url);
        expect(res.status).toBe(200);
        expect(Buffer.from(res.body)).toEqual(JPEG);
        expect(res.headers).toMatchObject({
            "content-type": "image/jpeg",
            "access-control-allow-origin": "*",
            "cross-origin-resource-policy": "cross-origin",
            "cache-control": "public, no-cache",
            etag: expect.any(String),
            "last-modified": expect.any(String),
        });
    });

    it.each([
        ["by query", `/library/cover-art?url=${encodeURIComponent(`native:${P}_stored.jpg?v=abc123def0`)}`],
        ["by path", `/library/cover-art/${encodeURIComponent(`native:${P}_stored.jpg?v=abc123def0`)}`],
    ])("with a version is found without it and kept for good %s", async (_how, url) => {
        const res = await request(app).get(url);
        expect(res.status).toBe(200);
        expect(Buffer.from(res.body)).toEqual(JPEG);
        expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    });

    it("with a version, at a width, is the smaller copy of the same file, kept for good", async () => {
        const sharp = (await import("sharp")).default;
        const big = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#369" } }).jpeg().toBuffer();
        fs.writeFileSync(path.join(COVERS, `${P}_wide.jpg`), big);
        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(`native:${P}_wide.jpg?v=abc123def0`)}&size=100`);
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        expect((await sharp(Buffer.from(res.body)).metadata()).width).toBe(100);
    });

    it("without a version is revalidated, so a changed cover is sent again and an unchanged one is not", async () => {
        const file = path.join(COVERS, `${P}_revalidate.jpg`);
        fs.writeFileSync(file, JPEG);
        const url = `/library/cover-art?url=${encodeURIComponent(`native:${P}_revalidate.jpg`)}`;

        const first = await request(app).get(url);
        expect(first.headers["cache-control"]).not.toContain("immutable");

        const unchanged = await request(app).get(url).set("If-None-Match", first.headers.etag);
        expect(unchanged.status).toBe(304);

        const changed = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xd9]);
        fs.writeFileSync(file, changed);
        const after = await request(app).get(url).set("If-None-Match", first.headers.etag);
        expect(after.status).toBe(200);
        expect(Buffer.from(after.body)).toEqual(changed);
    });

    it.each(["by query", "by path"])("outside the covers folder is refused %s", async (how) => {
        const id = encodeURIComponent("native:../../etc/passwd");
        const res = await request(app).get(how === "by query" ? `/library/cover-art?url=${id}` : `/library/cover-art/${id}`);
        expect(res.status).toBe(400);
    });

    // Served through Kima, never a redirect off-site: the web app's service worker may only fetch Kima itself.
    it.each(["by query", "by path"])("whose file is gone is looked up again, remembered and served %s", async (how) => {
        expectLog("warn");
        await prisma.album.update({ where: { id: `${P}_gone` }, data: { coverUrl: `native:${P}_gone.jpg` } });
        mockFindAlbumArtwork.mockResolvedValue({ url: "https://covers.example.org/found.jpg", source: "deezer" });
        mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array(JPEG), { status: 200, headers: { "content-type": "image/jpeg" } }));
        const id = encodeURIComponent(`native:${P}_gone.jpg`);

        const res = await request(app).get(how === "by query" ? `/library/cover-art?url=${id}` : `/library/cover-art/${id}`);

        expect(res.status).toBe(200);
        expect(Buffer.from(res.body)).toEqual(JPEG);
        expect(mockFetchChecked).toHaveBeenCalledWith("https://covers.example.org/found.jpg", expect.anything());
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_gone` } })).coverUrl).toBe("https://covers.example.org/found.jpg");
    });

    it("under the albums folder, whose file is gone, is looked up again too", async () => {
        expectLog("warn");
        await prisma.album.update({ where: { id: `${P}_gone` }, data: { coverUrl: `native:albums/${P}_gone.jpg?v=abc123def0` } });
        mockFindAlbumArtwork.mockResolvedValue({ url: "https://covers.example.org/found.jpg", source: "deezer" });
        mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array(JPEG), { status: 200, headers: { "content-type": "image/jpeg" } }));

        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(`native:albums/${P}_gone.jpg?v=abc123def0`)}`);

        expect(res.status).toBe(200);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_gone` } })).coverUrl).toBe("https://covers.example.org/found.jpg");
    });

    it("with a version, whose file is gone, is remembered on the album that holds that versioned address", async () => {
        expectLog("warn");
        await prisma.album.update({ where: { id: `${P}_gone` }, data: { coverUrl: `native:${P}_gone.jpg?v=abc123def0` } });
        mockFindAlbumArtwork.mockResolvedValue({ url: "https://covers.example.org/found.jpg", source: "deezer" });
        mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array(JPEG), { status: 200, headers: { "content-type": "image/jpeg" } }));

        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(`native:${P}_gone.jpg?v=abc123def0`)}`);

        expect(res.status).toBe(200);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_gone` } })).coverUrl).toBe("https://covers.example.org/found.jpg");
    });

    it("with a version, whose file is gone, is remembered on the album holding another version of the same file", async () => {
        expectLog("warn");
        await prisma.album.update({ where: { id: `${P}_gone` }, data: { coverUrl: `native:${P}_gone.jpg?v=0000000000` } });
        mockFindAlbumArtwork.mockResolvedValue({ url: "https://covers.example.org/found.jpg", source: "deezer" });
        mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array(JPEG), { status: 200, headers: { "content-type": "image/jpeg" } }));

        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(`native:${P}_gone.jpg?v=abc123def0`)}`);

        expect(res.status).toBe(200);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_gone` } })).coverUrl).toBe("https://covers.example.org/found.jpg");
    });

    it("whose file is gone is not written onto an album that does not use it", async () => {
        expectLog("warn");
        await prisma.album.update({ where: { id: `${P}_gone` }, data: { coverUrl: "https://covers.example.org/own.jpg" } });
        mockFindAlbumArtwork.mockResolvedValue({ url: "https://covers.example.org/found.jpg", source: "deezer" });

        mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array(JPEG), { status: 200, headers: { "content-type": "image/jpeg" } }));
        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(`native:${P}_gone.jpg`)}`);

        expect(res.status).toBe(200);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_gone` } })).coverUrl).toBe("https://covers.example.org/own.jpg");
    });

    // The file is there when the route looks and gone when it sends (a sweep or a replaced volume between the two).
    it.each(["", "&size=300"])("deleted between the check and the send is the route's own 404%s", async (size) => {
        const vanished = path.join(COVERS, `${P}_vanished.jpg`);
        const real = fs.existsSync;
        jest.spyOn(fs, "existsSync").mockImplementation((p) => (String(p) === vanished ? true : real(p)));

        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(`native:${P}_vanished.jpg`)}${size}`);
        jest.restoreAllMocks();

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Cover art not found" });
    });

    it("whose file is gone and found nowhere is a 404", async () => {
        expectLog("warn");
        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent("native:nothing-here.jpg")}`);
        expect(res.status).toBe(404);
    });
});

describe("an audiobook cover", () => {
    const absFetch = () => jest.spyOn(global, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } }));
    afterEach(() => jest.restoreAllMocks());
    const ask = (id: string) => request(app).get(`/library/cover-art?url=${encodeURIComponent(`audiobook__${id}`)}`);

    it("is fetched from Audiobookshelf's api folder with its key", async () => {
        const fetchSpy = absFetch();
        expect((await ask("items/li_1/cover")).status).toBe(200);
        expect(String(fetchSpy.mock.calls[0][0])).toBe("http://abs.test:13378/abs/api/items/li_1/cover");
    });

    it.each([
        "../users", "%2e%2e/users", "%2E%2e/%2e%2e/admin", "items/../../users", "http://evil.test/x", "//evil.test/x",
        "users", "me", "libraries", "items/li_1", "items/li_1/cover?token=x", "items/li_1/cover/../../../users",
        "items/%2e%2e%2fusers/cover", "items/li_1\\cover",
    ])(
        "other than a book's cover (%p) is refused before anything is sent",
        async (id) => {
            const fetchSpy = absFetch();
            expect((await ask(id)).status).toBe(400);
            expect(fetchSpy).not.toHaveBeenCalled();
        },
    );

    it("over the size cap is a 404, not sent on", async () => {
        expectLog("warn");
        jest.spyOn(global, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg", "content-length": OVER_CAP } }));
        expect((await ask("items/li_1/cover")).status).toBe(404);
    });

    it("that Audiobookshelf calls something other than an image is a 404", async () => {
        expectLog("warn");
        jest.spyOn(global, "fetch").mockResolvedValue(new Response("<html>", { headers: { "content-type": "text/html" } }));
        expect((await ask("items/li_1/cover")).status).toBe(404);
    });

    it("without Audiobookshelf set up is a 404", async () => {
        const fetchSpy = absFetch();
        mockSettings.mockResolvedValue({});
        expect((await ask("items/li_1/cover")).status).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
