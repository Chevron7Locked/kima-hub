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
import { invalidateSystemSettingsCache, onSystemSettingsChange } from "../../utils/systemSettings";
import { validateMusicConfig } from "../../utils/configValidator";
import systemSettingsRoutes from "../systemSettings";
import { queues } from "../../workers/queues";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { setEnv } from "../../__tests__/helpers/env";

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
    const restoreEnv = setEnv({ MUSIC_PATH: music });
    try {
        expect((await validateMusicConfig()).transcodeCacheMaxGb).toBe(7);
    } finally {
        restoreEnv();
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
        autoSync: true,
        transcodeCacheMaxGb: 10,
        maxQueueLength: 10000,
        soulseekConcurrentDownloads: 4,
    });
    expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).musicPath).toBe("/music");
});

it("the settings page sending every field back tells a subscriber only about what changed", async () => {
    const heard = jest.fn();
    const off = onSystemSettingsChange(["soulseekUsername", "soulseekMode", "slskdUrl"], heard);
    try {
        const page = { soulseekUsername: "listener", soulseekMode: "p2p", slskdUrl: "", transcodeCacheMaxGb: 9 };
        await request(app()).post("/system-settings").set("Authorization", asAdmin()).send(page).expect(200);
        heard.mockClear();

        await request(app()).post("/system-settings").set("Authorization", asAdmin()).send({ ...page, transcodeCacheMaxGb: 10 }).expect(200);
        expect(heard).not.toHaveBeenCalled();

        await request(app()).post("/system-settings").set("Authorization", asAdmin()).send({ ...page, soulseekUsername: "someone" }).expect(200);
        expect(heard).toHaveBeenCalledTimes(1);
        expect(heard).toHaveBeenCalledWith(["soulseekUsername"]);
    } finally {
        off();
    }
});

it("turning Audiobookshelf off clears listening progress once; a later save with it still off leaves new progress alone", async () => {
    const progress = { userId: ADMIN, audiobookshelfId: "zz-book", title: "zz-book" };
    try {
        await request(app()).post("/system-settings").set("Authorization", asAdmin()).send({ audiobookshelfEnabled: true }).expect(200);
        await prisma.audiobookProgress.create({ data: progress });

        await request(app()).post("/system-settings").set("Authorization", asAdmin()).send({ audiobookshelfEnabled: false }).expect(200);
        expect(await prisma.audiobookProgress.count({ where: { userId: ADMIN } })).toBe(0);

        await prisma.audiobookProgress.create({ data: progress });
        await request(app()).post("/system-settings").set("Authorization", asAdmin()).send({ audiobookshelfEnabled: false, transcodeCacheMaxGb: 11 }).expect(200);
        expect(await prisma.audiobookProgress.count({ where: { userId: ADMIN } })).toBe(1);
    } finally {
        await prisma.audiobookProgress.deleteMany({ where: { userId: ADMIN } });
    }
});

it("has no download folder setting: downloads go to the music folder", async () => {
    const res = await request(app()).get("/system-settings").set("Authorization", asAdmin());
    expect(res.body).not.toHaveProperty("downloadPath");
});
