/**
 * One music folder for everything: scans, Soulseek and import downloads, retries and what Lidarr is told. Saving a new
 * one in Settings applies at once when the server's MUSIC_PATH does not fix it; a folder that does not exist is refused;
 * with MUSIC_PATH set, the folder cannot be changed from Settings and the settings reply says so. Real database, real
 * folders, real token.
 */
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { config } from "../../config";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { soulseekTarget } from "../../services/pendingTrackRetry";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import systemSettingsRoutes from "../systemSettings";

jest.mock("../../services/soulseek", () => ({ soulseekService: { isAvailable: jest.fn().mockResolvedValue(true), resetAndReconnect: jest.fn() } }));

const ADMIN = "zz-musicfolder-admin";
const app = express().use(express.json()).use("/system-settings", systemSettingsRoutes);
const asAdmin = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
const save = (musicPath: string) => request(app).post("/system-settings").set("Authorization", asAdmin).send({ musicPath });
const read = () => request(app).get("/system-settings").set("Authorization", asAdmin).expect(200);

let before: Record<string, unknown> | null;
const SONG = "zz-musicfolder-song";
/** A fresh folder that holds the test library's one song. */
const folderWithLibrary = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(dir, "Low"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Low", "song.flac"), "x");
    return dir;
};
let startFolder: string;
let folderA: string;
const envBefore = process.env.MUSIC_PATH;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    startFolder = config.music.musicPath;
    await prisma.artist.create({ data: { id: `${SONG}-art`, name: SONG, identityKey: `${SONG}-ik` } });
    await prisma.album.create({ data: { id: `${SONG}-alb`, rgMbid: `${SONG}-rg`, artistId: `${SONG}-art`, title: SONG, primaryType: "Album" } });
    await prisma.track.create({ data: { id: SONG, albumId: `${SONG}-alb`, title: SONG, trackNo: 1, duration: 1, filePath: "Low/song.flac", fileModified: new Date(), fileSize: 1 } });
    folderA = folderWithLibrary("kima-music-a-");
});

beforeEach(() => {
    delete process.env.MUSIC_PATH;
    invalidateSystemSettingsCache();
});

afterAll(async () => {
    if (envBefore === undefined) delete process.env.MUSIC_PATH;
    else process.env.MUSIC_PATH = envBefore;
    (config.music as { musicPath: string }).musicPath = startFolder;
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    invalidateSystemSettingsCache();
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.track.deleteMany({ where: { id: SONG } });
    await prisma.album.deleteMany({ where: { id: `${SONG}-alb` } });
    await prisma.artist.deleteMany({ where: { id: `${SONG}-art` } });
    fs.rmSync(folderA, { recursive: true, force: true });
    await closeEngineConnections();
});

it("a saved folder is the music folder at once, for scans and downloads alike", async () => {
    await save(folderA).expect(200);

    expect(config.music.musicPath).toBe(folderA);
    expect(await soulseekTarget()).toEqual({ musicPath: folderA });
    expect((await read()).body).toMatchObject({ musicPath: folderA, musicPathFixedByEnv: false });
});

it("refuses a folder that does not exist, and keeps the one in use", async () => {
    await save(folderA).expect(200);
    const res = await save(path.join(folderA, "no-such-folder"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist|cannot be read/);
    expect(config.music.musicPath).toBe(folderA);
});

it("with MUSIC_PATH set, Settings shows that folder and cannot change it", async () => {
    await save(folderA).expect(200);
    process.env.MUSIC_PATH = folderA;
    const other = folderWithLibrary("kima-music-b-");
    try {
        const res = await save(other);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/MUSIC_PATH/);
        expect(config.music.musicPath).toBe(folderA);
        expect((await read()).body).toMatchObject({ musicPath: folderA, musicPathFixedByEnv: true });
        await save(folderA).expect(200);
    } finally {
        fs.rmSync(other, { recursive: true, force: true });
    }
});

it("saving other settings works while the folder in use is missing", async () => {
    const gone = folderWithLibrary("kima-music-gone-");
    await save(gone).expect(200);
    fs.rmSync(gone, { recursive: true, force: true });

    await request(app).post("/system-settings").set("Authorization", asAdmin).send({ musicPath: gone, transcodeCacheMaxGb: 9 }).expect(200);
    expect(config.music.musicPath).toBe(gone);
});

it("the Soulseek target is the music folder in use, whatever the settings row holds", async () => {
    await save(folderA).expect(200);
    await prisma.systemSettings.update({ where: { id: "default" }, data: { musicPath: "/somewhere/else" } });
    invalidateSystemSettingsCache();

    expect(await soulseekTarget()).toEqual({ musicPath: folderA });
});

it("refuses a folder that holds none of the library's songs", async () => {
    await save(folderA).expect(200);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kima-music-empty-"));
    try {
        const res = await save(empty);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/None of the library's songs/);
        expect(config.music.musicPath).toBe(folderA);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

it("takes the same folder written another way as the same folder", async () => {
    await save(folderA).expect(200);
    process.env.MUSIC_PATH = folderA;
    await save(`${folderA}/`).expect(200);
    await save(`${folderA}/./`).expect(200);
    expect(config.music.musicPath).toBe(folderA);
});
