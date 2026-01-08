import axios from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";

class CoverArtService {
    private readonly baseUrl = "https://coverartarchive.org";

    async getCoverArt(rgMbid: string): Promise<string | null> {
        const cacheKey = `caa:${rgMbid}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached === "NOT_FOUND") return null; // Cached negative result
            if (cached) return cached;
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            // Use rate limiter to prevent overwhelming Cover Art Archive
            const response = await rateLimiter.execute("coverart", () =>
                axios.get(`${this.baseUrl}/release-group/${rgMbid}`, {
                    timeout: 5000,
                })
            );

            const images = response.data.images || [];
            const frontImage =
                images.find((img: any) => img.front) || images[0];

            if (frontImage) {
                const coverUrl =
                    frontImage.thumbnails?.large || frontImage.image;

                try {
                    await redisClient.setEx(cacheKey, 2592000, coverUrl); // 30 days
                } catch (err) {
                    logger.warn("Redis set error:", err);
                }

                return coverUrl;
            }
            
            // No front image found - cache negative result
            try {
                await redisClient.setEx(cacheKey, 604800, "NOT_FOUND"); // 7 days
            } catch (err) {
                // Ignore
            }
        } catch (error: any) {
            if (error.response?.status === 404) {
                // No cover art available - cache the negative result
                try {
                    await redisClient.setEx(cacheKey, 604800, "NOT_FOUND"); // 7 days
                } catch (err) {
                    // Ignore
                }
                return null;
            }
            logger.error(`Cover art error for ${rgMbid}:`, error.message);
        }

        return null;
    }
}

export const coverArtService = new CoverArtService();
