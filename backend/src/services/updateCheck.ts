import axios from "axios";
import { prisma } from "../utils/db";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";
import { logger } from "../utils/logger";
import { APP_VERSION } from "../config";

/**
 * Whether a newer Kima release exists, for the version chip's amber dot.
 * One anonymous request per day per server against GitHub's latest-release
 * endpoint; a failure is silent so an offline install never sees errors.
 */

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GITHUB_LATEST_URL =
    "https://api.github.com/repos/Chevron7Locked/kima-hub/releases/latest";

interface UpdateStatus {
    enabled: boolean;
    current: string;
    latest: string | null;
    hasUpdate: boolean;
    lastCheckedAt: string | null;
}

/** Compare dotted versions: positive when `a` is newer. A "v" prefix is ignored. */
export function compareVersions(a: string, b: string): number {
    const parts = (v: string) =>
        v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const [ap, bp] = [parts(a), parts(b)];
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i++) {
        const d = (ap[i] ?? 0) - (bp[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

function statusFrom(current: string, latest: string | null, lastCheckedAt: Date | null, enabled = true): UpdateStatus {
    return {
        enabled,
        current,
        latest,
        hasUpdate: enabled && latest !== null && compareVersions(latest, current) > 0,
        lastCheckedAt: lastCheckedAt ? lastCheckedAt.toISOString() : null,
    };
}

let inFlight: Promise<UpdateStatus> | null = null;

async function refresh(current: string): Promise<UpdateStatus> {
    const settings = await getSystemSettings(true);
    let latest = settings?.latestKnownVersion ?? null;

    try {
        const response = await axios.get(GITHUB_LATEST_URL, {
            timeout: 10000,
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": `kima-hub/${current}`,
            },
            validateStatus: (status) => status === 200 || status === 404,
        });
        const tag = response.data?.tag_name;
        if (response.status === 200 && typeof tag === "string") {
            latest = tag.replace(/^v/, "");
        }
    } catch (error) {
        logger.debug(
            "[UpdateCheck] lookup failed:",
            error instanceof Error ? error.message : error
        );
    }

    const now = new Date();
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", lastUpdateCheck: now, latestKnownVersion: latest },
        update: { lastUpdateCheck: now, latestKnownVersion: latest },
    });
    invalidateSystemSettingsCache();
    return statusFrom(current, latest, now);
}

export async function getUpdateStatus({ force = false }: { force?: boolean } = {}): Promise<UpdateStatus> {
    const current = APP_VERSION;
    const settings = await getSystemSettings();

    if (settings && settings.updateChecksEnabled === false) {
        return statusFrom(current, null, null, false);
    }

    const lastCheck = settings?.lastUpdateCheck?.getTime() ?? 0;
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL_MS) {
        return statusFrom(current, settings?.latestKnownVersion ?? null, settings?.lastUpdateCheck ?? null);
    }

    if (!inFlight) {
        inFlight = refresh(current).finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}
