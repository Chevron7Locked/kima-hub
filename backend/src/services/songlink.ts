import axios from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";
import { USER_AGENT } from "../config";

const SONGLINK_API = "https://api.song.link/v1-alpha.1/links";

export interface SongLinkResult {
    spotifyId: string | null;
    deezerId: string | null;
    title: string | null;
    artist: string | null;
    thumbnailUrl: string | null;
    platformLinks: Record<string, { url: string; entityId: string }>;
}

class SongLinkService {
    // The cache only saves requests: a Redis failure counts as a miss on read and a lost entry on write,
    // and the lookup goes on to the API instead of failing.
    private async cacheGet(key: string): Promise<string | null> {
        try {
            return await redisClient.get(key);
        } catch {
            return null;
        }
    }

    private async cacheSet(key: string, ttlSeconds: number, value: string): Promise<void> {
        try {
            await redisClient.setex(key, ttlSeconds, value);
        } catch {}
    }

    async resolve(url: string): Promise<SongLinkResult | null> {
        const cacheKey = `songlink:${url}`;
        const cached = await this.cacheGet(cacheKey);
        if (cached) return cached === "null" ? null : JSON.parse(cached);

        try {
            const response = await rateLimiter.execute("songlink", () =>
                axios.get(SONGLINK_API, {
                    params: { url },
                    timeout: 10000,
                    headers: { "User-Agent": USER_AGENT },
                }),
            );

            const data = response.data;
            const entities = data.entitiesByUniqueId || {};
            const links = data.linksByPlatform || {};

            const spotifyLink = links.spotify;
            const spotifyEntityId = spotifyLink?.entityUniqueId;
            const spotifyEntity = spotifyEntityId ? entities[spotifyEntityId] : null;

            const bestEntity = spotifyEntity
                || Object.values(entities).find((e: any) => e.title && e.artistName)
                || null;

            const result: SongLinkResult = {
                spotifyId: spotifyEntity?.id || null,
                deezerId: links.deezer ? entities[links.deezer.entityUniqueId]?.id || null : null,
                title: (bestEntity as any)?.title || null,
                artist: (bestEntity as any)?.artistName || null,
                thumbnailUrl: (bestEntity as any)?.thumbnailUrl || null,
                platformLinks: {},
            };

            for (const [platform, linkData] of Object.entries(links)) {
                const ld = linkData as any;
                result.platformLinks[platform] = {
                    url: ld.url,
                    entityId: entities[ld.entityUniqueId]?.id || "",
                };
            }

            await this.cacheSet(cacheKey, 604800, JSON.stringify(result));

            return result;
        } catch (err: any) {
            if (err.response?.status === 404) {
                await this.cacheSet(cacheKey, 3600, "null");
                return null;
            }
            logger.warn(`song.link resolve failed for ${url}:`, err.message);
            return null;
        }
    }
}

export const songLinkService = new SongLinkService();
