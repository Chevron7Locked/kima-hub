/**
 * getCoverArt.view scales a stored cover to the `size` an app asks for, as the Subsonic spec says, with the width limits
 * the web cover route uses and the same stored-copy rules (a copy older than its cover is made again). Asked without a
 * `size` it answers the stored file, whole. The id may carry the cover's version (`<id>_<version>`): it is stripped to find
 * the cover, and a version that is still the stored one earns the long immutable cache lifetime, while a plain or older id
 * gets a short one. A cover held at another site is fetched capped (images only), scaled to `size` and served, never
 * redirected to. A stored cover that vanished between the check and the send is the standard not-found. Real files in a
 * temporary covers folder, real router and database; the outside fetch is faked.
 */

const COVERS_PARENT = require("path").join(require("os").tmpdir(), `kima-subsonic-cover-${process.pid}`);
jest.mock("../../../config", () => ({
    ...jest.requireActual("../../../config"),
    config: {
        ...jest.requireActual("../../../config").config,
        music: { ...jest.requireActual("../../../config").config.music, transcodeCachePath: require("path").join(COVERS_PARENT, "transcodes") },
    },
}));

jest.mock("../../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { playbackRouter } from "../playback";
import { prisma } from "../../../utils/db";
import { fetchChecked } from "../../../utils/ssrf";
import { MAX_PICTURE_BYTES } from "../../../services/imageStorage";
import { clearExternalCoverCache } from "../../../services/externalCoverCache";
import { expectLog } from "../../../__tests__/helpers/expectedLogs";

const P = "zz-sub-cover";
const COVERS = path.join(COVERS_PARENT, "covers");
const ALBUMS = path.join(COVERS, "albums");

const app = express();
app.use((req: any, _res, next) => {
    req.user = { id: `${P}-user`, username: `${P}-user`, role: "user" };
    next();
});
app.use("/rest", playbackRouter);

/** A noisy 600 px wide picture, so a smaller copy is visibly different bytes. */
async function wide(): Promise<Buffer> {
    const noise = Buffer.alloc(600 * 400 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
    return sharp(noise, { raw: { width: 600, height: 400, channels: 3 } }).jpeg().toBuffer();
}
const widthOf = async (bytes: Buffer) => (await sharp(bytes).metadata()).width;
const bytesOf = (res: request.Response) => Buffer.from(res.body);

let original: Buffer;

beforeAll(async () => {
    original = await wide();
    fs.mkdirSync(ALBUMS, { recursive: true });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    await prisma.album.create({
        data: { id: `${P}-al`, rgMbid: `${P}-rg`, artistId: `${P}-ar`, identityKey: `${P}-al`, title: P, primaryType: "Album", location: "LIBRARY", coverUrl: `native:albums/${P}-al.jpg` },
    });
});

const setAlbumCover = (coverUrl: string) => prisma.album.update({ where: { id: `${P}-al` }, data: { coverUrl } });
const STORED = `native:albums/${P}-al.jpg`;

beforeEach(async () => {
    for (const f of fs.readdirSync(ALBUMS)) fs.rmSync(path.join(ALBUMS, f), { force: true });
    fs.writeFileSync(path.join(ALBUMS, `${P}-al.jpg`), original);
    await setAlbumCover(STORED);
});

afterEach(() => {
    jest.restoreAllMocks();
    (fetchChecked as jest.Mock).mockReset();
});

afterAll(async () => {
    fs.rmSync(COVERS_PARENT, { recursive: true, force: true });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
});

describe("getCoverArt for a stored cover", () => {
    it("without a size answers the stored file whole, as it always did", async () => {
        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al`);

        expect(res.status).toBe(200);
        expect(bytesOf(res).equals(original)).toBe(true);
        expect(res.headers).toMatchObject({
            "content-type": "image/jpeg",
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
        });
        expect(fs.readdirSync(ALBUMS)).toEqual([`${P}-al.jpg`]);
    });

    it("with a size scales the picture to that width and keeps the smaller copy beside the cover", async () => {
        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=300`);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("image/jpeg");
        expect(await widthOf(bytesOf(res))).toBe(300);
        expect(fs.existsSync(path.join(ALBUMS, `${P}-al_w300.jpg`))).toBe(true);
    });

    it("with a size at least as wide as the picture answers the picture itself", async () => {
        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=800`);

        expect(bytesOf(res).equals(original)).toBe(true);
        expect(fs.readdirSync(ALBUMS)).toEqual([`${P}-al.jpg`]);
    });

    it.each(["5", "5000", "abc", "0", "-300"])("with a size outside the web route's limits (%s) answers the whole picture", async (size) => {
        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=${size}`);

        expect(res.status).toBe(200);
        expect(bytesOf(res).equals(original)).toBe(true);
        expect(fs.readdirSync(ALBUMS)).toEqual([`${P}-al.jpg`]);
    });

    it("makes a smaller copy again when the cover is newer than the copy", async () => {
        const stale = path.join(ALBUMS, `${P}-al_w300.jpg`);
        fs.writeFileSync(stale, await sharp({ create: { width: 300, height: 200, channels: 3, background: "red" } }).jpeg().toBuffer());
        const past = new Date(Date.now() - 3_600_000);
        fs.utimesSync(stale, past, past);

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=300`);

        const fresh = await sharp(bytesOf(res)).stats();
        expect(fresh.dominant).not.toEqual({ r: 255, g: 0, b: 0 });
        expect(fs.statSync(stale).mtimeMs).toBeGreaterThan(past.getTime());
    });

    it.each(["", "&size=300"])("deleted between the check and the send is the not-found answer%s", async (size) => {
        const gone = path.join(ALBUMS, `${P}-vanished.jpg`);
        await prisma.album.update({ where: { id: `${P}-al` }, data: { coverUrl: "native:albums/zz-sub-cover-vanished.jpg" } });
        const real = fs.existsSync;
        jest.spyOn(fs, "existsSync").mockImplementation((p) => (String(p) === gone ? true : real(p)));

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json${size}`);

        expect(res.status).toBe(200);
        expect(res.body["subsonic-response"]).toMatchObject({ status: "failed", error: { code: 70 } });
    });
});

describe("getCoverArt for a versioned id", () => {
    const V = "abcdef0123";
    const IMMUTABLE = "public, max-age=31536000, immutable";

    it("finds the cover without the version and answers with a year's immutable cache when it is the stored version", async () => {
        await setAlbumCover(`${STORED}?v=${V}`);

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al_${V}`);

        expect(res.status).toBe(200);
        expect(bytesOf(res).equals(original)).toBe(true);
        expect(res.headers["cache-control"]).toBe(IMMUTABLE);
    });

    it("takes the album prefix some apps add before the version", async () => {
        await setAlbumCover(`${STORED}?v=${V}`);

        const res = await request(app).get(`/rest/getCoverArt.view?id=al-${P}-al_${V}`);

        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe(IMMUTABLE);
    });

    it("scales a versioned cover to the size asked, keeping the smaller copy beside the file", async () => {
        await setAlbumCover(`${STORED}?v=${V}`);

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al_${V}&size=300`);

        expect(await widthOf(bytesOf(res))).toBe(300);
        expect(res.headers["cache-control"]).toBe(IMMUTABLE);
        expect(fs.existsSync(path.join(ALBUMS, `${P}-al_w300.jpg`))).toBe(true);
    });

    it("answers an older version of the id with the cover as it is now, for a day only", async () => {
        await setAlbumCover(`${STORED}?v=${V}`);

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al_0123456789`);

        expect(res.status).toBe(200);
        expect(bytesOf(res).equals(original)).toBe(true);
        expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    });

    it("still answers an unversioned id for a versioned cover, for a day", async () => {
        await setAlbumCover(`${STORED}?v=${V}`);

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al`);

        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    });

    it("answers a versioned id for an unversioned stored cover for a day", async () => {
        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al_${V}`);

        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    });

    it("finds an artist's picture by its versioned id", async () => {
        fs.mkdirSync(path.join(COVERS, "artists"), { recursive: true });
        fs.writeFileSync(path.join(COVERS, "artists", `${P}-ar.jpg`), original);
        await prisma.artist.update({ where: { id: `${P}-ar` }, data: { heroUrl: `native:artists/${P}-ar.jpg?v=${V}` } });

        const res = await request(app).get(`/rest/getCoverArt.view?id=ar-${P}-ar_${V}`);

        expect(res.status).toBe(200);
        expect(bytesOf(res).equals(original)).toBe(true);
        expect(res.headers["cache-control"]).toBe(IMMUTABLE);
        await prisma.artist.update({ where: { id: `${P}-ar` }, data: { heroUrl: null } });
    });

    it("answers not-found for a versioned id of nothing", async () => {
        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-nothing_${V}&f=json`);

        expect(res.body["subsonic-response"]).toMatchObject({ status: "failed", error: { code: 70 } });
    });
});

describe("getCoverArt for a cover at an outside address", () => {
    const OUTSIDE = "https://img.example/cover.jpg";
    const reply = (body: string | Uint8Array, init: { status?: number; headers?: Record<string, string> } = {}) =>
        (fetchChecked as jest.Mock).mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "image/jpeg" }, ...init }));
    const notFound = (res: request.Response) => expect(res.body["subsonic-response"]).toMatchObject({ status: "failed", error: { code: 70 } });

    beforeEach(async () => {
        clearExternalCoverCache();
        await setAlbumCover(OUTSIDE);
    });

    it("fetches the picture once for the same address and size, however many apps and pages ask", async () => {
        reply(new Uint8Array(original));

        const first = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=300`);
        const second = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=300`);

        expect(second.status).toBe(200);
        expect(bytesOf(second).equals(bytesOf(first))).toBe(true);
        expect(await widthOf(bytesOf(second))).toBe(300);
        expect(fetchChecked).toHaveBeenCalledTimes(1);
    });

    it("fetches again for another size, since that is another picture", async () => {
        (fetchChecked as jest.Mock).mockImplementation(async () => new Response(new Uint8Array(original), { status: 200, headers: { "content-type": "image/jpeg" } }));

        await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=300`);
        await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=100`);

        expect(fetchChecked).toHaveBeenCalledTimes(2);
    });

    it("does not keep a failure", async () => {
        expectLog("warn");
        (fetchChecked as jest.Mock).mockRejectedValueOnce(new Error("refused"));
        reply(new Uint8Array(original));

        notFound(await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`));
        const retry = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`);

        expect(retry.status).toBe(200);
    });

    it("serves the picture itself instead of redirecting", async () => {
        reply(new Uint8Array(original));

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al`);

        expect(res.status).toBe(200);
        expect(res.headers.location).toBeUndefined();
        expect(bytesOf(res).equals(original)).toBe(true);
        expect(res.headers).toMatchObject({ "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" });
        expect((fetchChecked as jest.Mock).mock.calls[0][0]).toBe(OUTSIDE);
    });

    it("scales it to the size asked", async () => {
        reply(new Uint8Array(original));

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=300`);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe("image/jpeg");
        expect(await widthOf(bytesOf(res))).toBe(300);
    });

    it("answers the whole picture for a size outside the limits", async () => {
        reply(new Uint8Array(original));

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&size=5000`);

        expect(bytesOf(res).equals(original)).toBe(true);
    });

    it("is not-found when the reply is over the size cap", async () => {
        expectLog("warn");
        reply(new Uint8Array(original), { headers: { "content-type": "image/jpeg", "content-length": String(MAX_PICTURE_BYTES + 1) } });

        notFound(await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`));
    });

    it("is not-found when the reply is no image", async () => {
        expectLog("warn");
        reply("<html></html>", { headers: { "content-type": "text/html" } });

        notFound(await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`));
    });

    it("is not-found when the site answers with an error", async () => {
        reply("gone", { status: 404 });

        notFound(await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`));
    });

    it("is not-found when the site cannot be reached or is refused", async () => {
        expectLog("warn");
        (fetchChecked as jest.Mock).mockRejectedValue(new Error("refused"));

        notFound(await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`));
    });

    it("is not-found when the site names an SVG, which would run script under Kima's address", async () => {
        expectLog("warn");
        reply("<svg xmlns='http://www.w3.org/2000/svg'/>", { headers: { "content-type": "image/svg+xml" } });

        notFound(await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`));
    });
});

describe("getCoverArt for a cover value that is neither a stored cover nor an outside address", () => {
    it.each(["audiobook__zz", "ftp://host/cover.jpg", "javascript:alert(1)"])("is not-found for %p, never a redirect", async (value) => {
        await setAlbumCover(value);

        const res = await request(app).get(`/rest/getCoverArt.view?id=${P}-al&f=json`);

        expect(res.headers.location).toBeUndefined();
        expect(res.body["subsonic-response"]).toMatchObject({ status: "failed", error: { code: 70 } });
    });
});
