import { getSystemSettings } from "../utils/systemSettings";
import { decrypt } from "../utils/encryption";

let cachedClient: any = null;
let cachedCredentialsHash: string | null = null;

/**
 * Initialize PodcastIndex API client with credentials from system settings.
 * Caches the client and only recreates it when credentials change.
 */
async function initPodcastindexClient() {
    const settings = await getSystemSettings();

    if (!settings?.podcastindexEnabled) {
        throw new Error("PodcastIndex is not enabled in system settings");
    }

    if (!settings.podcastindexApiKey || !settings.podcastindexApiSecret) {
        throw new Error("PodcastIndex API credentials not configured");
    }

    const apiKey = decrypt(settings.podcastindexApiKey);
    const apiSecret = decrypt(settings.podcastindexApiSecret);

    const hash = `${apiKey}:${apiSecret}`;
    if (cachedClient && cachedCredentialsHash === hash) {
        return cachedClient;
    }

    const podcastIndexApi = require("podcast-index-api");
    cachedClient = podcastIndexApi(apiKey, apiSecret, "Kima");
    cachedCredentialsHash = hash;

    return cachedClient;
}

export function resetPodcastIndexCache(): void {
    cachedClient = null;
    cachedCredentialsHash = null;
}

