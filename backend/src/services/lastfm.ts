import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import * as fuzz from "fuzzball";
import { config } from "../config";
import { redisClient } from "../utils/redis";
import { getSystemSettings } from "../utils/systemSettings";
import { fanartService } from "./fanart";
import { deezerService } from "./deezer";
import { rateLimiter } from "./rateLimiter";
import { normalizeToArray } from "../utils/normalize";

interface SimilarArtist {
    name: string;
    mbid?: string;
    match: number; // 0-1 similarity score
    url: string;
}

class LastFmService {
    private client: AxiosInstance;
    private apiKey: string;
    private initialized = false;

    constructor() {
        // Initial value from .env (for backwards compatibility)
        this.apiKey = config.lastfm.apiKey;
        this.client = axios.create({
            baseURL: "https://ws.audioscrobbler.com/2.0/",
            timeout: 10000,
        });
    }

    private async ensureInitialized() {
        if (this.initialized) return;

        // Priority: 1) User settings from DB, 2) env var, 3) default app key
        try {
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();
            if (settings?.lastfmApiKey) {
                this.apiKey = settings.lastfmApiKey;
                logger.debug("Last.fm configured from user settings");
            } else if (this.apiKey) {
                logger.debug("Last.fm configured (default app key)");
            }
        } catch (err) {
            // DB not ready yet, use default/env key
            if (this.apiKey) {
                logger.debug("Last.fm configured (default app key)");
            }
        }

        if (!this.apiKey) {
            logger.warn("Last.fm API key not available");
        }

        this.initialized = true;
    }

    /**
     * Refresh the API key from current settings
     * Called when system settings are updated to pick up new key
     */
    async refreshApiKey(): Promise<void> {
        this.initialized = false;
        await this.ensureInitialized();
        logger.debug("Last.fm API key refreshed from settings");
    }

    private async request<T = any>(params: Record<string, any>) {
        await this.ensureInitialized();
        const response = await rateLimiter.execute("lastfm", () =>
            this.client.get<T>("/", { params })
        );
        return response.data;
    }

    async getSimilarArtists(
        artistMbid: string,
        artistName: string,
        limit = 30
    ): Promise<SimilarArtist[]> {
        const cacheKey = `lastfm:similar:${artistMbid}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.request({
                method: "artist.getSimilar",
                mbid: artistMbid,
                api_key: this.apiKey,
                format: "json",
                limit,
            });

            const similar = data.similarartists?.artist || [];

            const results: SimilarArtist[] = similar.map((artist: any) => ({
                name: artist.name,
                mbid: artist.mbid || undefined,
                match: parseFloat(artist.match) || 0,
                url: artist.url,
            }));

            // Cache for 7 days
            try {
                await redisClient.setEx(
                    cacheKey,
                    604800,
                    JSON.stringify(results)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return results;
        } catch (error: any) {
            // If MBID lookup fails, try by name
            if (
                error.response?.status === 404 ||
                error.response?.data?.error === 6
            ) {
                logger.debug(
                    `Artist MBID not found on Last.fm, trying name search: ${artistName}`
                );
                return this.getSimilarArtistsByName(artistName, limit);
            }

            logger.error(`Last.fm error for ${artistName}:`, error);
            return [];
        }
    }

    private async getSimilarArtistsByName(
        artistName: string,
        limit = 30
    ): Promise<SimilarArtist[]> {
        const cacheKey = `lastfm:similar:name:${artistName}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.request({
                method: "artist.getSimilar",
                artist: artistName,
                api_key: this.apiKey,
                format: "json",
                limit,
            });

            const similar = data.similarartists?.artist || [];

            const results: SimilarArtist[] = similar.map((artist: any) => ({
                name: artist.name,
                mbid: artist.mbid || undefined,
                match: parseFloat(artist.match) || 0,
                url: artist.url,
            }));

            // Cache for 7 days
            try {
                await redisClient.setEx(
                    cacheKey,
                    604800,
                    JSON.stringify(results)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return results;
        } catch (error) {
            logger.error(`Last.fm error for ${artistName}:`, error);
            return [];
        }
    }

    async getAlbumInfo(artistName: string, albumName: string) {
        const cacheKey = `lastfm:album:${artistName}:${albumName}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.request({
                method: "album.getInfo",
                artist: artistName,
                album: albumName,
                api_key: this.apiKey,
                format: "json",
            });

            const album = data.album;

            // Normalize arrays before caching/returning
            if (album) {
                const normalized = {
                    ...album,
                    image: normalizeToArray(album.image),
                    tags: album.tags ? {
                        ...album.tags,
                        tag: normalizeToArray(album.tags.tag)
                    } : album.tags,
                    tracks: album.tracks ? {
                        ...album.tracks,
                        track: normalizeToArray(album.tracks.track)
                    } : album.tracks
                };

                // Cache for 30 days
                try {
                    await redisClient.setEx(
                        cacheKey,
                        2592000,
                        JSON.stringify(normalized)
                    );
                } catch (err) {
                    logger.warn("Redis set error:", err);
                }

                return normalized;
            }

            return album;
        } catch (error) {
            logger.error(`Last.fm album info error for ${albumName}:`, error);
            return null;
        }
    }

    async getTopAlbumsByTag(tag: string, limit = 20) {
        const cacheKey = `lastfm:tag:albums:${tag}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.request({
                method: "tag.getTopAlbums",
                tag,
                api_key: this.apiKey,
                format: "json",
                limit,
            });

            const albums = data.albums?.album || [];

            // Cache for 7 days
            try {
                await redisClient.setEx(
                    cacheKey,
                    604800,
                    JSON.stringify(albums)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return albums;
        } catch (error) {
            logger.error(`Last.fm tag albums error for ${tag}:`, error);
            return [];
        }
    }

    async getSimilarTracks(artistName: string, trackName: string, limit = 20) {
        const cacheKey = `lastfm:similar:track:${artistName}:${trackName}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.request({
                method: "track.getSimilar",
                artist: artistName,
                track: trackName,
                api_key: this.apiKey,
                format: "json",
                limit,
            });

            const tracks = data.similartracks?.track || [];

            // Cache for 7 days
            try {
                await redisClient.setEx(
                    cacheKey,
                    604800,
                    JSON.stringify(tracks)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return tracks;
        } catch (error) {
            logger.error(
                `Last.fm similar tracks error for ${trackName}:`,
                error
            );
            return [];
        }
    }

    async getArtistTopTracks(
        artistMbid: string,
        artistName: string,
        limit = 10
    ) {
        const cacheKey = `lastfm:toptracks:${artistMbid || artistName}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const params: any = {
                method: "artist.getTopTracks",
                api_key: this.apiKey,
                format: "json",
                limit,
            };

            if (artistMbid) {
                params.mbid = artistMbid;
            } else {
                params.artist = artistName;
            }

            const data = await this.request(params);

            const tracks = data.toptracks?.track || [];

            // Cache for 7 days
            try {
                await redisClient.setEx(
                    cacheKey,
                    604800,
                    JSON.stringify(tracks)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return tracks;
        } catch (error) {
            logger.error(`Last.fm top tracks error for ${artistName}:`, error);
            return [];
        }
    }

    async getArtistTopAlbums(
        artistMbid: string,
        artistName: string,
        limit = 10
    ) {
        const cacheKey = `lastfm:topalbums:${artistMbid || artistName}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const params: any = {
                method: "artist.getTopAlbums",
                api_key: this.apiKey,
                format: "json",
                limit,
            };

            if (artistMbid) {
                params.mbid = artistMbid;
            } else {
                params.artist = artistName;
            }

            const data = await this.request(params);

            const albums = data.topalbums?.album || [];

            // Cache for 7 days
            try {
                await redisClient.setEx(
                    cacheKey,
                    604800,
                    JSON.stringify(albums)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return albums;
        } catch (error) {
            logger.error(`Last.fm top albums error for ${artistName}:`, error);
            return [];
        }
    }

    /**
     * Get detailed artist info including real images
     */
    async getArtistInfo(artistName: string, mbid?: string) {
        try {
            const params: any = {
                method: "artist.getinfo",
                api_key: this.apiKey,
                format: "json",
            };

            if (mbid) {
                params.mbid = mbid;
            } else {
                params.artist = artistName;
            }

            const data = await this.request(params);
            const artist = data.artist;

            // Normalize arrays before returning
            if (artist) {
                return {
                    ...artist,
                    image: normalizeToArray(artist.image),
                    tags: artist.tags ? {
                        ...artist.tags,
                        tag: normalizeToArray(artist.tags.tag)
                    } : artist.tags,
                    similar: artist.similar ? {
                        ...artist.similar,
                        artist: normalizeToArray(artist.similar.artist)
                    } : artist.similar
                };
            }

            return artist;
        } catch (error) {
            logger.error(
                `Last.fm artist info error for ${artistName}:`,
                error
            );
            return null;
        }
    }

    /**
     * Extract the best available image from Last.fm image array
     */
    public getBestImage(imageArray: any[]): string | null {
        if (!imageArray || !Array.isArray(imageArray)) {
            return null;
        }

        // Try extralarge first, then large, then medium, then small
        const image =
            imageArray.find((img: any) => img.size === "extralarge")?.[
                "#text"
            ] ||
            imageArray.find((img: any) => img.size === "large")?.["#text"] ||
            imageArray.find((img: any) => img.size === "medium")?.["#text"] ||
            imageArray.find((img: any) => img.size === "small")?.["#text"];

        // Filter out empty/placeholder images
        if (
            !image ||
            image === "" ||
            image.includes("2a96cbd8b46e442fc41c2b86b821562f")
        ) {
            return null;
        }

        return image;
    }

    private isInvalidArtistName(name?: string | null) {
        if (!name) return true;
        const normalized = name.trim().toLowerCase();
        return (
            normalized.length === 0 ||
            normalized === "unknown" ||
            normalized === "various artists"
        );
    }

    private normalizeName(name: string | undefined | null) {
        return (name || "").trim().toLowerCase();
    }

    private normalizeKey(name: string | undefined | null) {
        return this.normalizeName(name)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]/g, "");
    }

    private getArtistKey(artist: any) {
        return (
            artist.mbid || this.normalizeKey(artist.name) || artist.url || ""
        );
    }

    private isDuplicateArtist(existing: any[], candidate: any) {
        const candidateKey = this.getArtistKey(candidate);
        if (!candidateKey) {
            return true;
        }

        for (const entry of existing) {
            const entryKey = this.getArtistKey(entry);
            if (entryKey && entryKey === candidateKey) {
                return true;
            }

            const nameSimilarity = fuzz.ratio(
                this.normalizeName(entry.name),
                this.normalizeName(candidate.name)
            );

            if (nameSimilarity >= 95) {
                return true;
            }
        }

        return false;
    }

    private isStandaloneSingle(albumName: string, trackName: string) {
        const albumLower = albumName.toLowerCase();
        const trackLower = trackName.toLowerCase();

        return (
            albumLower === trackLower ||
            albumLower === `${trackLower} - single` ||
            albumLower.endsWith(" - single") ||
            albumLower.endsWith(" (single)")
        );
    }

    private async buildArtistSearchResult(artist: any, enrich: boolean) {
        const baseResult = {
            type: "music",
            id: artist.mbid || artist.name,
            name: artist.name,
            listeners: parseInt(artist.listeners || "0", 10),
            url: artist.url,
            image: this.getBestImage(normalizeToArray(artist.image)),
            mbid: artist.mbid,
            bio: null,
            tags: [] as string[],
        };

        if (!enrich) {
            return baseResult;
        }

        const [info, fanartImage, deezerImage] = await Promise.all([
            this.getArtistInfo(artist.name, artist.mbid),
            artist.mbid
                ? fanartService
                      .getArtistImage(artist.mbid)
                      .catch(() => null as string | null)
                : Promise.resolve<string | null>(null),
            deezerService
                .getArtistImage(artist.name)
                .catch(() => null as string | null),
        ]);

        const resolvedImage =
            fanartImage ||
            deezerImage ||
            (info ? this.getBestImage(info.image) : null) ||
            baseResult.image;

        return {
            ...baseResult,
            image: resolvedImage,
            bio: info?.bio?.summary || info?.bio?.content || null,
            tags: info?.tags?.tag?.map((t: any) => t.name) || [],
        };
    }

    private async buildTrackSearchResult(track: any, enrich: boolean) {
        if (this.isInvalidArtistName(track.artist)) {
            return null;
        }

        const baseResult = {
            type: "track",
            id: track.mbid || `${track.artist}-${track.name}`,
            name: track.name,
            artist: track.artist,
            album: track.album || null,
            listeners: parseInt(track.listeners || "0", 10),
            url: track.url,
            image: this.getBestImage(normalizeToArray(track.image)),
            mbid: track.mbid,
        };

        if (!enrich) {
            return baseResult;
        }

        const trackInfo = await this.getTrackInfo(track.artist, track.name);

        let albumName = trackInfo?.album?.title || baseResult.album;
        let albumArt =
            this.getBestImage(trackInfo?.album?.image) || baseResult.image;

        if (albumName && this.isStandaloneSingle(albumName, track.name)) {
            return null;
        }

        if (!albumArt) {
            albumArt = await deezerService
                .getArtistImage(track.artist)
                .catch(() => null as string | null);
        }

        return {
            ...baseResult,
            album: albumName,
            image: albumArt,
        };
    }

    /**
     * Search for artists on Last.fm and fetch their detailed info with images
     */
    async searchArtists(query: string, limit = 20) {
        try {
            const data = await this.request({
                method: "artist.search",
                artist: query,
                api_key: this.apiKey,
                format: "json",
                limit,
            });

            const artists = data.results?.artistmatches?.artist || [];

            logger.debug(
                `\n [LAST.FM SEARCH] Found ${artists.length} artists (before filtering)`
            );

            const queryLower = query.toLowerCase().trim();
            const words = queryLower.split(/\s+/).filter(Boolean);
            const minWordMatches =
                words.length <= 2
                    ? words.length
                    : Math.max(1, words.length - 1);

            const escapeRegex = (text: string) =>
                text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const wordMatchers = words.map((word) => {
                if (word.length <= 2) {
                    return (candidate: string) => candidate.includes(word);
                }
                const regex = new RegExp(`\\b${escapeRegex(word)}\\b`);
                return (candidate: string) => regex.test(candidate);
            });

            const scoredArtists = artists
                .map((artist: any) => {
                    const normalizedName = this.normalizeName(artist.name);
                    const similarity = fuzz.token_set_ratio(
                        queryLower,
                        normalizedName
                    );
                    const listeners = parseInt(artist.listeners || "0", 10);
                    const hasMbid = Boolean(artist.mbid);
                    const wordMatches = wordMatchers.filter((matcher) =>
                        matcher(normalizedName)
                    ).length;

                    return {
                        artist,
                        similarity,
                        listeners,
                        hasMbid,
                        wordMatches,
                    };
                })
                .filter(({ similarity, wordMatches }: { similarity: number; wordMatches: number }) => {
                    if (!queryLower) return true;
                    return similarity >= 50 || wordMatches >= minWordMatches;
                })
                .sort((a: any, b: any) => {
                    return (
                        Number(b.hasMbid) - Number(a.hasMbid) ||
                        b.wordMatches - a.wordMatches ||
                        b.listeners - a.listeners ||
                        b.similarity - a.similarity
                    );
                });

            const uniqueArtists: any[] = [];

            for (const entry of scoredArtists) {
                const artist = entry.artist;
                if (this.isDuplicateArtist(uniqueArtists, artist)) {
                    continue;
                }

                uniqueArtists.push(artist);
            }

            if (uniqueArtists.length > 0 && uniqueArtists.length < limit) {
                const primaryArtist = uniqueArtists[0];
                try {
                    const fallbackSimilar = await this.getSimilarArtists(
                        primaryArtist.mbid || "",
                        primaryArtist.name,
                        limit * 2
                    );

                    for (const similar of fallbackSimilar) {
                        if (uniqueArtists.length >= limit) {
                            break;
                        }

                        const candidate = {
                            name: similar.name,
                            mbid: similar.mbid,
                            listeners: 0,
                            url: similar.url,
                            image: [],
                        };

                        if (this.isDuplicateArtist(uniqueArtists, candidate)) {
                            continue;
                        }

                        uniqueArtists.push(candidate);
                    }
                } catch (error) {
                    logger.warn(
                        "[LAST.FM SEARCH] Similar artist fallback failed:",
                        error
                    );
                }
            }

            const limitedArtists = uniqueArtists.slice(0, limit);

            logger.debug(
                `  → Filtered to ${limitedArtists.length} relevant matches (limit: ${limit})`
            );

            const enrichmentCount = Math.min(5, limitedArtists.length);
            const [enriched, fast] = await Promise.all([
                Promise.all(
                    limitedArtists
                        .slice(0, enrichmentCount)
                        .map((artist: any) =>
                            this.buildArtistSearchResult(artist, true)
                        )
                ),
                Promise.all(
                    limitedArtists
                        .slice(enrichmentCount)
                        .map((artist: any) =>
                            this.buildArtistSearchResult(artist, false)
                        )
                ),
            ]);

            return [...enriched, ...fast].filter(Boolean);
        } catch (error) {
            logger.error("Last.fm artist search error:", error);
            return [];
        }
    }

    /**
     * Search for tracks on Last.fm
     */
    async searchTracks(query: string, limit = 20) {
        try {
            const data = await this.request({
                method: "track.search",
                track: query,
                api_key: this.apiKey,
                format: "json",
                limit,
            });

            const tracks = data.results?.trackmatches?.track || [];

            logger.debug(
                `\n [LAST.FM TRACK SEARCH] Found ${tracks.length} tracks`
            );

            const validTracks = tracks.filter(
                (track: any) => !this.isInvalidArtistName(track.artist)
            );
            const limitedTracks = validTracks.slice(0, limit);

            const enrichmentCount = Math.min(8, limitedTracks.length);

            const [enriched, fast] = await Promise.all([
                Promise.all(
                    limitedTracks
                        .slice(0, enrichmentCount)
                        .map((track: any) =>
                            this.buildTrackSearchResult(track, true)
                        )
                ),
                Promise.all(
                    limitedTracks
                        .slice(enrichmentCount)
                        .map((track: any) =>
                            this.buildTrackSearchResult(track, false)
                        )
                ),
            ]);

            return [...enriched, ...fast].filter(Boolean);
        } catch (error) {
            logger.error("Last.fm track search error:", error);
            return [];
        }
    }

    /**
     * Get detailed track info including album
     */
    async getTrackInfo(artistName: string, trackName: string) {
        try {
            const data = await this.request({
                method: "track.getInfo",
                artist: artistName,
                track: trackName,
                api_key: this.apiKey,
                format: "json",
            });

            const track = data.track;

            // Normalize arrays before returning
            if (track) {
                return {
                    ...track,
                    toptags: track.toptags ? {
                        ...track.toptags,
                        tag: normalizeToArray(track.toptags.tag)
                    } : track.toptags,
                    album: track.album ? {
                        ...track.album,
                        image: normalizeToArray(track.album.image)
                    } : track.album
                };
            }

            return track;
        } catch (error) {
            // Don't log errors for track info (many tracks don't have full info)
            return null;
        }
    }

    /**
     * Get the canonical artist name from Last.fm correction API
     * Resolves aliases and misspellings to official artist names
     *
     * @param artistName - The artist name to check for corrections
     * @returns The canonical artist name info, or null if no correction found
     *
     * @example
     * getArtistCorrection("of mice") // Returns { corrected: true, canonicalName: "Of Mice & Men", mbid: "..." }
     * getArtistCorrection("bjork")   // Returns { corrected: true, canonicalName: "Björk", mbid: "..." }
     */
    async getArtistCorrection(artistName: string): Promise<{
        corrected: boolean;
        canonicalName: string;
        mbid?: string;
    } | null> {
        const cacheKey = `lastfm:correction:${artistName.toLowerCase().trim()}`;

        // Check cache first (30-day TTL)
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return cached === "null" ? null : JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.request({
                method: "artist.getCorrection",
                artist: artistName,
                api_key: this.apiKey,
                format: "json",
            });

            const correction = data.corrections?.correction?.artist;

            if (!correction || !correction.name) {
                // Cache null result
                await redisClient.setEx(cacheKey, 2592000, "null");
                return null;
            }

            const result = {
                corrected:
                    correction.name.toLowerCase() !== artistName.toLowerCase(),
                canonicalName: correction.name,
                mbid: correction.mbid || undefined,
            };

            // Cache for 30 days
            await redisClient.setEx(cacheKey, 2592000, JSON.stringify(result));

            return result;
        } catch (error: any) {
            // Error 6 = "Artist not found" - cache negative result
            if (error.response?.data?.error === 6) {
                await redisClient.setEx(cacheKey, 2592000, "null");
                return null;
            }
            logger.error(`Last.fm correction error for ${artistName}:`, error);
            return null;
        }
    }

    /**
     * Get popular artists from Last.fm charts
     */
    async getTopChartArtists(limit = 20) {
        await this.ensureInitialized();

        // Return empty if no API key configured
        if (!this.apiKey) {
            logger.warn(
                "Last.fm: Cannot fetch chart artists - no API key configured"
            );
            return [];
        }

        const cacheKey = `lastfm:chart:artists:${limit}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        try {
            const data = await this.request({
                method: "chart.getTopArtists",
                api_key: this.apiKey,
                format: "json",
                limit,
            });

            const artists = data.artists?.artist || [];

            // Get detailed info for each artist with images
            const detailedArtists = await Promise.all(
                artists.map(async (artist: any) => {
                    // Try to get image from Fanart.tv using MBID
                    let image = null;
                    if (artist.mbid) {
                        try {
                            image = await fanartService.getArtistImage(
                                artist.mbid
                            );
                        } catch (error) {
                            // Silently fail
                        }
                    }

                    // Fallback to Deezer (most reliable)
                    if (!image) {
                        try {
                            const deezerImage =
                                await deezerService.getArtistImage(artist.name);
                            if (deezerImage) {
                                image = deezerImage;
                            }
                        } catch (error) {
                            // Silently fail
                        }
                    }

                    // Last fallback to Last.fm images (but filter placeholders)
                    if (!image) {
                        const lastFmImage = this.getBestImage(normalizeToArray(artist.image));
                        if (
                            lastFmImage &&
                            !lastFmImage.includes(
                                "2a96cbd8b46e442fc41c2b86b821562f"
                            )
                        ) {
                            image = lastFmImage;
                        }
                    }

                    return {
                        type: "music",
                        id: artist.mbid || artist.name,
                        name: artist.name,
                        listeners: parseInt(artist.listeners || "0"),
                        playCount: parseInt(artist.playcount || "0"),
                        url: artist.url,
                        image,
                        mbid: artist.mbid,
                    };
                })
            );

            // Cache for 6 hours (charts update frequently)
            try {
                await redisClient.setEx(
                    cacheKey,
                    21600,
                    JSON.stringify(detailedArtists)
                );
            } catch (err) {
                logger.warn("Redis set error:", err);
            }

            return detailedArtists;
        } catch (error) {
            logger.error("Last.fm chart artists error:", error);
            return [];
        }
    }
}

export const lastFmService = new LastFmService();
