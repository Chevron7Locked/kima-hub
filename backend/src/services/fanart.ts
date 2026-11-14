import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { getSystemSettings } from "../utils/systemSettings";
import { onSystemSettingsChange } from "../utils/systemSettingsSubscribers";
import { USER_AGENT } from "../config";
import { INTERACTIVE_PRIORITY, rateLimiter } from "./rateLimiter";

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

// In order of preference.
const ARTIST_IMAGE_KINDS = [
    { key: "artistbackground", label: "artist background" },
    { key: "artistthumb", label: "artist thumbnail" },
    { key: "hdmusiclogo", label: "HD logo" },
] as const;

/**
 * Fanart.tv artist images, album covers and backgrounds
 * (https://fanart.tv/api-docs/music-api/). Free tier: 2 requests/second.
 */
class FanartService {
    private client: AxiosInstance;
    private apiKey: string | null = null;
    private initialized: boolean = false;

    constructor() {
        this.client = axios.create({
            baseURL: "https://webservice.fanart.tv/v3",
            timeout: 10000,
            headers: {
                "User-Agent": USER_AGENT,
            },
        });
    }

    /**
     * Ensure service is initialized with API key from database or .env
     */
    private async ensureInitialized() {
        if (this.initialized) return;

        try {
            // Try to get from database first
            const settings = await getSystemSettings();
            if (settings?.fanartEnabled && settings?.fanartApiKey) {
                this.apiKey = settings.fanartApiKey;
                logger.debug("Fanart.tv configured from database");
                this.initialized = true;
                return;
            }
        } catch {
            // Silently continue to check .env
        }

        // Fallback to .env
        if (process.env.FANART_API_KEY) {
            this.apiKey = process.env.FANART_API_KEY;
            logger.debug("Fanart.tv configured from .env");
        }
        // Note: Not logging "not configured" here - it's optional and logs are spammy
        this.initialized = true;
    }

    reinitialize(): void {
        this.initialized = false;
        this.apiKey = null;
    }

    /**
     * Rate-limited fanart.tv GET. Routes every request through the global
     * rate limiter (service key "fanart") instead of calling the axios
     * instance directly.
     */
    private fanartGet(
        url: string,
        config?: AxiosRequestConfig,
        priority = 0
    ): Promise<AxiosResponse> {
        return rateLimiter.execute("fanart", () => this.client.get(url, config), {
            priority,
        });
    }

    private async cacheGet(key: string): Promise<string | null> {
        try {
            if (redisClient.status === "ready") return await redisClient.get(key);
        } catch {
            // The cache is an optimisation; a Redis error is a miss.
        }
        return null;
    }

    private async cacheSet(key: string, value: string): Promise<void> {
        try {
            if (redisClient.status === "ready") {
                await redisClient.setex(key, CACHE_TTL_SECONDS, value);
            }
        } catch {
            // A failed write only costs the next lookup a refetch.
        }
    }

    /**
     * Get artist images (background, thumbnail, logo)
     * Returns the highest quality artist image available
     */
    async getArtistImage(
        mbid: string,
        opts: { interactive?: boolean } = {}
    ): Promise<string | null> {
        await this.ensureInitialized();

        // Early exit if no API key - don't log every time (reduces log spam)
        if (!this.apiKey) {
            return null;
        }

        const cacheKey = `fanart:artist:${mbid}`;
        const cached = await this.cacheGet(cacheKey);
        if (cached) {
            logger.debug(`  Fanart.tv: Using cached image`);
            return cached;
        }

        try {
            logger.debug(`  Fetching from Fanart.tv...`);
            const response = await this.fanartGet(
                `/music/${mbid}`,
                { params: { api_key: this.apiKey } },
                opts.interactive ? INTERACTIVE_PRIORITY : 0
            );

            const data = response.data;

            let imageUrl: string | null = null;

            for (const { key, label } of ARTIST_IMAGE_KINDS) {
                if (data[key] && data[key].length > 0) {
                    let rawUrl = data[key][0].url;

                    // A bare filename needs the asset host in front of it.
                    if (rawUrl && !rawUrl.startsWith("http")) {
                        rawUrl = `https://assets.fanart.tv/fanart/music/${mbid}/${key}/${rawUrl}`;
                    }

                    imageUrl = rawUrl;
                    logger.debug(`  Fanart.tv: Found ${label}`);
                    break;
                }
            }

            if (imageUrl) await this.cacheSet(cacheKey, imageUrl);

            return imageUrl;
        } catch (error: any) {
            if (error.response?.status === 404) {
                logger.debug(`Fanart.tv: No images found`);
                return null;
            }
            // A failed request is not "no image": the caller must not remember it as one.
            logger.warn(`   Fanart.tv error:`, error.message);
            throw error;
        }
    }

    /**
     * Get album cover art
     */
    async getAlbumCover(mbid: string): Promise<string | null> {
        await this.ensureInitialized();

        if (!this.apiKey) return null;

        const cacheKey = `fanart:album:${mbid}`;
        const cached = await this.cacheGet(cacheKey);
        if (cached) return cached;

        try {
            const response = await this.fanartGet(`/music/albums/${mbid}`, {
                params: { api_key: this.apiKey },
            });

            const data = response.data;
            let imageUrl: string | null = null;

            if (data.albums && data.albums[mbid]) {
                const album = data.albums[mbid];
                if (album.albumcover && album.albumcover.length > 0) {
                    imageUrl = album.albumcover[0].url;
                } else if (album.cdart && album.cdart.length > 0) {
                    imageUrl = album.cdart[0].url;
                }
            }

            if (imageUrl) await this.cacheSet(cacheKey, imageUrl);

            return imageUrl;
        } catch (error: any) {
            if (error.response?.status === 404) return null;
            logger.warn(`   Fanart.tv album error:`, error.message);
            throw error;
        }
    }
}

export const fanartService = new FanartService();

onSystemSettingsChange("fanart", ["fanartEnabled", "fanartApiKey"], () => fanartService.reinitialize());
