/**
 * Points Lidarr's "Kima" webhook connection at this server and gives it the
 * shared secret as a header. The secret is saved only once Lidarr has kept the
 * header, so Kima never starts requiring a secret Lidarr cannot send. Lidarr
 * then sends its test event, and admins are told when it cannot reach Kima.
 */

import { AxiosInstance } from "axios";
import crypto from "crypto";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { encryptSettings } from "../utils/encryptedFields";
import { createLidarrClient } from "./lidarrClient";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";
import { notificationService } from "./notificationService";

export const WEBHOOK_SECRET_HEADER = "X-Webhook-Secret";
const DEFAULT_CALLBACK_URL = "http://host.docker.internal:3030";
const UNREACHABLE_KEY = "lidarr-callback";

const EVENTS = {
    onGrab: true,
    onReleaseImport: true,
    onAlbumDownload: true,
    onDownloadFailure: true,
    onImportFailure: true,
    onAlbumDelete: true,
    onRename: true,
    onHealthIssue: false,
    onApplicationUpdate: false,
    supportsOnGrab: true,
    supportsOnReleaseImport: true,
    supportsOnAlbumDownload: true,
    supportsOnDownloadFailure: true,
    supportsOnImportFailure: true,
    supportsOnAlbumDelete: true,
    supportsOnRename: true,
    supportsOnHealthIssue: true,
    supportsOnApplicationUpdate: true,
    includeHealthWarnings: false,
};

// One at a time: a settings save and a repair running together would each make a secret, and could leave Lidarr
// holding one and Kima the other.
let lastSetup: Promise<unknown> = Promise.resolve();

/** Links Lidarr to Kima, and answers whether Lidarr kept the secret. */
export function configureLidarrWebhook(lidarrUrl: string, apiKey: string): Promise<boolean> {
    const setup = lastSetup.then(() => linkLidarr(lidarrUrl, apiKey));
    lastSetup = setup.catch(() => undefined);
    return setup;
}

async function linkLidarr(lidarrUrl: string, apiKey: string): Promise<boolean> {
    const lidarr = createLidarrClient(lidarrUrl, apiKey, 10_000);
    const callbackHost = process.env.KIMA_CALLBACK_URL || DEFAULT_CALLBACK_URL;
    const webhookUrl = `${callbackHost}/api/webhooks/lidarr`;

    const { data } = await lidarr.get("/api/v1/notification");
    const notifications = Array.isArray(data) ? data : data?.records;
    if (!Array.isArray(notifications)) {
        throw new Error("Unexpected response from /api/v1/notification; not creating a second webhook");
    }
    const existing = notifications.find(
        (n: any) =>
            n.implementation === "Webhook" &&
            (n.name === "Kima" ||
                n.fields?.some(
                    (f: any) =>
                        f.name === "url" &&
                        (f.value?.includes("webhooks/lidarr") || f.value?.includes("lidify"))
                ))
    );
    if (existing && !existing.id) {
        throw new Error(`Lidarr webhook "${existing.name}" has no id; not creating a second one`);
    }

    const settings = await getSystemSettings();
    const storedSecret = settings?.lidarrWebhookSecret;
    const secretRequired = !!storedSecret || !!settings?.unreadableFields.includes("lidarrWebhookSecret");
    const secret = storedSecret || crypto.randomBytes(32).toString("hex");
    const config = {
        ...EVENTS,
        name: "Kima",
        implementation: "Webhook",
        implementationName: "Webhook",
        configContract: "WebhookSettings",
        infoLink: "https://wiki.servarr.com/lidarr/supported#webhook",
        tags: [],
        fields: [
            { name: "url", value: webhookUrl },
            { name: "method", value: 1 },
            { name: "username", value: "" },
            { name: "password", value: "" },
            { name: "headers", value: [{ key: WEBHOOK_SECRET_HEADER, value: secret }] },
        ],
    };

    const { data: saved } = existing
        ? await lidarr.put(`/api/v1/notification/${existing.id}?forceSave=true`, { ...existing, ...config })
        : await lidarr.post("/api/v1/notification?forceSave=true", config);
    logger.debug(`[LIDARR] Webhook ${existing ? "updated" : "created"}: ${webhookUrl}`);

    const headers = saved?.fields?.find((f: any) => f.name === "headers")?.value;
    const kept =
        Array.isArray(headers) &&
        headers.some((h: any) => h.key === WEBHOOK_SECRET_HEADER && h.value === secret);
    if (!kept) {
        logger.warn(
            `[LIDARR] Lidarr did not keep the ${WEBHOOK_SECRET_HEADER} header (webhook headers need a newer Lidarr), so its webhooks stay rate-limited` +
                (secretRequired ? " and are refused until it sends the secret" : "")
        );
    } else if (secret !== storedSecret) {
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: encryptSettings({ lidarrWebhookSecret: secret }),
        });
        invalidateSystemSettingsCache();
    }

    await checkLidarrReachesKima(lidarr, saved, webhookUrl);
    return kept;
}

async function checkLidarrReachesKima(lidarr: AxiosInstance, webhook: unknown, webhookUrl: string): Promise<void> {
    try {
        await lidarr.post("/api/v1/notification/test", webhook);
    } catch (error: any) {
        const failures = error.response?.data;
        const said = Array.isArray(failures)
            ? failures.map((f: any) => f.errorMessage).filter(Boolean).join("; ")
            : failures?.message;
        const reason = said || error.message;
        logger.warn(`[LIDARR] Lidarr cannot reach Kima at ${webhookUrl}: ${reason}`);
        await notificationService.notifyAdmins({
            type: "error",
            title: "Lidarr cannot reach Kima",
            message: `Lidarr could not send its test event to ${webhookUrl} (${reason}). Until it can, Kima only notices finished downloads on its two-minute check. Set KIMA_CALLBACK_URL to an address Lidarr can reach, restart Kima and save the Lidarr settings again.`,
            metadata: { href: "/settings/sources#lidarr" },
            groupKey: UNREACHABLE_KEY,
        });
        return;
    }
    await notificationService.resolve(UNREACHABLE_KEY);
}
