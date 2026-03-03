import axios from "axios";
import { config } from "../config";
import { logger } from "./logger";

/**
 * Call each configured import webhook sequentially.
 *
 * Webhooks are configured via IMPORT_WEBHOOK_N_URL (required) and optional
 * IMPORT_WEBHOOK_N_POST (JSON string used as the POST body). When no POST body
 * is provided the request is sent as GET. Kima calls these once, right before
 * each library scan, regardless of what triggered the scan (Soulseek, Lidarr,
 * manual, Spotify import, …). Each service can use the signal to perform
 * pre-scan work (file organisation, tagging, conversion, …).
 *
 * Errors are logged but never re-thrown so the scan always proceeds.
 */
export async function callImportWebhook(): Promise<void> {
    const webhooks = config.importWebhooks;
    if (!webhooks.length) {
        return;
    }

    const axiosOpts = {
        // Allow up to 5 minutes for the external service to finish.
        timeout: 5 * 60 * 1000,
        headers: { "Content-Type": "application/json" },
        validateStatus: (status: number) => status >= 200 && status < 300,
    };

    for (const { url, post } of webhooks) {
        const method = post ? "POST" : "GET";
        logger.debug(`[ImportWebhook] ${method} ${url}`);

        try {
            if (post) {
                let body: unknown;
                try {
                    body = JSON.parse(post);
                } catch {
                    body = post;
                }
                await axios.post(url, body, axiosOpts);
            } else {
                await axios.get(url, axiosOpts);
            }
            logger.debug(`[ImportWebhook] ${url} completed successfully`);
        } catch (err: any) {
            logger.error(
                `[ImportWebhook] Webhook call to ${url} failed (proceeding anyway): ${err.message}`
            );
        }
    }
}
