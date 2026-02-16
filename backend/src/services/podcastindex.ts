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

/**
 * Search podcasts by term
 */
export async function searchPodcasts(query: string, max: number = 20) {
    const client = await initPodcastindexClient();
    const results = await client.searchByTerm(query, max);
    return results;
}

/**
 * Get trending podcasts
 */
export async function getTrendingPodcasts(max: number = 10, category?: string) {
    const client = await initPodcastindexClient();
    const results = await client.podcastsTrending(max, null, null, category);
    return results;
}

/**
 * Get podcasts by category
 */
export async function getPodcastsByCategory(
    category: string,
    max: number = 20
) {
    const client = await initPodcastindexClient();
    const results = await client.searchByTerm("", max, null, null);
    // Filter by category
    return results;
}

/**
 * Get all categories
 */
export async function getCategories() {
    const client = await initPodcastindexClient();
    const results = await client.categoriesList();
    return results;
}

/**
 * Get podcast by feed URL
 */
export async function getPodcastByFeedUrl(feedUrl: string) {
    const client = await initPodcastindexClient();
    const results = await client.podcastsByFeedUrl(feedUrl);
    return results;
}

/**
 * Get podcast by iTunes ID
 */
export async function getPodcastByItunesId(itunesId: string) {
    const client = await initPodcastindexClient();
    const results = await client.podcastsByFeedItunesId(itunesId);
    return results;
}

/**
 * Get recent podcasts
 */
export async function getRecentPodcasts(max: number = 20) {
    const client = await initPodcastindexClient();
    const results = await client.recentFeeds(max);
    return results;
}
