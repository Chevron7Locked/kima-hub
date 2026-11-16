/**
 * The admin delete routes commit the database delete first and remove files after it: a delete that fails leaves the
 * files, and a file that will not go is logged and never leaves rows without files. Real database and real files, in a
 * temporary music root; the album-delete module is made to fail, or the file system to refuse, only where the test says.
 */

jest.mock("../../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "dord_admin", role: "admin" };
        next();
    };
    return { requireAuth: signIn, requireAdmin: signIn, requireAuthOrToken: signIn };
});
jest.mock("../../../config", () => ({
    config: {
        music: { musicPath: require("path").join(require("os").tmpdir(), `kima-dord-music-${process.pid}`) },
        redisUrl: process.env.REDIS_URL,
    },
}));

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "../../../utils/db";
import { config } from "../../../config";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import * as albumDelete from "../../../services/library/albumDelete";
import tracksRoutes from "../tracks";
import albumsRoutes from "../albums";
import artistsRoutes from "../artists";
import { expectLog } from "../../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "../../__tests__/helpers/serverMount";

const P = "dord";
const MUSIC = path.resolve(config.music.musicPath);
const FILE = "Band/Record/01.flac";
const onDisk = path.join(MUSIC, FILE);

const app = express();
app.use(express.json());
mountAsServer(app, "/", tracksRoutes, "/api/library");
mountAsServer(app, "/", albumsRoutes, "/api/library");
mountAsServer(app, "/", artistsRoutes, "/api/library");

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(onDisk), { recursive: true });
    fs.writeFileSync(onDisk, "x");
    await prisma.artist.create({ data: { id: `${P}_artist`, name: "Band", identityKey: `${P}_ik` } });
    await prisma.album.create({ data: { id: `${P}_album`, rgMbid: `${P}_rg`, artistId: `${P}_artist`, title: "Record", primaryType: "Album", location: "LIBRARY" } });
    await prisma.track.create({
        data: { id: `${P}_song`, albumId: `${P}_album`, title: `${P} song`, trackNo: 1, duration: 100, filePath: FILE, fileModified: new Date(), fileSize: 10 },
    });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    await closeEngineConnections();
    await prisma.$disconnect();
});

const rowsLeft = async () => ({
    songs: await prisma.track.count({ where: { id: `${P}_song` } }),
    albums: await prisma.album.count({ where: { id: `${P}_album` } }),
    artists: await prisma.artist.count({ where: { id: `${P}_artist` } }),
});

describe("a delete that fails leaves the files", () => {
    it("a song", async () => {
        expectLog("error");
        jest.spyOn(albumDelete, "deleteSongs").mockRejectedValue(new Error("database down"));

        const res = await request(app).delete(`/tracks/${P}_song`);

        expect(res.status).toBe(500);
        expect(fs.existsSync(onDisk)).toBe(true);
        expect((await rowsLeft()).songs).toBe(1);
    });

    it("an album", async () => {
        expectLog("error");
        jest.spyOn(albumDelete, "deleteAlbums").mockRejectedValue(new Error("database down"));

        const res = await request(app).delete(`/albums/${P}_album`);

        expect(res.status).toBe(500);
        expect(fs.existsSync(onDisk)).toBe(true);
        expect((await rowsLeft()).albums).toBe(1);
    });

    it("an artist", async () => {
        expectLog("error");
        jest.spyOn(albumDelete, "deleteArtists").mockRejectedValue(new Error("database down"));

        const res = await request(app).delete(`/artists/${P}_artist`);

        expect(res.status).toBe(500);
        expect(fs.existsSync(onDisk)).toBe(true);
        expect((await rowsLeft()).artists).toBe(1);
    });
});

describe("a file that will not go is logged and never undoes the delete", () => {
    const refuse = () =>
        jest.spyOn(fs, "unlinkSync").mockImplementation(() => {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        });

    it("a song", async () => {
        expectLog("warn");
        refuse();

        const res = await request(app).delete(`/tracks/${P}_song`);

        expect(res.status).toBe(200);
        expect((await rowsLeft()).songs).toBe(0);
    });

    it("an album", async () => {
        expectLog("warn");
        refuse();

        const res = await request(app).delete(`/albums/${P}_album`);

        expect(res.status).toBe(200);
        expect(res.body.deletedFiles).toBe(0);
        expect((await rowsLeft()).albums).toBe(0);
    });

    it("an artist", async () => {
        expectLog("warn");
        refuse();

        const res = await request(app).delete(`/artists/${P}_artist`);

        expect(res.status).toBe(200);
        expect((await rowsLeft()).artists).toBe(0);
    });
});

describe("a delete that works", () => {
    it("removes the song's file, and the album and its share link when it was the last song", async () => {
        const user = await prisma.user.upsert({ where: { username: `${P}_user` }, create: { username: `${P}_user`, passwordHash: "x" }, update: {} });
        await prisma.shareLink.create({ data: { token: `${P}_tok`, entityType: "album", entityId: `${P}_album`, createdBy: user.id } });

        const res = await request(app).delete(`/tracks/${P}_song`);

        expect(res.status).toBe(200);
        expect(fs.existsSync(onDisk)).toBe(false);
        expect(await rowsLeft()).toEqual({ songs: 0, albums: 0, artists: 1 });
        expect(await prisma.shareLink.count({ where: { token: `${P}_tok` } })).toBe(0);
        await prisma.user.delete({ where: { id: user.id } });
    });
});
