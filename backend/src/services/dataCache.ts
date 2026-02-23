/**
 * DataCacheService - Unified data access with consistent caching pattern
 * 
 * Pattern: DB first -> Redis fallback -> API fetch -> save to both
 * 
 * This ensures:
 * - DB is the source of truth
 * - Redis provides fast reads
 * - API calls only happen when data doesn't exist
 * - All fetched data is persisted for future use
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { fanartService } from "./fanart";
import { deezerService } from "./deezer";
import { lastFmService } from "./lastfm";
import { coverArtService } from "./coverArt";
import { downloadAndStoreImage } from "./imageStorage";

// Cache TTLs
const ARTIST_IMAGE_TTL = 7 * 24 * 60 * 60; // 7 days
const ALBUM_COVER_TTL = 30 * 24 * 60 * 60; // 30 days
const NEGATIVE_CACHE_TTL = 24 * 60 * 60; // 1 day for "not found" results

class DataCacheService {
    /**
     * Get artist hero image with unified caching
     * Order: DB -> Redis -> Fanart.tv -> Deezer -> Last.fm -> save to both
     */
    async getArtistImage(
        artistId: string,
        artistName: string,
        mbid?: string | null
    ): Promise<string | null> {
        const cacheKey = `hero:${artistId}`;

        // 1. Check DB first (source of truth)
        try {
            const artist = await prisma.artist.findUnique({
                where: { id: artistId },
                select: { heroUrl: true, userHeroUrl: true },
            });
            const displayHeroUrl = artist?.userHeroUrl ?? artist?.heroUrl;
            if (displayHeroUrl) {
                // Also populate Redis for faster future reads
                this.setRedisCache(cacheKey, displayHeroUrl, ARTIST_IMAGE_TTL);
                return displayHeroUrl;
            }
        } catch (err) {
            logger.warn("[DataCache] DB lookup failed for artist:", artistId);
        }

        // 2. Check Redis cache
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached === "NOT_FOUND") return null; // Negative cache hit
            if (cached) {
                // Sync back to DB if Redis has it but DB doesn't
                this.updateArtistHeroUrl(artistId, cached);
                return cached;
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        // 3. Fetch from external APIs and store locally
        const heroUrl = await this.fetchArtistImage(artistId, artistName, mbid);

        // 4. Save to both DB and Redis
        if (heroUrl) {
            await this.updateArtistHeroUrl(artistId, heroUrl);
            this.setRedisCache(cacheKey, heroUrl, ARTIST_IMAGE_TTL);
        } else {
            // Cache negative result to avoid repeated API calls
            this.setRedisCache(cacheKey, "NOT_FOUND", NEGATIVE_CACHE_TTL);
        }

        return heroUrl;
    }

    /**
     * Get album cover with unified caching
     * Order: DB -> Redis -> Cover Art Archive -> save to both
     */
    async getAlbumCover(
        albumId: string,
        rgMbid: string
    ): Promise<string | null> {
        // Skip temp MBIDs - no cover art available for unscanned albums
        if (!rgMbid || rgMbid.startsWith("temp-")) {
            return null;
        }

        const cacheKey = `album-cover:${albumId}`;

        // 1. Check DB first
        try {
            const album = await prisma.album.findUnique({
                where: { id: albumId },
                select: { coverUrl: true },
            });
            if (album?.coverUrl) {
                this.setRedisCache(cacheKey, album.coverUrl, ALBUM_COVER_TTL);
                return album.coverUrl;
            }
        } catch (err) {
            logger.warn("[DataCache] DB lookup failed for album:", albumId);
        }

        // 2. Check Redis cache
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached === "NOT_FOUND") return null;
            if (cached) {
                this.updateAlbumCoverUrl(albumId, cached);
                return cached;
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        // 3. Fetch from Cover Art Archive
        const coverUrl = await coverArtService.getCoverArt(rgMbid);

        // 4. Save to both DB and Redis
        if (coverUrl) {
            await this.updateAlbumCoverUrl(albumId, coverUrl);
            this.setRedisCache(cacheKey, coverUrl, ALBUM_COVER_TTL);
        } else {
            this.setRedisCache(cacheKey, "NOT_FOUND", NEGATIVE_CACHE_TTL);
        }

        return coverUrl;
    }

    /**
     * Get track cover (uses album cover)
     */
    async getTrackCover(
        trackId: string,
        albumId: string,
        rgMbid?: string | null
    ): Promise<string | null> {
        if (!rgMbid) {
            // Try to get album's rgMbid from DB
            const album = await prisma.album.findUnique({
                where: { id: albumId },
                select: { rgMbid: true, coverUrl: true },
            });
            if (album?.coverUrl) return album.coverUrl;
            if (album?.rgMbid) rgMbid = album.rgMbid;
        }

        if (!rgMbid) return null;

        return this.getAlbumCover(albumId, rgMbid);
    }

    /**
     * Batch get artist images - for list views
     * Only returns what's already cached, doesn't make API calls
     */
    async getArtistImagesBatch(
        artists: Array<{ id: string; heroUrl?: string | null; userHeroUrl?: string | null }>
    ): Promise<Map<string, string | null>> {
        const results = new Map<string, string | null>();

        // First, use any heroUrls/userHeroUrls already in the data (with override pattern)
        for (const artist of artists) {
            const displayHeroUrl = artist.userHeroUrl ?? artist.heroUrl;
            if (displayHeroUrl) {
                results.set(artist.id, displayHeroUrl);
            }
        }

        // For the rest, check Redis cache only (no API calls for list views)
        const missingIds = artists
            .filter((a) => !results.has(a.id))
            .map((a) => a.id);

        if (missingIds.length > 0) {
            try {
                const cacheKeys = missingIds.map((id) => `hero:${id}`);
                const cached = await redisClient.mGet(cacheKeys);

                missingIds.forEach((id, index) => {
                    const value = cached[index];
                    if (value && value !== "NOT_FOUND") {
                        results.set(id, value);
                    }
                });
            } catch (err) {
                // Redis errors are non-critical
            }
        }

        return results;
    }

    /**
     * Batch get album covers - for list views
     */
    async getAlbumCoversBatch(
        albums: Array<{ id: string; coverUrl?: string | null }>
    ): Promise<Map<string, string | null>> {
        const results = new Map<string, string | null>();

        for (const album of albums) {
            if (album.coverUrl) {
                results.set(album.id, album.coverUrl);
            }
        }

        const missingIds = albums
            .filter((a) => !results.has(a.id))
            .map((a) => a.id);

        if (missingIds.length > 0) {
            try {
                const cacheKeys = missingIds.map((id) => `album-cover:${id}`);
                const cached = await redisClient.mGet(cacheKeys);

                missingIds.forEach((id, index) => {
                    const value = cached[index];
                    if (value && value !== "NOT_FOUND") {
                        results.set(id, value);
                    }
                });
            } catch (err) {
                // Redis errors are non-critical
            }
        }

        return results;
    }

    /**
     * Fetch artist image from external APIs and store locally
     * Order: Fanart.tv (if MBID) -> Deezer -> Last.fm
     * Returns native path (e.g., "native:artists/{id}.jpg") or null
     */
    private async fetchArtistImage(
        artistId: string,
        artistName: string,
        mbid?: string | null
    ): Promise<string | null> {
        let externalUrl: string | null = null;
        let source = "";

        // Try Fanart.tv first if we have a valid MBID
        if (mbid && !mbid.startsWith("temp-")) {
            try {
                externalUrl = await fanartService.getArtistImage(mbid);
                if (externalUrl) {
                    source = "Fanart.tv";
                }
            } catch (err) {
                // Fanart.tv failed, continue
            }
        }

        // Try Deezer
        if (!externalUrl) {
            try {
                externalUrl = await deezerService.getArtistImage(artistName);
                if (externalUrl) {
                    source = "Deezer";
                }
            } catch (err) {
                // Deezer failed, continue
            }
        }

        // Try Last.fm
        if (!externalUrl) {
            try {
                const validMbid = mbid && !mbid.startsWith("temp-") ? mbid : undefined;
                const lastfmInfo = await lastFmService.getArtistInfo(artistName, validMbid);

                if (lastfmInfo?.image && Array.isArray(lastfmInfo.image)) {
                    const largestImage =
                        lastfmInfo.image.find((img: any) => img.size === "extralarge" || img.size === "mega") ||
                        lastfmInfo.image[lastfmInfo.image.length - 1];

                    if (largestImage && largestImage["#text"]) {
                        const imageUrl = largestImage["#text"];
                        // Filter out Last.fm placeholder images
                        if (!imageUrl.includes("2a96cbd8b46e442fc41c2b86b821562f")) {
                            externalUrl = imageUrl;
                            source = "Last.fm";
                        }
                    }
                }
            } catch (err) {
                // Last.fm failed
            }
        }

        if (!externalUrl) {
            logger.debug(`[DataCache] No image found for ${artistName}`);
            return null;
        }

        // Download and store locally
        logger.debug(`[DataCache] Got image from ${source} for ${artistName}, downloading...`);
        const localPath = await downloadAndStoreImage(externalUrl, artistId, "artist");

        if (localPath) {
            logger.debug(`[DataCache] Stored image locally for ${artistName}: ${localPath}`);
            return localPath;
        }

        // Fallback to external URL if download fails
        logger.debug(`[DataCache] Download failed, using external URL for ${artistName}`);
        return externalUrl;
    }

    /**
     * Update artist heroUrl in database
     */
    private async updateArtistHeroUrl(artistId: string, heroUrl: string): Promise<void> {
        try {
            await prisma.artist.update({
                where: { id: artistId },
                data: { heroUrl },
            });
        } catch (err) {
            logger.warn("[DataCache] Failed to update artist heroUrl:", err);
        }
    }

    /**
     * Update album coverUrl in database
     */
    private async updateAlbumCoverUrl(albumId: string, coverUrl: string): Promise<void> {
        try {
            await prisma.album.update({
                where: { id: albumId },
                data: { coverUrl },
            });
        } catch (err) {
            logger.warn("[DataCache] Failed to update album coverUrl:", err);
        }
    }

    /**
     * Set Redis cache with error handling
     */
    private async setRedisCache(key: string, value: string, ttl: number): Promise<void> {
        try {
            await redisClient.setEx(key, ttl, value);
        } catch (err) {
            // Redis errors are non-critical
        }
    }

    /**
     * Set multiple Redis cache entries using pipelining
     * Uses MULTI/EXEC for atomic batch writes
     */
    private async setRedisCacheBatch(
        entries: Array<{ key: string; value: string; ttl: number }>
    ): Promise<void> {
        if (entries.length === 0) return;

        try {
            const multi = redisClient.multi();
            for (const { key, value, ttl } of entries) {
                multi.setEx(key, ttl, value);
            }
            await multi.exec();
        } catch (err) {
            logger.warn("[DataCache] Batch cache write failed:", err);
        }
    }

    /**
     * Warm up Redis cache from database
     * Called on server startup
     */
    async warmupCache(): Promise<void> {
        logger.debug("[DataCache] Warming up Redis cache from database...");

        try {
            // Warm up artist images
            const artists = await prisma.artist.findMany({
                where: { heroUrl: { not: null } },
                select: { id: true, heroUrl: true },
            });

            const artistEntries = artists
                .filter((a) => a.heroUrl)
                .map((a) => ({
                    key: `hero:${a.id}`,
                    value: a.heroUrl!,
                    ttl: ARTIST_IMAGE_TTL,
                }));

            await this.setRedisCacheBatch(artistEntries);
            logger.debug(`[DataCache] Cached ${artistEntries.length} artist images`);

            // Warm up album covers
            const albums = await prisma.album.findMany({
                where: { coverUrl: { not: null } },
                select: { id: true, coverUrl: true },
            });

            const albumEntries = albums
                .filter((a) => a.coverUrl)
                .map((a) => ({
                    key: `album-cover:${a.id}`,
                    value: a.coverUrl!,
                    ttl: ALBUM_COVER_TTL,
                }));

            await this.setRedisCacheBatch(albumEntries);
            logger.debug(`[DataCache] Cached ${albumEntries.length} album covers`);

            logger.debug("[DataCache] Cache warmup complete");
        } catch (err) {
            logger.error("[DataCache] Cache warmup failed:", err);
        }
    }
}

export const dataCacheService = new DataCacheService();















