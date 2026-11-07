/**
 * When Kima can read the Lidarr API key but not the webhook secret, it refuses unsigned events and repairs the link
 * on its next health check, with nobody doing anything. Real database, the real webhook route and health check, and
 * replies recorded from a real Lidarr, where only the random secret differs from the recording.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { encrypt, encryptField } from "../../utils/encryption";
import { getSystemSettings, invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { loadScenario, startLidarrReplay, type LidarrReplay } from "../../__tests__/helpers/lidarrReplay";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { queues } from "../../workers/queues";
import webhookRoutes from "../../routes/webhooks";
import { webhookReconciliation } from "../../jobs/webhookReconciliation";
import { WEBHOOK_SECRET_HEADER } from "../lidarrWebhookSetup";
import { lidarrHealthMonitor } from "../lidarrHealth";
import { sourcePauseController } from "../sourcePauseController";

const ADMIN = "zz-link-repair-admin";
// Sealed under a key this server does not hold.
const UNREADABLE = `xc1.${Buffer.alloc(48, 7).toString("base64url")}`;
const scenario = loadScenario("webhook-repair");
const RECORDED_SECRET = scenario.exchanges.find((e) => e.method === "PUT")!.request as any;
const recordedSecret = RECORDED_SECRET.fields.find((f: any) => f.name === "headers").value[0].value as string;

const secretSent = (body: any): string | undefined =>
    body?.fields?.find((f: any) => f.name === "headers")?.value?.[0]?.value;

let keepsSecret = true;
let lidarr: LidarrReplay;

const app = () => express().use(express.json()).use("/webhooks", webhookRoutes);
const event = () => request(app()).post("/webhooks/lidarr").send({ eventType: "Test" });

async function settings(data: Record<string, unknown>) {
    const row = { lidarrEnabled: true, lidarrUrl: lidarr.url, lidarrApiKey: encryptField("key"), lidarrWebhookSecret: null, ...data };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...row }, update: row });
    invalidateSystemSettingsCache();
}

const askedToSave = () => lidarr.asked.filter((a) => a.method === "PUT");
const storedSecret = async () => (await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).lidarrWebhookSecret;
const secretNotices = () => prisma.notification.count({ where: { userId: ADMIN, title: { contains: "webhook secret" } } });

let before: Record<string, unknown> | null;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    lidarr = await startLidarrReplay(scenario, (response, body) => {
        const sent = secretSent(body);
        if (!sent) return response;
        if (keepsSecret) return JSON.parse(JSON.stringify(response).replaceAll(recordedSecret, sent));
        const reply = JSON.parse(JSON.stringify(response));
        reply.fields.find((f: any) => f.name === "headers").value = [];
        return reply;
    });
});

beforeEach(async () => {
    keepsSecret = true;
    lidarr.at(Infinity);
    lidarr.asked.length = 0;
    await prisma.notification.deleteMany({ where: { userId: ADMIN } });
    await prisma.webhookEvent.deleteMany({ where: { source: "lidarr" } });
    await sourcePauseController.release("lidarr", "LIDARR_UNHEALTHY");
});

afterAll(async () => {
    await lidarr.close();
    await sourcePauseController.release("lidarr", "LIDARR_UNHEALTHY");
    await prisma.webhookEvent.deleteMany({ where: { source: "lidarr" } });
    await prisma.notification.deleteMany({ where: { userId: ADMIN } });
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeEngineConnections();
});

it("refuses unsigned events, then repairs the link so Lidarr's signed events are taken again", async () => {
    await settings({ lidarrWebhookSecret: UNREADABLE });

    expect((await event()).status).toBe(401);

    await lidarrHealthMonitor.check();

    const given = secretSent(askedToSave()[0].body)!;
    expect(given).toMatch(/^[0-9a-f]{64}$/);
    const stored = await storedSecret();
    expect(stored).toMatch(/^xc1\./);
    expect(stored).not.toContain(given);
    expect((await getSystemSettings())?.lidarrWebhookSecret).toBe(given);

    expect((await event()).status).toBe(401);
    expect((await event().set(WEBHOOK_SECRET_HEADER, given)).status).toBe(200);
});

it("sends no notice about a secret it can repair", async () => {
    await settings({ lidarrWebhookSecret: UNREADABLE });

    await lidarrHealthMonitor.check();

    expect(await secretNotices()).toBe(0);
});

it("waits for a later check while Lidarr cannot be reached, and pauses nothing but Lidarr", async () => {
    await settings({ lidarrWebhookSecret: UNREADABLE });

    lidarr.at(0);
    await lidarrHealthMonitor.check();
    expect(askedToSave()).toHaveLength(0);
    expect(await storedSecret()).toBe(UNREADABLE);

    lidarr.at(Infinity);
    await lidarrHealthMonitor.check();
    expect(askedToSave()).toHaveLength(1);
    expect((await getSystemSettings())?.unreadableFields).toEqual([]);
});

it("tries again later when Lidarr answers its health check but not the setup", async () => {
    await settings({ lidarrWebhookSecret: UNREADABLE });

    lidarr.at(2); // Status and log were recorded first; the webhook list has no reply yet.
    expect(await lidarrHealthMonitor.check()).toBe(60_000);
    expect(await storedSecret()).toBe(UNREADABLE);

    lidarr.at(Infinity);
    await lidarrHealthMonitor.check();
    expect((await getSystemSettings())?.unreadableFields).toEqual([]);
});

it("asks a Lidarr that will not keep the secret only once, tells admins, and clears that once the link works", async () => {
    await settings({ lidarrWebhookSecret: UNREADABLE });
    keepsSecret = false;

    await lidarrHealthMonitor.check();
    await lidarrHealthMonitor.check();
    await lidarrHealthMonitor.check();

    expect(askedToSave()).toHaveLength(1);
    expect(await storedSecret()).toBe(UNREADABLE);
    expect((await event()).status).toBe(401);
    expect(await secretNotices()).toBe(1);

    await settings({ lidarrWebhookSecret: encrypt("saved after updating Lidarr") });
    await lidarrHealthMonitor.check();

    expect(await secretNotices()).toBe(0);
});

it("clears the refused-secret notice on a healthy check after a restart, when this process never sent it", async () => {
    await settings({ lidarrWebhookSecret: encrypt("readable") });
    await lidarrHealthMonitor.check();
    // The notice was sent by the process that ran before the restart.
    await prisma.notification.create({
        data: { userId: ADMIN, type: "error", title: "Lidarr did not keep its webhook secret", groupKey: "lidarr-secret-refused" },
    });
    expect(await secretNotices()).toBe(1);

    await lidarrHealthMonitor.check();

    expect(await secretNotices()).toBe(0);
});

it("leaves a secret that reads alone", async () => {
    await settings({ lidarrWebhookSecret: encrypt("kept") });

    await lidarrHealthMonitor.check();

    expect(askedToSave()).toHaveLength(0);
    expect((await event().set(WEBHOOK_SECRET_HEADER, "kept")).status).toBe(200);
});

it("leaves a server with no secret stored alone, still taking unsigned events", async () => {
    await settings({ lidarrWebhookSecret: null });

    await lidarrHealthMonitor.check();

    expect(askedToSave()).toHaveLength(0);
    expect((await event()).status).toBe(200);
});

it("with the API key unreadable too, Lidarr counts as off: no repair, and admins are told", async () => {
    await settings({ lidarrApiKey: UNREADABLE, lidarrWebhookSecret: UNREADABLE });

    await lidarrHealthMonitor.check();

    expect(askedToSave()).toHaveLength(0);
    expect(await storedSecret()).toBe(UNREADABLE);
    expect((await event()).status).toBe(202);
    expect(await secretNotices()).toBe(1);
});

it("still reads Lidarr's history on the two-minute check while events are refused", async () => {
    const history = await startLidarrReplay(loadScenario("complete"));
    try {
        await settings({ lidarrUrl: history.url, lidarrWebhookSecret: UNREADABLE });

        webhookReconciliation.start();
        for (let i = 0; i < 100 && !history.asked.some((a) => a.path.includes("/history")); i++) {
            await new Promise((r) => setTimeout(r, 20));
        }

        expect(history.asked.some((a) => a.path.includes("/history"))).toBe(true);
    } finally {
        webhookReconciliation.stop();
        await history.close();
    }
});
