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
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
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

const app = express().use("/library", libraryCoverArtRoutes);
const COVERS = path.join(COVERS_PARENT, "covers");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const picture = () => ({ ok: true, status: 200, statusText: "OK", headers: new Headers({ "content-type": "image/png" }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
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
            "cache-control": "public, max-age=31536000, immutable",
        });
    });

    it.each(["by query", "by path"])("outside the covers folder is refused %s", async (how) => {
        const id = encodeURIComponent("native:../../etc/passwd");
        const res = await request(app).get(how === "by query" ? `/library/cover-art?url=${id}` : `/library/cover-art/${id}`);
        expect(res.status).toBe(400);
    });

    it.each(["by query", "by path"])("whose file is gone is looked up again and remembered %s", async (how) => {
        await prisma.album.update({ where: { id: `${P}_gone` }, data: { coverUrl: `native:${P}_gone.jpg` } });
        mockFindAlbumArtwork.mockResolvedValue({ url: "https://covers.example.org/found.jpg", source: "deezer" });
        const id = encodeURIComponent(`native:${P}_gone.jpg`);

        const res = await request(app).get(how === "by query" ? `/library/cover-art?url=${id}` : `/library/cover-art/${id}`);

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe("https://covers.example.org/found.jpg");
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_gone` } })).coverUrl).toBe("https://covers.example.org/found.jpg");
    });

    it("whose file is gone is not written onto an album that does not use it", async () => {
        await prisma.album.update({ where: { id: `${P}_gone` }, data: { coverUrl: "https://covers.example.org/own.jpg" } });
        mockFindAlbumArtwork.mockResolvedValue({ url: "https://covers.example.org/found.jpg", source: "deezer" });

        const res = await request(app).get(`/library/cover-art?url=${encodeURIComponent(`native:${P}_gone.jpg`)}`);

        expect(res.status).toBe(302);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}_gone` } })).coverUrl).toBe("https://covers.example.org/own.jpg");
    });

    it("whose file is gone and found nowhere is a 404", async () => {
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

    it("without Audiobookshelf set up is a 404", async () => {
        const fetchSpy = absFetch();
        mockSettings.mockResolvedValue({});
        expect((await ask("items/li_1/cover")).status).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
