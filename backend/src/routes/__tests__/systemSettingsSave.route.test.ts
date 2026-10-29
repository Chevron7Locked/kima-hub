// Saving settings stores them in the database and nowhere else: a partial save leaves every file alone (the old
// .env mirror wrote LIDARR_ENABLED=false on any save without the Lidarr fields, into a file nothing reads), and
// the saved transcode cache size is what startup loads. Real database, real token.

import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { validateMusicConfig } from "../../utils/configValidator";
import systemSettingsRoutes from "../systemSettings";
import { queues } from "../../workers/queues";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

const ADMIN = "zz-settings-save-admin";
const ENV_FILES = [path.resolve(process.cwd(), "..", ".env"), path.resolve(process.cwd(), ".env")];
const snapshot = () => ENV_FILES.map((f) => (fs.existsSync(f) ? `${fs.statSync(f).mtimeMs}:${fs.readFileSync(f, "utf8").length}` : "absent"));

let before: Record<string, unknown> | null;
let music: string;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    music = fs.mkdtempSync(path.join(os.tmpdir(), "kima-settings-save-"));
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    fs.rmSync(music, { recursive: true, force: true });
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

it("a partial save writes no file, and startup loads the saved cache size", async () => {
    const files = snapshot();
    const res = await request(express().use(express.json()).use("/system-settings", systemSettingsRoutes))
        .post("/system-settings")
        .set("Authorization", `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`)
        .send({ transcodeCacheMaxGb: 7 });
    expect(res.status).toBe(200);
    expect(snapshot()).toEqual(files);

    invalidateSystemSettingsCache();
    const previous = process.env.MUSIC_PATH;
    process.env.MUSIC_PATH = music;
    try {
        expect((await validateMusicConfig()).transcodeCacheMaxGb).toBe(7);
    } finally {
        process.env.MUSIC_PATH = previous;
    }
});

const app = () => express().use(express.json()).use("/system-settings", systemSettingsRoutes);
const asAdmin = () => `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;

it("a save answers only that it saved", async () => {
    const res = await request(app()).post("/system-settings").set("Authorization", asAdmin()).send({ transcodeCacheMaxGb: 8 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
});

it("a server with no settings yet starts from the schema's defaults", async () => {
    await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();

    const res = await request(app()).get("/system-settings").set("Authorization", asAdmin());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
        lidarrEnabled: true,
        lidarrUrl: "http://localhost:8686",
        fanartEnabled: false,
        audiobookshelfEnabled: false,
        audiobookshelfUrl: "http://localhost:13378",
        downloadPath: "/downloads",
        autoSync: true,
        transcodeCacheMaxGb: 10,
        maxQueueLength: 10000,
        soulseekConcurrentDownloads: 4,
    });
    expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).musicPath).toBe("/music");
});
