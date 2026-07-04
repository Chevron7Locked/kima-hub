import { AxiosRequestConfig } from "axios";
import { logger } from "../utils/logger";
import { CacheWrapper } from "../utils/cacheWrapper";
import { rateLimitedGet } from "./httpClient";

/**
 * Deezer Service
 * 
 * Fetches images, previews, and public playlist data from Deezer.
 * No authentication required - Deezer's API is completely public.
 */

const DEEZER_API = "https://api.deezer.com";

interface DeezerTrack {
    deezerId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    durationMs: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

interface DeezerPlaylist {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: DeezerTrack[];
    isPublic: boolean;
}

export interface DeezerPlaylistPreview {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    fans: number;
}

export interface DeezerRadioStation {
    id: string;
    title: string;
    description: string | null;
    imageUrl: string | null;
    type: "radio";
}

interface DeezerGenre {
    id: number;
    name: string;
    imageUrl: string | null;
}

interface DeezerPodcast {
    id: number;
    title: string;
    description: string;
    fans: number;
    link: string;
    pictureUrl: string | null;
}

interface DeezerGenreWithRadios {
    id: number;
    name: string;
    radios: DeezerRadioStation[];
}

class DeezerService {
    private readonly cachePrefix = "deezer:";
    private readonly cacheTTL = 86400; // 24 hours
    private cache: CacheWrapper;

    constructor() {
        this.cache = new CacheWrapper('deezer');
    }

    /**
     * Get cached value from Redis
     */
    private async getCached(key: string): Promise<string | null> {
        const cached = await this.cache.get<string>(`${this.cachePrefix}${key}`);
        return cached;
    }

    /**
     * Set cached value in Redis
     */
    private async setCache(key: string, value: string): Promise<void> {
        await this.cache.set(`${this.cachePrefix}${key}`, value, this.cacheTTL);
    }

    /**
     * Cache-then-fetch helper: checks Redis first, and on a miss runs `requestFn`
     * (which must issue its Deezer calls via `deezerGet`) and caches the result.
     * Negative results are cached too, under the "null" sentinel, since getCached/
     * setCache already round-trip through CacheWrapper's own JSON encoding.
     * Mirrors MusicBrainzService.cachedRequest.
     */
    private async cachedRequest<T>(cacheKey: string, requestFn: () => Promise<T>): Promise<T> {
        const cached = await this.getCached(cacheKey);
        if (cached !== null) {
            try {
                return cached === "null" ? (null as T) : (JSON.parse(cached) as T);
            } catch {
                // Stale/incompatible cache entry - fall through and refetch.
            }
        }

        const data = await requestFn();
        await this.setCache(cacheKey, data === null || data === undefined ? "null" : JSON.stringify(data));
        return data;
    }

    /**
     * Rate-limited Deezer GET. Routes every request through the global rate
     * limiter (service key "deezer") instead of calling axios directly.
     */
    private deezerGet<T = any>(path: string, config?: AxiosRequestConfig): Promise<T> {
        return rateLimitedGet<T>("deezer", `${DEEZER_API}${path}`, config);
    }

    /**
     * Search for an artist and get their image URL
     */
    async getArtistImage(artistName: string): Promise<string | null> {
        const cacheKey = `artist:${artistName.toLowerCase()}`;

        try {
            return await this.cachedRequest(cacheKey, async () => {
                const body = await this.deezerGet<any>("/search/artist", {
                    params: { q: artistName, limit: 1 },
                    timeout: 5000,
                });

                const artist = body?.data?.[0];
                return artist?.picture_xl || artist?.picture_big || artist?.picture_medium || null;
            });
        } catch (error: any) {
            logger.error(`Deezer artist image error for ${artistName}:`, error.message);
            return null;
        }
    }

    /**
     * Search for an album and get its cover art URL
     */
    async getAlbumCover(artistName: string, albumName: string): Promise<string | null> {
        const cacheKey = `album:${artistName.toLowerCase()}:${albumName.toLowerCase()}`;

        try {
            return await this.cachedRequest(cacheKey, async () => {
                // Try structured query first, fall back to unstructured if no results.
                // Deezer's structured syntax (artist:"..." album:"...") fails for some albums.
                let albums: any[] = [];

                const structured = await this.deezerGet<any>("/search/album", {
                    params: { q: `artist:"${artistName}" album:"${albumName}"`, limit: 5 },
                    timeout: 5000,
                });
                albums = structured?.data || [];

                if (albums.length === 0) {
                    const unstructured = await this.deezerGet<any>("/search/album", {
                        params: { q: `${artistName} ${albumName}`, limit: 5 },
                        timeout: 5000,
                    });
                    albums = unstructured?.data || [];
                }

                // Find the best match
                let bestMatch = albums[0];

                for (const album of albums) {
                    if (album.artist?.name?.toLowerCase() === artistName.toLowerCase() &&
                        album.title?.toLowerCase() === albumName.toLowerCase()) {
                        bestMatch = album;
                        break;
                    }
                }

                return bestMatch?.cover_xl || bestMatch?.cover_big || bestMatch?.cover_medium || null;
            });
        } catch (error: any) {
            logger.error(`Deezer album cover error for ${artistName} - ${albumName}:`, error.message);
            return null;
        }
    }

    /**
     * Search Deezer and return the first preview URL for a track.
     */
    private async searchTrackPreview(artistName: string, trackName: string): Promise<string | null> {
        const body = await this.deezerGet<any>("/search/track", {
            params: { q: `artist:"${artistName}" track:"${trackName}"`, limit: 1 },
            timeout: 5000,
        });

        const track = body?.data?.[0];
        return track?.preview || null;
    }

    /**
     * Get a preview URL for a track
     */
    async getTrackPreview(artistName: string, trackName: string): Promise<string | null> {
        const cacheKey = `preview:${artistName.toLowerCase()}:${trackName.toLowerCase()}`;

        try {
            return await this.cachedRequest(cacheKey, () => this.searchTrackPreview(artistName, trackName));
        } catch (error: any) {
            logger.error(`Deezer track preview error for ${artistName} - ${trackName}:`, error.message);
            return null;
        }
    }

    /**
     * Get a fresh (uncached) preview URL for a track.
     * Deezer preview URLs are short-lived and should not be persisted for streaming.
     */
    async getFreshTrackPreview(artistName: string, trackName: string): Promise<string | null> {
        try {
            return await this.searchTrackPreview(artistName, trackName);
        } catch (error: any) {
            logger.error(`Deezer fresh track preview error for ${artistName} - ${trackName}:`, error.message);
            return null;
        }
    }

    /**
     * Get album info for a track by searching Deezer
     * Used as fallback when Spotify doesn't provide album data
     */
    async getTrackAlbum(artistName: string, trackName: string): Promise<{ albumName: string; albumId: string } | null> {
        const cacheKey = `track-album:${artistName.toLowerCase()}:${trackName.toLowerCase()}`;

        try {
            return await this.cachedRequest(cacheKey, async () => {
                // Clean track name - remove featuring/with suffixes for better matching
                const cleanTrackName = trackName
                    .replace(/\s*[\(\[](?:feat\.?|ft\.?|with|featuring)[^\)\]]*[\)\]]/gi, "")
                    .replace(/\s*(?:feat\.?|ft\.?|featuring)\s+.*/gi, "")
                    .trim();

                // Use simple space-separated search - more reliable than structured queries
                const query = `${artistName} ${cleanTrackName}`;

                const body = await this.deezerGet<any>("/search/track", {
                    params: { q: query, limit: 5 },
                    timeout: 5000,
                });

                // Find best match - prefer exact artist match
                const tracks = body?.data || [];
                const artistLower = artistName.toLowerCase();

                // First try exact artist match
                let match = tracks.find((t: any) =>
                    t.artist?.name?.toLowerCase() === artistLower
                );

                // Fall back to first result if no exact match
                if (!match && tracks.length > 0) {
                    match = tracks[0];
                }

                if (match?.album?.title) {
                    return {
                        albumName: match.album.title,
                        albumId: String(match.album.id || ""),
                    };
                }

                return null;
            });
        } catch (error: any) {
            logger.debug(`Deezer track album lookup error for ${artistName} - ${trackName}:`, error.message);
            return null;
        }
    }

    /**
     * Parse a Deezer URL and extract the type and ID
     */
    parseUrl(url: string): { type: "playlist" | "album" | "track"; id: string } | null {
        const playlistMatch = url.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/);
        if (playlistMatch) {
            return { type: "playlist", id: playlistMatch[1] };
        }

        const albumMatch = url.match(/deezer\.com\/(?:[a-z]{2}\/)?album\/(\d+)/);
        if (albumMatch) {
            return { type: "album", id: albumMatch[1] };
        }

        const trackMatch = url.match(/deezer\.com\/(?:[a-z]{2}\/)?track\/(\d+)/);
        if (trackMatch) {
            return { type: "track", id: trackMatch[1] };
        }

        return null;
    }

    /**
     * Fetch only the playlist title (lightweight, no track data).
     */
    async getPlaylistName(playlistId: string): Promise<string | null> {
        try {
            const body = await this.deezerGet<any>(`/playlist/${playlistId}`, {
                timeout: 5000,
                params: { limit: 1 },
            });
            return body?.title || null;
        } catch {
            return null;
        }
    }

    /**
     * Fetch a playlist by ID, paginating through all tracks if the playlist exceeds one page.
     */
    async getPlaylist(
        playlistId: string,
        onProgress?: (fetched: number, total: number) => void,
    ): Promise<DeezerPlaylist | null> {
        try {
            logger.debug(`Deezer: Fetching playlist ${playlistId}...`);

            const data = await this.deezerGet<any>(`/playlist/${playlistId}`, {
                timeout: 15000,
            });

            if (data.error) {
                logger.error("Deezer API error:", data.error);
                return null;
            }

            let allTrackData: any[] = data.tracks?.data || [];
            const totalTracks = data.nb_tracks || allTrackData.length;

            // Paginate if the initial response doesn't contain all tracks
            if (totalTracks > allTrackData.length && allTrackData.length > 0) {
                let index = allTrackData.length;
                const limit = 100;

                logger.debug(`Deezer: Playlist has ${totalTracks} tracks, fetched ${allTrackData.length}, paginating remainder...`);

                while (index < totalTracks) {
                    try {
                        const pageData = await this.deezerGet<any>(
                            `/playlist/${playlistId}/tracks`,
                            { params: { index, limit }, timeout: 15000 }
                        );

                        if (pageData.error) {
                            logger.error("Deezer pagination error:", pageData.error);
                            break;
                        }

                        const pageTracks = pageData.data || [];
                        if (pageTracks.length === 0) break;

                        allTrackData.push(...pageTracks);
                        index += pageTracks.length;
                        onProgress?.(allTrackData.length, totalTracks);

                        logger.debug(`Deezer: Fetched ${allTrackData.length}/${totalTracks} tracks`);

                        if (!pageData.next) break;

                        if (index < totalTracks) {
                            await new Promise(r => setTimeout(r, 200));
                        }
                    } catch (error: any) {
                        logger.error(`Deezer: Pagination failed at index ${index}:`, error.message);
                        break;
                    }
                }
            }

            const tracks: DeezerTrack[] = allTrackData.map((track: any) => ({
                deezerId: String(track.id),
                title: track.title || "Unknown",
                artist: track.artist?.name || "Unknown Artist",
                artistId: String(track.artist?.id || ""),
                album: track.album?.title || "Unknown Album",
                albumId: String(track.album?.id || ""),
                durationMs: (track.duration || 0) * 1000,
                previewUrl: track.preview || null,
                coverUrl: track.album?.cover_medium || track.album?.cover || null,
            }));

            logger.debug(`Deezer: Fetched playlist "${data.title}" with ${tracks.length}/${totalTracks} tracks`);

            return {
                id: String(data.id),
                title: data.title || "Unknown Playlist",
                description: data.description || null,
                creator: data.creator?.name || "Unknown",
                imageUrl: data.picture_medium || data.picture || null,
                trackCount: data.nb_tracks || tracks.length,
                tracks,
                isPublic: data.public ?? true,
            };
        } catch (error: any) {
            logger.error("Deezer playlist fetch error:", error.message);
            return null;
        }
    }

    /**
     * Get chart playlists (top playlists)
     */
    async getChartPlaylists(limit: number = 20): Promise<DeezerPlaylistPreview[]> {
        try {
            const body = await this.deezerGet<any>("/chart/0/playlists", {
                params: { limit },
                timeout: 10000,
            });

            return (body?.data || []).map((playlist: any) => ({
                id: String(playlist.id),
                title: playlist.title || "Unknown",
                description: null,
                creator: playlist.user?.name || "Deezer",
                imageUrl: playlist.picture_medium || playlist.picture || null,
                trackCount: playlist.nb_tracks || 0,
                fans: playlist.fans || 0,
            }));
        } catch (error: any) {
            logger.error("Deezer chart playlists error:", error.message);
            return [];
        }
    }

    /**
     * Search for playlists
     */
    async searchPlaylists(query: string, limit: number = 20): Promise<DeezerPlaylistPreview[]> {
        try {
            const body = await this.deezerGet<any>("/search/playlist", {
                params: { q: query, limit },
                timeout: 10000,
            });

            return (body?.data || []).map((playlist: any) => ({
                id: String(playlist.id),
                title: playlist.title || "Unknown",
                description: null,
                creator: playlist.user?.name || "Unknown",
                imageUrl: playlist.picture_medium || playlist.picture || null,
                trackCount: playlist.nb_tracks || 0,
                fans: 0,
            }));
        } catch (error: any) {
            logger.error("Deezer playlist search error:", error.message);
            return [];
        }
    }

    /**
     * Get featured/curated playlists from multiple sources
     * Combines chart playlists with popular genre-based searches
     * Cached for 24 hours
     */
    async getFeaturedPlaylists(limit: number = 50): Promise<DeezerPlaylistPreview[]> {
        const cacheKey = `playlists:featured:${limit}`;

        try {
            return await this.cachedRequest(cacheKey, async () => {
                const allPlaylists: DeezerPlaylistPreview[] = [];
                const seenIds = new Set<string>();

                // 1. Get chart playlists (max 99 available)
                logger.debug("Deezer: Fetching chart playlists from API...");
                const chartPlaylists = await this.getChartPlaylists(Math.min(limit, 99));
                for (const p of chartPlaylists) {
                    if (!seenIds.has(p.id)) {
                        seenIds.add(p.id);
                        allPlaylists.push(p);
                    }
                }
                logger.debug(`Deezer: Got ${chartPlaylists.length} chart playlists`);

                // 2. If we need more, search for popular genre playlists
                if (allPlaylists.length < limit) {
                    const genres = ["pop", "rock", "hip hop", "electronic", "r&b", "indie", "jazz", "classical", "metal", "country"];

                    for (const genre of genres) {
                        if (allPlaylists.length >= limit) break;

                        try {
                            const genrePlaylists = await this.searchPlaylists(genre, 10);
                            for (const p of genrePlaylists) {
                                if (!seenIds.has(p.id) && allPlaylists.length < limit) {
                                    seenIds.add(p.id);
                                    allPlaylists.push(p);
                                }
                            }
                        } catch (e) {
                            // Continue with other genres
                        }
                    }
                }

                const result = allPlaylists.slice(0, limit);
                logger.debug(`Deezer: Caching ${result.length} featured playlists`);
                return result;
            });
        } catch (error: any) {
            logger.error("Deezer featured playlists error:", error.message);
            return [];
        }
    }

    /**
     * Get genres/categories available on Deezer
     * Cached for 24 hours
     */
    async getGenres(): Promise<Array<{ id: number; name: string; imageUrl: string | null }>> {
        const cacheKey = "genres:all";

        try {
            return await this.cachedRequest(cacheKey, async () => {
                logger.debug("Deezer: Fetching genres from API...");
                const body = await this.deezerGet<any>("/genre", {
                    timeout: 10000,
                });

                const genres = (body?.data || [])
                    .filter((g: any) => g.id !== 0) // Skip "All" genre
                    .map((genre: any) => ({
                        id: genre.id,
                        name: genre.name,
                        imageUrl: genre.picture_medium || genre.picture || null,
                    }));

                logger.debug(`Deezer: Caching ${genres.length} genres`);
                return genres;
            });
        } catch (error: any) {
            logger.error("Deezer genres error:", error.message);
            return [];
        }
    }

    /**
     * Get playlists for a specific genre by searching
     */
    async getGenrePlaylists(genreName: string, limit: number = 20): Promise<DeezerPlaylistPreview[]> {
        return this.searchPlaylists(genreName, limit);
    }

    /**
     * Get all radio stations (mood/theme based mixes)
     * Cached for 24 hours
     */
    async getRadioStations(): Promise<DeezerRadioStation[]> {
        const cacheKey = "radio:stations";

        try {
            return await this.cachedRequest(cacheKey, async () => {
                logger.debug("Deezer: Fetching radio stations from API...");
                const body = await this.deezerGet<any>("/radio", {
                    timeout: 10000,
                });

                const stations = (body?.data || []).map((radio: any) => ({
                    id: String(radio.id),
                    title: radio.title || "Unknown",
                    description: null,
                    imageUrl: radio.picture_medium || radio.picture || null,
                    type: "radio" as const,
                }));

                logger.debug(`Deezer: Got ${stations.length} radio stations, caching...`);
                return stations;
            });
        } catch (error: any) {
            logger.error("Deezer radio stations error:", error.message);
            return [];
        }
    }

    /**
     * Get radio stations organized by genre
     * Cached for 24 hours
     */
    async getRadiosByGenre(): Promise<DeezerGenreWithRadios[]> {
        const cacheKey = "radio:by-genre";

        try {
            return await this.cachedRequest(cacheKey, async () => {
                logger.debug("Deezer: Fetching radios by genre from API...");
                const body = await this.deezerGet<any>("/radio/genres", {
                    timeout: 10000,
                });

                const genres = (body?.data || []).map((genre: any) => ({
                    id: genre.id,
                    name: genre.title || "Unknown",
                    radios: (genre.radios || []).map((radio: any) => ({
                        id: String(radio.id),
                        title: radio.title || "Unknown",
                        description: null,
                        imageUrl: radio.picture_medium || radio.picture || null,
                        type: "radio" as const,
                    })),
                }));

                logger.debug(`Deezer: Got ${genres.length} genre categories with radios, caching...`);
                return genres;
            });
        } catch (error: any) {
            logger.error("Deezer radios by genre error:", error.message);
            return [];
        }
    }

    /**
     * Get tracks from a radio station (returns as DeezerPlaylist for consistency)
     */
    async getRadioTracks(radioId: string): Promise<DeezerPlaylist | null> {
        try {
            // Cache the assembled playlist so we don't hit Deezer twice (radio info +
            // tracks) on every call (35b review).
            return await this.cachedRequest(`radio:tracks:${radioId}`, async () => {
            logger.debug(`Deezer: Fetching radio ${radioId} tracks...`);

            // First get radio info
            const radioInfo = await this.deezerGet<any>(`/radio/${radioId}`, {
                timeout: 10000,
            });

            // Then get tracks
            const tracksBody = await this.deezerGet<any>(`/radio/${radioId}/tracks`, {
                params: { limit: 100 },
                timeout: 15000,
            });

            const tracks: DeezerTrack[] = (tracksBody?.data || []).map((track: any) => ({
                deezerId: String(track.id),
                title: track.title || "Unknown",
                artist: track.artist?.name || "Unknown Artist",
                artistId: String(track.artist?.id || ""),
                album: track.album?.title || "Unknown Album",
                albumId: String(track.album?.id || ""),
                durationMs: (track.duration || 0) * 1000,
                previewUrl: track.preview || null,
                coverUrl: track.album?.cover_medium || track.album?.cover || null,
            }));

            logger.debug(`Deezer: Fetched radio "${radioInfo.title}" with ${tracks.length} tracks`);

            return {
                id: `radio-${radioId}`,
                title: radioInfo.title || "Radio Station",
                description: `Deezer Radio - ${radioInfo.title}`,
                creator: "Deezer",
                imageUrl: radioInfo.picture_medium || radioInfo.picture || null,
                trackCount: tracks.length,
                tracks,
                isPublic: true,
            };
            });
        } catch (error: any) {
            logger.error("Deezer radio tracks error:", error.message);
            return null;
        }
    }

    /**
     * Get editorial/curated content for a specific genre
     * Returns releases and playlists for that genre
     */
    async getEditorialContent(genreId: number): Promise<{
        playlists: DeezerPlaylistPreview[];
        radios: DeezerRadioStation[];
    }> {
        try {
            // Get genre-specific playlists via search
            const genreBody = await this.deezerGet<any>(`/genre/${genreId}`, {
                timeout: 10000,
            });
            const genreName = genreBody?.name || "";

            // Search for playlists with this genre
            const playlists = genreName ? await this.searchPlaylists(genreName, 20) : [];

            // Get radios for this genre from getRadiosByGenre (24h cached) instead of
            // re-fetching /radio/genres uncached on every call (35b review).
            const genreRadios = (await this.getRadiosByGenre()).find(
                (g) => g.id === genreId
            );
            const radios: DeezerRadioStation[] = genreRadios?.radios ?? [];

            return { playlists, radios };
        } catch (error: any) {
            logger.error("Deezer editorial content error:", error.message);
            return { playlists: [], radios: [] };
        }
    }

    // Not cached: user queries are high-cardinality and Deezer's search is fast (<300ms).
    // Only the popular-podcasts feed is cached since it's a shared response.
    async searchPodcasts(query: string, limit: number = 20): Promise<DeezerPodcast[]> {
        try {
            const body = await this.deezerGet<any>("/search/podcast", {
                params: { q: query, limit },
                timeout: 10000,
            });

            return (body?.data || []).map((podcast: any) => ({
                id: podcast.id,
                title: podcast.title || "Unknown",
                description: podcast.description || "",
                fans: podcast.fans || 0,
                link: podcast.link || "",
                pictureUrl: podcast.picture_big || podcast.picture_medium || podcast.picture || null,
            }));
        } catch (error: any) {
            logger.error("Deezer podcast search error:", error.message);
            return [];
        }
    }

    async getTopPodcasts(limit: number = 20): Promise<DeezerPodcast[]> {
        const cacheKey = `podcasts:top:${limit}`;

        try {
            return await this.cachedRequest(cacheKey, async () => {
                const body = await this.deezerGet<any>("/chart/0/podcasts", {
                    params: { limit },
                    timeout: 10000,
                });

                return (body?.data || []).map((podcast: any) => ({
                    id: podcast.id,
                    title: podcast.title || "Unknown",
                    description: podcast.description || "",
                    fans: podcast.fans || 0,
                    link: podcast.link || "",
                    pictureUrl: podcast.picture_big || podcast.picture_medium || podcast.picture || null,
                }));
            });
        } catch (error: any) {
            logger.error("Deezer top podcasts error:", error.message);
            return [];
        }
    }
}

export const deezerService = new DeezerService();

/**
 * Dedupe podcast results by normalized title. iTunes results are preferred
 * (they carry feedUrl); Deezer results fill gaps only when title is unseen.
 */
export function mergeAndDedupePodcasts<T extends { title?: string; name?: string }>(
    primary: T[],
    fallback: T[]
): T[] {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of [...primary, ...fallback]) {
        const key = normalize(item.title ?? item.name ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
