import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { getSystemSettings } from "../utils/systemSettings";

/**
 * Fanart.tv API Service
 *
 * Provides high-quality artist images, album covers, and backgrounds
 * API Docs: https://fanart.tv/api-docs/music-api/
 *
 * Free tier: 2 requests/second
 * API key: Get one at https://fanart.tv/get-an-api-key/
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
                "User-Agent":
                    "Kima/1.0.0 (https://github.com/Chevron7Locked/lidify)",
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
        } catch (error) {
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

    /**
     * Get artist images (background, thumbnail, logo)
     * Returns the highest quality artist image available
     */
    async getArtistImage(mbid: string): Promise<string | null> {
        await this.ensureInitialized();

        // Early exit if no API key - don't log every time (reduces log spam)
        if (!this.apiKey) {
            return null;
        }

        // Check cache first
        const cacheKey = `fanart:artist:${mbid}`;
        try {
            if (redisClient.isOpen) {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    logger.debug(`  Fanart.tv: Using cached image`);
                    return cached;
                }
            }
        } catch (error) {
            // Redis errors are non-critical
        }

        try {
            logger.debug(`  Fetching from Fanart.tv...`);
            const response = await this.client.get(`/music/${mbid}`, {
                params: { api_key: this.apiKey },
            });

            const data = response.data;

            // Priority: artistbackground > artistthumb > hdmusiclogo
            let imageUrl: string | null = null;

            if (data.artistbackground && data.artistbackground.length > 0) {
                let rawUrl = data.artistbackground[0].url;

                // If it's just a filename, construct the full URL
                if (rawUrl && !rawUrl.startsWith("http")) {
                    rawUrl = `https://assets.fanart.tv/fanart/music/${mbid}/artistbackground/${rawUrl}`;
                    logger.debug(
                        `  Fanart.tv: Constructed full URL from filename`
                    );
                }

                imageUrl = rawUrl;
                logger.debug(`  Fanart.tv: Found artist background`);
            } else if (data.artistthumb && data.artistthumb.length > 0) {
                let rawUrl = data.artistthumb[0].url;

                // If it's just a filename, construct the full URL
                if (rawUrl && !rawUrl.startsWith("http")) {
                    rawUrl = `https://assets.fanart.tv/fanart/music/${mbid}/artistthumb/${rawUrl}`;
                    logger.debug(
                        `  Fanart.tv: Constructed full URL from filename`
                    );
                }

                imageUrl = rawUrl;
                logger.debug(`  Fanart.tv: Found artist thumbnail`);
            } else if (data.hdmusiclogo && data.hdmusiclogo.length > 0) {
                let rawUrl = data.hdmusiclogo[0].url;

                // If it's just a filename, construct the full URL
                if (rawUrl && !rawUrl.startsWith("http")) {
                    rawUrl = `https://assets.fanart.tv/fanart/music/${mbid}/hdmusiclogo/${rawUrl}`;
                    logger.debug(
                        `  Fanart.tv: Constructed full URL from filename`
                    );
                }

                imageUrl = rawUrl;
                logger.debug(`  Fanart.tv: Found HD logo`);
            }

            // Cache for 7 days
            if (imageUrl && redisClient.isOpen) {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        7 * 24 * 60 * 60,
                        imageUrl
                    );
                } catch (error) {
                    // Redis errors are non-critical
                }
            }

            return imageUrl;
        } catch (error: any) {
            if (error.response?.status === 404) {
                logger.debug(`Fanart.tv: No images found`);
            } else {
                logger.error(`   Fanart.tv error:`, error.message);
            }
            return null;
        }
    }

    /**
     * Get album cover art
     */
    async getAlbumCover(mbid: string): Promise<string | null> {
        await this.ensureInitialized();

        if (!this.apiKey) return null;

        const cacheKey = `fanart:album:${mbid}`;
        try {
            if (redisClient.isOpen) {
                const cached = await redisClient.get(cacheKey);
                if (cached) return cached;
            }
        } catch (error) {
            // Redis errors are non-critical
        }

        try {
            const response = await this.client.get(`/music/albums/${mbid}`, {
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

            if (imageUrl && redisClient.isOpen) {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        7 * 24 * 60 * 60,
                        imageUrl
                    );
                } catch (error) {
                    // Redis errors are non-critical
                }
            }

            return imageUrl;
        } catch (error) {
            return null;
        }
    }
}

export const fanartService = new FanartService();
