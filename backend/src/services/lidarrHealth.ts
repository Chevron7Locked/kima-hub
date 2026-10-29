/**
 * Watches Lidarr itself. Lidarr's own health list stays empty while its
 * database is corrupt, so this reads its status and its error log instead.
 * While Lidarr is unhealthy the "lidarr" source is paused: downloads wait and
 * the queue sweeps stand still. Admins get one alert, cleared on recovery.
 */

import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { sourcePauseController } from "./sourcePauseController";
import { notificationService } from "./notificationService";
import { createLidarrClient, isLidarrConfigured } from "./lidarrClient";

const LIDARR_UNHEALTHY = "LIDARR_UNHEALTHY";
const ALERT_KEY = "lidarr-health";
const CHECK_INTERVAL_MS = 60_000;
const BACKOFF_MS = [1, 2, 5, 15].map((minutes) => minutes * 60_000);
// Backoff starts over once Lidarr has stayed healthy this long.
const STABLE_MS = 15 * 60_000;
const DATABASE_ERROR = /malformed|database is locked|disk I\/O/i;

interface LidarrHealthState {
    status: "ok" | "unhealthy" | "off";
    reason?: string;
    since: Date;
}

interface LidarrLogRecord {
    time: string;
    message?: string;
    exception?: string;
}

class LidarrHealthMonitor {
    private timer?: NodeJS.Timeout;
    private started = false;
    private checking = false;
    private failures = 0;
    private healthySince?: number;
    private logSeenUntil = Date.now() - CHECK_INTERVAL_MS * 10;
    private state: LidarrHealthState = { status: "off", since: new Date() };

    start(): void {
        if (this.started) return;
        this.started = true;
        this.schedule(0);
    }

    stop(): void {
        this.started = false;
        clearTimeout(this.timer);
    }

    getState(): LidarrHealthState {
        return this.state;
    }

    /** A request to Lidarr failed: check now instead of at the next cycle. */
    reportFailure(): void {
        if (this.started && this.state.status === "ok" && !this.checking) this.schedule(0);
    }

    /** Runs one check and returns the delay before the next. */
    async check(): Promise<number> {
        if (this.checking) return CHECK_INTERVAL_MS;
        this.checking = true;
        let delay = CHECK_INTERVAL_MS;
        try {
            const settings = await getSystemSettings();
            if (!isLidarrConfigured(settings)) {
                await this.recover("off");
                const { simpleDownloadManager } = await import("./simpleDownloadManager");
                await simpleDownloadManager.failHeldDownloads();
                return delay;
            }
            const reason = await this.probe(settings.lidarrUrl, settings.lidarrApiKey);
            if (reason) {
                delay = await this.degrade(reason);
            } else {
                await this.recover("ok");
                const { simpleDownloadManager } = await import("./simpleDownloadManager");
                await simpleDownloadManager.resumeHeldDownloads();
            }
        } catch (error: any) {
            logger.error("[LIDARR-HEALTH] Check failed:", error.message);
        } finally {
            this.checking = false;
            if (this.started) this.schedule(delay);
        }
        return delay;
    }

    /** Why Lidarr is unhealthy, or null when it is fine. */
    private async probe(url: string, apiKey: string): Promise<string | null> {
        const client = createLidarrClient(url, apiKey, 10_000);
        let records: LidarrLogRecord[];
        try {
            await client.get("/api/v1/system/status");
            const { data } = await client.get("/api/v1/log", {
                params: { page: 1, pageSize: 20, sortKey: "time", sortDirection: "descending", level: "error" },
            });
            records = data.records ?? [];
        } catch (error: any) {
            return error.response
                ? `Lidarr answered ${error.response.status}`
                : `Lidarr did not answer: ${error.message}`;
        }

        const unseen = records.filter((r) => Date.parse(r.time) > this.logSeenUntil);
        this.logSeenUntil = Math.max(this.logSeenUntil, ...unseen.map((r) => Date.parse(r.time)));
        const dbError = unseen.find((r) => DATABASE_ERROR.test(`${r.message} ${r.exception ?? ""}`));
        return dbError ? `Lidarr's database is failing: ${dbError.message}` : null;
    }

    private async degrade(reason: string): Promise<number> {
        if (this.healthySince && Date.now() - this.healthySince >= STABLE_MS) this.failures = 0;
        this.healthySince = undefined;
        const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
        this.failures++;

        await sourcePauseController.pause("lidarr", {
            until: new Date(Date.now() + delay + CHECK_INTERVAL_MS),
            code: LIDARR_UNHEALTHY,
            message: reason,
        });
        if (this.state.status !== "unhealthy") {
            logger.warn(`[LIDARR-HEALTH] ${reason}; pausing downloads`);
            this.state = { status: "unhealthy", reason, since: new Date() };
            await this.alertAdmins(reason);
        }
        return delay;
    }

    private async recover(status: "ok" | "off"): Promise<void> {
        this.healthySince ??= Date.now();
        if (this.state.status === status) return;
        if (this.state.status === "unhealthy") logger.info("[LIDARR-HEALTH] Lidarr recovered; resuming downloads");
        // Also clears a pause and alert left by a run that stopped while Lidarr was unhealthy.
        await sourcePauseController.release("lidarr", LIDARR_UNHEALTHY);
        await notificationService.resolve(ALERT_KEY);
        this.state = { status, since: new Date() };
    }

    private async alertAdmins(reason: string): Promise<void> {
        await notificationService.notifyAdmins({
            type: "error",
            title: "Lidarr is unhealthy",
            message: `${reason}. Downloads are paused and resume when Lidarr recovers.`,
            metadata: { href: "/settings#lidarr" },
            groupKey: ALERT_KEY,
        });
    }

    private schedule(delayMs: number): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.check(), delayMs);
    }
}

export const lidarrHealthMonitor = new LidarrHealthMonitor();
