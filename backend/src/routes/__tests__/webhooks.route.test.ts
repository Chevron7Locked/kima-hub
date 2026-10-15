/**
 * POST /webhooks/lidarr on the real test database, fed the events a real
 * Lidarr sent in recorded runs: an event is stored once and acted on once,
 * Lidarr's secret is checked when one is set, nothing is done while Lidarr is
 * off, and requests without the secret are rate-limited.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { encryptField } from "../../utils/encryption";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { loadScenario, startLidarrReplay, type LidarrReplay } from "../../__tests__/helpers/lidarrReplay";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import webhookRoutes from "../webhooks";

const USER = "webhook_route_user";
const complete = loadScenario("complete");
const grab = complete.webhooks.find((w) => w.eventType === "Grab")!.payload;
const download = complete.webhooks.find((w) => w.eventType === "Download")!.payload;
const importFailure = loadScenario("missing-tracks").webhooks.find((w) => w.eventType === "ImportFailure")!.payload;

function app() {
    const a = express();
    a.use(express.json());
    a.use("/webhooks", webhookRoutes);
    return a;
}

// Lidarr as it stood after the recorded import, so Kima can count the album's tracks.
let lidarr: LidarrReplay;

async function settings(data: Record<string, unknown>) {
    const row = { lidarrEnabled: true, lidarrUrl: lidarr.url, lidarrApiKey: encryptField("key"), lidarrWebhookSecret: null, ...data };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...row }, update: row });
    invalidateSystemSettingsCache();
}

async function processed(eventId: string) {
    for (let i = 0; i < 50; i++) {
        const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
        if (row.processed || row.error) return row;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`event ${eventId} was never processed`);
}

const lidarrEvents = () => prisma.webhookEvent.deleteMany({ where: { source: "lidarr" } });

beforeAll(async () => {
    lidarr = await startLidarrReplay(complete);
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(async () => {
    await lidarrEvents();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await settings({});
});

afterAll(async () => {
    await lidarr.close();
    await lidarrEvents();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("answers the verification request with the app version, also when npm did not start the server", async () => {
    // The published image starts with `node dist/index.js`, so npm's own version variable is never set there.
    const npmVersion = process.env.npm_package_version;
    delete process.env.npm_package_version;
    try {
        const res = await request(app()).get("/webhooks/lidarr/verify");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
        expect(res.body.version).toBe(require("../../../package.json").version);
    } finally {
        if (npmVersion !== undefined) process.env.npm_package_version = npmVersion;
    }
});

it("ignores events while Lidarr is turned off, storing nothing", async () => {
    await settings({ lidarrEnabled: false });
    const res = await request(app()).post("/webhooks/lidarr").send(grab);
    expect(res.status).toBe(202);
    expect(res.body.reason).toBe("lidarr-disabled");
    expect(await prisma.webhookEvent.count({ where: { source: "lidarr" } })).toBe(0);
});

it("refuses a missing or wrong secret once one is set, and takes the right one", async () => {
    await settings({ lidarrWebhookSecret: encryptField("the-secret") });
    expect((await request(app()).post("/webhooks/lidarr").send(grab)).status).toBe(401);
    expect((await request(app()).post("/webhooks/lidarr").set("x-webhook-secret", "wrong").send(grab)).status).toBe(401);
    expect((await request(app()).post("/webhooks/lidarr").set("x-webhook-secret", "the-secret").send(grab)).status).toBe(200);
});

it("stores a grab, links the job waiting for its album and acts on a repeat only once", async () => {
    const lidarrAlbumId = grab.albums[0].id;
    const job = await prisma.downloadJob.create({
        data: {
            userId: USER, subject: "Brad Sucks - Guess Who’s a Mess", type: "album", status: "processing",
            targetMbid: grab.albums[0].mbId, lidarrAlbumId, metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" },
        },
    });

    const first = await request(app()).post("/webhooks/lidarr").send(grab);
    expect(first.status).toBe(200);
    await processed(first.body.eventId);
    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } })).lidarrRef).toBe(grab.downloadId);

    const again = await request(app()).post("/webhooks/lidarr").send(grab);
    expect(again.body.eventId).toBe(first.body.eventId);
    expect(await prisma.webhookEvent.count({ where: { source: "lidarr" } })).toBe(1);

    const done = await request(app()).post("/webhooks/lidarr").send(download);
    await processed(done.body.eventId);
    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("completed");
});

it("takes Lidarr's import-failure event without counting an attempt; the queue judge decides", async () => {
    const job = await prisma.downloadJob.create({
        data: {
            userId: USER, subject: "Brad Sucks - Guess Who’s a Mess", type: "album", status: "processing", attempts: 1,
            targetMbid: importFailure.album.mbId, lidarrAlbumId: importFailure.album.id, lidarrRef: importFailure.downloadId,
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" },
        },
    });

    const res = await request(app()).post("/webhooks/lidarr").send(importFailure);
    expect(res.status).toBe(200);
    expect((await processed(res.body.eventId)).error).toBeNull();

    const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ status: "processing", attempts: 1, lidarrRef: importFailure.downloadId });
});

it("never limits requests carrying the secret, and limits the rest", async () => {
    await settings({ lidarrWebhookSecret: encryptField("the-secret") });
    for (let i = 0; i < 130; i++) {
        const res = await request(app()).post("/webhooks/lidarr").set("x-webhook-secret", "the-secret").send({ eventType: "Test" });
        expect(res.status).toBe(200);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) {
        statuses.push((await request(app()).post("/webhooks/lidarr").set("x-webhook-secret", "wrong").send({ eventType: "Test" })).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s !== 401 && s !== 429)).toEqual([]);
});
