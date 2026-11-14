/** Cached data access: database first, then Redis, then the API, saving to both. */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { findAlbumArtwork, findArtistArtwork } from "./artwork";
import { isMbid } from "./artistIdentity";
import { downloadAndStoreImage } from "./imageStorage";

// Cache TTLs
const ARTIST_IMAGE_TTL = 7 * 24 * 60 * 60; // 7 days
const ALBUM_COVER_TTL = 30 * 24 * 60 * 60; // 30 days
const NEGATIVE_CACHE_TTL = 24 * 60 * 60; // 1 day for "not found" results

class DataCacheService {
    /**
     * Get artist hero image with unified caching
     * Order: DB -> Redis -> Fanart.tv -> Deezer -> save to both
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
     * Order: DB -> Redis -> the artwork door (Deezer -> Cover Art Archive -> Fanart) -> save to both
     */
    async getAlbumCover(
        albumId: string,
        rgMbid: string
    ): Promise<string | null> {
        const cacheKey = `album-cover:${albumId}`;

        // 1. Database first. Title and artist come back too, for sources that search by name.
        let artistName = "";
        let albumTitle = "";
        try {
            const album = await prisma.album.findUnique({
                where: { id: albumId },
                select: {
                    coverUrl: true,
                    title: true,
                    artist: { select: { name: true } },
                },
            });
            if (album?.coverUrl) {
                this.setRedisCache(cacheKey, album.coverUrl, ALBUM_COVER_TTL);
                return album.coverUrl;
            }
            artistName = album?.artist?.name ?? "";
            albumTitle = album?.title ?? "";
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

        // 3. Ask every artwork source, not just the Cover Art Archive.
        if (!artistName && !isMbid(rgMbid)) {
            // Nothing to search on at all: no title, no artist, no real id.
            return null;
        }

        const coverUrl =
            (await findAlbumArtwork({ rgMbid, artistName, albumTitle }))?.url ?? null;

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
        _trackId: string,
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
                const cached = await redisClient.mget(cacheKeys);

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
     * Order: the artwork.ts single door (Fanart -> Deezer -> MusicBrainz)
     * Returns native path (e.g., "native:artists/{id}.jpg") or null
     */
    private async fetchArtistImage(
        artistId: string,
        artistName: string,
        mbid?: string | null
    ): Promise<string | null> {
        const validMbid = isMbid(mbid) ? mbid : undefined;
        const found = await findArtistArtwork({ name: artistName, mbid: validMbid });
        const externalUrl = found?.url ?? null;
        const source = found?.source ?? "";

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
            await redisClient.setex(key, ttl, value);
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
                multi.setex(key, ttl, value);
            }
            await multi.exec();
        } catch (err) {
            logger.warn("[DataCache] Batch cache write failed:", err);
        }
    }

    /**
     * Warm up Redis cache from database
     * Called on server startup. `shouldStop` is asked before each read: once it says yes the warmup ends quietly (the
     * cache fills as it is used).
     */
    async warmupCache({ shouldStop = () => false }: { shouldStop?: () => boolean } = {}): Promise<void> {
        if (shouldStop()) return;
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

            if (shouldStop()) return;

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
