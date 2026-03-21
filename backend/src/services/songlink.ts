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
    async resolve(url: string): Promise<SongLinkResult | null> {
        const cacheKey = `songlink:${url}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) return cached === "null" ? null : JSON.parse(cached);
        } catch {}

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

            try {
                await redisClient.setex(cacheKey, 604800, JSON.stringify(result));
            } catch {}

            return result;
        } catch (err: any) {
            if (err.response?.status === 404) {
                try { await redisClient.setex(cacheKey, 3600, "null"); } catch {}
                return null;
            }
            logger.warn(`song.link resolve failed for ${url}:`, err.message);
            return null;
        }
    }

    detectPlatform(url: string): string | null {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            if (hostname.includes("music.youtube.com")) return "youtubeMusic";
            if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "youtube";
            if (hostname.includes("spotify.com")) return "spotify";
            if (hostname.includes("deezer.com")) return "deezer";
            if (hostname.includes("music.apple.com")) return "appleMusic";
            if (hostname.includes("tidal.com")) return "tidal";
            if (hostname.includes("soundcloud.com")) return "soundcloud";
            if (hostname.includes("bandcamp.com")) return "bandcamp";
            if (hostname.includes("mixcloud.com")) return "mixcloud";
            return null;
        } catch {
            return null;
        }
    }
}

export const songLinkService = new SongLinkService();
