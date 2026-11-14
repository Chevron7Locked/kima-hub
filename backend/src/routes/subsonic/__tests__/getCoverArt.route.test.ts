/**
 * getCoverArt.view scales a stored cover to the `size` an app asks for, as the Subsonic spec says, with the width limits
 * the web cover route uses and the same stored-copy rules (a copy older than its cover is made again). Asked without a
 * `size` it answers exactly as it always did: the stored file, whole, with its long cache lifetime. A stored cover that
 * vanished between the check and the send is the standard not-found. Real files in a temporary covers folder, real
 * router and database.
 */

const COVERS_PARENT = require("path").join(require("os").tmpdir(), `kima-subsonic-cover-${process.pid}`);
jest.mock("../../../config", () => ({
    ...jest.requireActual("../../../config"),
    config: {
        ...jest.requireActual("../../../config").config,
        music: { ...jest.requireActual("../../../config").config.music, transcodeCachePath: require("path").join(COVERS_PARENT, "transcodes") },
    },
}));

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { playbackRouter } from "../playback";
import { prisma } from "../../../utils/db";

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

beforeEach(() => {
    for (const f of fs.readdirSync(ALBUMS)) fs.rmSync(path.join(ALBUMS, f), { force: true });
    fs.writeFileSync(path.join(ALBUMS, `${P}-al.jpg`), original);
});

afterEach(() => jest.restoreAllMocks());

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
        await prisma.album.update({ where: { id: `${P}-al` }, data: { coverUrl: `native:albums/${P}-al.jpg` } });
    });
});
