import axios from "axios";
import { logger } from "../utils/logger";
import { deezerService } from "./deezer";
import { rateLimiter } from "./rateLimiter";

/**
 * Fetches public Spotify playlist data with anonymous web-player tokens, so no
 * API credentials are needed. Falls back to Deezer when Spotify scraping fails.
 */

export interface SpotifyTrack {
    spotifyId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    isrc: string | null;
    durationMs: number;
    trackNumber: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

interface SpotifyPlaylist {
    id: string;
    name: string;
    description: string | null;
    owner: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: SpotifyTrack[];
    isPublic: boolean;
}

// URL patterns
const SPOTIFY_PLAYLIST_REGEX = /(?:spotify\.com\/playlist\/|spotify:playlist:)([a-zA-Z0-9]+)/;
const SPOTIFY_ALBUM_REGEX = /(?:spotify\.com\/album\/|spotify:album:)([a-zA-Z0-9]+)/;
const SPOTIFY_TRACK_REGEX = /(?:spotify\.com\/track\/|spotify:track:)([a-zA-Z0-9]+)/;

class SpotifyService {
    private anonymousToken: string | null = null;
    private tokenExpiry: number = 0;
    private tokenRefreshPromise: Promise<string | null> | null = null;

    /**
     * Get anonymous access token from Spotify web player
     * Uses promise singleton pattern to prevent race conditions
     */
    private async getAnonymousToken(): Promise<string | null> {
        if (this.anonymousToken && Date.now() < this.tokenExpiry - 60000) {
            return this.anonymousToken;
        }

        if (this.tokenRefreshPromise) {
            return this.tokenRefreshPromise;
        }

        this.tokenRefreshPromise = this.performTokenRefresh();

        try {
            return await this.tokenRefreshPromise;
        } finally {
            this.tokenRefreshPromise = null;
        }
    }

    /**
     * Perform the actual token refresh - try multiple endpoints for reliability
     */
    private async performTokenRefresh(): Promise<string | null> {
        const endpoints = [
            {
                url: "https://open.spotify.com/get_access_token",
                params: { reason: "transport", productType: "web_player" }
            },
            {
                url: "https://open.spotify.com/get_access_token",
                params: { reason: "init", productType: "embed" }
            }
        ];

        for (const endpoint of endpoints) {
            try {
                logger.debug(`Spotify: Fetching anonymous token from ${endpoint.url}...`);

                const response = await axios.get(endpoint.url, {
                    params: endpoint.params,
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                        "Accept": "application/json",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Origin": "https://open.spotify.com",
                        "Referer": "https://open.spotify.com/",
                    },
                    timeout: 10000,
                });

                const token = response.data?.accessToken;
                if (token) {
                    this.anonymousToken = token;
                    // Anonymous tokens last about an hour
                    this.tokenExpiry = Date.now() + 3600 * 1000;

                    logger.debug("Spotify: Got anonymous token");
                    return token;
                }
            } catch (error: any) {
                logger.debug(`Spotify: Token endpoint failed (${error.response?.status || error.message})`);
            }
        }

        logger.error("Spotify: All token endpoints failed - API browsing unavailable");
        return null;
    }

    /**
     * Parse a Spotify URL and extract the type and ID
     */
    parseUrl(url: string): { type: "playlist" | "album" | "track"; id: string } | null {
        const playlistMatch = url.match(SPOTIFY_PLAYLIST_REGEX);
        if (playlistMatch) {
            return { type: "playlist", id: playlistMatch[1] };
        }

        const albumMatch = url.match(SPOTIFY_ALBUM_REGEX);
        if (albumMatch) {
            return { type: "album", id: albumMatch[1] };
        }

        const trackMatch = url.match(SPOTIFY_TRACK_REGEX);
        if (trackMatch) {
            return { type: "track", id: trackMatch[1] };
        }

        return null;
    }

    /**
     * Extract track data from Apollo/GraphQL cache in page HTML
     * Spotify sometimes stores data in Apollo cache format instead of __NEXT_DATA__
     */
    private extractTracksFromApolloCache(html: string): Array<{ trackId: string; albumName: string; albumId: string }> {
        const tracks: Array<{ trackId: string; albumName: string; albumId: string }> = [];

        try {
            // Look for Apollo cache script tags
            const apolloPatterns = [
                /<script[^>]*>window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?})<\/script>/,
                /<script[^>]*>self\.__next_f\.push\(\[1,"[\d]+:({[\s\S]*?})"\]\)<\/script>/,
                /window\["__APOLLO_STATE__"\]\s*=\s*({[\s\S]*?});/,
            ];

            for (const pattern of apolloPatterns) {
                const match = html.match(pattern);
                if (match) {
                    logger.debug("Spotify Scraper: Found Apollo cache pattern");
                    try {
                        const apolloData = JSON.parse(match[1]);

                        // Apollo cache stores entities by their cache key (e.g., "Track:spotify:track:xxx")
                        for (const [key, value] of Object.entries(apolloData)) {
                            if (key.startsWith("Track:") && typeof value === "object" && value !== null) {
                                const trackData = value as Record<string, any>;
                                const trackId = key.split(":").pop() || trackData.id;
                                const albumRef = trackData.album || trackData.albumOfTrack;

                                // Album might be a reference to another cache entry
                                let albumName: string | undefined;
                                let albumId: string | undefined;

                                if (typeof albumRef === "string" && albumRef.startsWith("Album:")) {
                                    const albumKey = albumRef;
                                    const albumData = apolloData[albumKey] as Record<string, any> | undefined;
                                    if (albumData) {
                                        albumName = albumData.name;
                                        albumId = albumKey.split(":").pop();
                                    }
                                } else if (typeof albumRef === "object" && albumRef !== null) {
                                    albumName = albumRef.name;
                                    albumId = albumRef.uri?.split(":")[2] || albumRef.id;
                                }

                                if (trackId && albumName && albumName !== "Unknown Album") {
                                    tracks.push({ trackId, albumName, albumId: albumId || "" });
                                }
                            }
                        }

                        if (tracks.length > 0) {
                            logger.debug(`Spotify Scraper: Extracted ${tracks.length} tracks from Apollo cache`);
                            return tracks;
                        }
                    } catch {
                        logger.debug("Spotify Scraper: Failed to parse Apollo cache JSON");
                    }
                }
            }
        } catch (error: any) {
            logger.debug(`Spotify Scraper: Apollo cache extraction failed: ${error.message}`);
        }

        return tracks;
    }

    /**
     * Album data scraped from the playlist page, for when the API says "Unknown
     * Album". Tries __NEXT_DATA__ JSON, then the Apollo cache, then HTML regexes.
     */
    private async scrapePlaylistPageForAlbums(playlistId: string): Promise<Map<string, { album: string; albumId: string }>> {
        const albumMap = new Map<string, { album: string; albumId: string }>();

        try {
            logger.debug(`Spotify Scraper: Starting album scrape for playlist ${playlistId}`);

            const response = await axios.get(
                `https://open.spotify.com/playlist/${playlistId}`,
                {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                    timeout: 15000,
                }
            );

            const html = response.data;
            logger.debug(`Spotify Scraper: Received HTML response (${html.length} bytes)`);

            // Method 1: Try to extract from __NEXT_DATA__ JSON with multiple path fallbacks
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
            if (nextDataMatch) {
                logger.debug("Spotify Scraper: Found __NEXT_DATA__ script tag");
                try {
                    const data = JSON.parse(nextDataMatch[1]);

                    const propsKeys = Object.keys(data?.props?.pageProps || {});
                    logger.debug(`Spotify Scraper: pageProps keys: [${propsKeys.join(", ")}]`);

                    const stateDataKeys = Object.keys(data?.props?.pageProps?.state?.data || {});
                    logger.debug(`Spotify Scraper: state.data keys: [${stateDataKeys.join(", ")}]`);

                    // Try multiple JSON paths - Spotify changes these frequently
                    const jsonPaths = [
                        { path: "entity.trackList", getter: () => data?.props?.pageProps?.state?.data?.entity?.trackList },
                        { path: "entity.tracks.items", getter: () => data?.props?.pageProps?.state?.data?.entity?.tracks?.items },
                        { path: "playlistV2.content.items", getter: () => data?.props?.pageProps?.state?.data?.playlistV2?.content?.items },
                        { path: "playlist.tracks.items", getter: () => data?.props?.pageProps?.state?.data?.playlist?.tracks?.items },
                        { path: "playlistState.playlist.tracks.items", getter: () => data?.props?.pageProps?.playlistState?.playlist?.tracks?.items },
                        { path: "pageProps.playlist.tracks.items", getter: () => data?.props?.pageProps?.playlist?.tracks?.items },
                    ];

                    let trackItems: any[] = [];
                    let successfulPath: string | null = null;

                    for (const { path, getter } of jsonPaths) {
                        try {
                            const items = getter();
                            if (Array.isArray(items) && items.length > 0) {
                                trackItems = items;
                                successfulPath = path;
                                logger.debug(`Spotify Scraper: Found ${items.length} items at path: ${path}`);
                                break;
                            }
                        } catch {
                            // Path doesn't exist, continue to next
                        }
                    }

                    if (trackItems.length === 0) {
                        logger.debug("Spotify Scraper: No track items found in any __NEXT_DATA__ path");
                    } else {
                        logger.debug(`Spotify Scraper: Processing ${trackItems.length} track items from ${successfulPath}`);
                    }

                    for (const item of trackItems) {
                        const track = item.track || item.itemV2?.data || item;

                        const trackId = track.uri?.split(":")[2]
                            || track.id
                            || item.uid
                            || item.itemV2?.data?.uri?.split(":")[2];

                        const albumName = track.album?.name
                            || track.albumOfTrack?.name
                            || item.itemV2?.data?.albumOfTrack?.name;

                        const albumId = track.album?.uri?.split(":")[2]
                            || track.album?.id
                            || track.albumOfTrack?.uri?.split(":")[2]
                            || item.itemV2?.data?.albumOfTrack?.uri?.split(":")[2];

                        if (trackId && albumName && albumName !== "Unknown Album") {
                            albumMap.set(trackId, { album: albumName, albumId: albumId || "" });
                        }
                    }

                    if (albumMap.size > 0) {
                        logger.debug(`Spotify Scraper: Extracted ${albumMap.size} album entries from __NEXT_DATA__ (${successfulPath})`);
                        return albumMap;
                    } else {
                        logger.debug("Spotify Scraper: __NEXT_DATA__ parsing yielded no valid album data");
                    }
                } catch (e: any) {
                    logger.debug(`Spotify Scraper: Failed to parse __NEXT_DATA__: ${e.message}`);
                }
            } else {
                logger.debug("Spotify Scraper: __NEXT_DATA__ script tag not found in HTML");
            }

            // Method 2: Try Apollo/GraphQL cache extraction
            logger.debug("Spotify Scraper: Attempting Apollo cache extraction...");
            const apolloTracks = this.extractTracksFromApolloCache(html);
            if (apolloTracks.length > 0) {
                for (const { trackId, albumName, albumId } of apolloTracks) {
                    albumMap.set(trackId, { album: albumName, albumId });
                }
                logger.debug(`Spotify Scraper: Extracted ${albumMap.size} album entries from Apollo cache`);
                return albumMap;
            }

            // Method 3: Fallback to HTML regex parsing
            logger.debug("Spotify Scraper: Attempting HTML regex parsing...");
            const rowPattern = /<div[^>]*role="row"[^>]*aria-rowindex="(\d+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*role="row"|<div[^>]*data-testid="bottom-sentinel")/g;
            let rowMatch;
            let rowCount = 0;

            while ((rowMatch = rowPattern.exec(html)) !== null) {
                rowCount++;
                const rowContent = rowMatch[2];

                const trackLinkMatch = rowContent.match(/href="\/track\/([a-zA-Z0-9]+)"/);
                // Extract album info from album link (aria-colindex="3" contains album)
                const albumLinkMatch = rowContent.match(/href="\/album\/([a-zA-Z0-9]+)"[^>]*>([^<]+)</);

                if (trackLinkMatch && albumLinkMatch) {
                    const trackId = trackLinkMatch[1];
                    const albumId = albumLinkMatch[1];
                    const albumName = albumLinkMatch[2].trim();

                    if (albumName && albumName !== "Unknown Album") {
                        albumMap.set(trackId, { album: albumName, albumId });
                    }
                }
            }

            if (rowCount > 0) {
                logger.debug(`Spotify Scraper: Parsed ${rowCount} HTML rows, extracted ${albumMap.size} album entries`);
            } else {
                logger.debug("Spotify Scraper: No HTML rows matched the regex pattern");
            }

        } catch (error: any) {
            logger.debug(`Spotify Scraper: Page scraping failed: ${error.message}`);
        }

        if (albumMap.size === 0) {
            logger.debug("Spotify Scraper: All extraction methods failed - no album data recovered");
        }

        return albumMap;
    }

    /**
     * Scrape individual track pages to get album data
     * This is a last resort fallback - expensive but reliable
     */
    private async scrapeTrackPagesForAlbums(
        tracks: Array<{ spotifyId: string; title: string; artist: string }>
    ): Promise<Map<string, { album: string; albumId: string }>> {
        const albumMap = new Map<string, { album: string; albumId: string }>();

        // Limit to first 30 tracks to avoid rate limiting
        const tracksToScrape = tracks.slice(0, 30);

        logger.debug(`[Spotify Track Scraper] Scraping ${tracksToScrape.length} individual track pages...`);

        for (const track of tracksToScrape) {
            if (albumMap.has(track.spotifyId)) continue;

            try {
                const response = await axios.get(
                    `https://open.spotify.com/track/${track.spotifyId}`,
                    {
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                            "Accept": "text/html",
                        },
                        timeout: 10000,
                    }
                );

                const html = response.data;
                let albumName: string | null = null;

                // Method 1: Extract from og:description meta tag
                // Format: "Artist · Album · Song · Year"
                const ogDescMatch = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/);
                if (ogDescMatch) {
                    const description = ogDescMatch[1];
                    const parts = description.split(" · ");
                    // Format: Artist · Album · Song · Year (4 parts minimum)
                    // Note: For singles, album name often equals track title - this is valid
                    if (parts.length >= 3) {
                        const potentialAlbum = parts[1].trim();
                        if (potentialAlbum) {
                            albumName = potentialAlbum;
                            logger.debug(`[Spotify Track Scraper] Found album via og:description for "${track.title}": "${albumName}"`);
                        }
                    }
                }

                // Method 2: Fallback to __NEXT_DATA__ if available
                if (!albumName) {
                    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
                    if (nextDataMatch) {
                        try {
                            const data = JSON.parse(nextDataMatch[1]);
                            const trackData = data?.props?.pageProps?.state?.data?.entity
                                || data?.props?.pageProps?.track
                                || data?.props?.pageProps?.state?.data?.trackUnion;

                            albumName = trackData?.album?.name
                                || trackData?.albumOfTrack?.name
                                || trackData?.album?.title;

                            if (albumName) {
                                const albumId = trackData?.album?.uri?.split(":")[2]
                                    || trackData?.albumOfTrack?.uri?.split(":")[2]
                                    || trackData?.album?.id;
                                if (albumName !== "Unknown Album") {
                                    albumMap.set(track.spotifyId, { album: albumName, albumId: albumId || "" });
                                    logger.debug(`[Spotify Track Scraper] Found album via __NEXT_DATA__ for "${track.title}": "${albumName}"`);
                                }
                            }
                        } catch {
                            // JSON parse failed, continue
                        }
                    }
                }

                // Store if we found album via og:description (Method 1)
                if (albumName && albumName !== "Unknown Album" && !albumMap.has(track.spotifyId)) {
                    albumMap.set(track.spotifyId, { album: albumName, albumId: "" });
                }

                // Rate limit - wait 300ms between requests
                await new Promise(resolve => setTimeout(resolve, 300));

            } catch (error: unknown) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.debug(`[Spotify Track Scraper] Failed for track ${track.spotifyId}: ${errorMsg}`);
            }
        }

        logger.debug(`[Spotify Track Scraper] Scraped ${albumMap.size} albums from track pages`);
        return albumMap;
    }

    /**
     * Resolve album names using Deezer search as fallback
     * This is used when Spotify scraping fails
     */
    private async resolveAlbumsViaDeezer(
        tracks: Array<{ spotifyId: string; title: string; artist: string }>
    ): Promise<Map<string, { album: string; albumId: string }>> {
        const albumMap = new Map<string, { album: string; albumId: string }>();

        // Limit to first 50 tracks to avoid overwhelming Deezer
        const tracksToResolve = tracks.slice(0, 50);

        logger.debug(`[Deezer Fallback] Resolving ${tracksToResolve.length} tracks via Deezer...`);

        for (const track of tracksToResolve) {
            if (albumMap.has(track.spotifyId)) continue;

            try {
                const result = await rateLimiter.execute("deezer", () =>
                    deezerService.getTrackAlbum(track.artist, track.title)
                );
                if (result) {
                    albumMap.set(track.spotifyId, {
                        album: result.albumName,
                        albumId: `deezer:${result.albumId}`,
                    });
                    logger.debug(`[Deezer Fallback] Found album for "${track.title}": "${result.albumName}"`);
                }
            } catch (error: any) {
                logger.debug(`[Deezer Fallback] Lookup failed for "${track.title}", skipping: ${error.message}`);
            }
        }

        logger.debug(`[Deezer Fallback] Resolved ${albumMap.size} albums via Deezer`);
        return albumMap;
    }

    /**
     * Paginate through all tracks in a Spotify playlist via the dedicated tracks endpoint.
     * Called when the initial /playlists/{id} response contains fewer items than tracks.total.
     */
    private async fetchAllPlaylistTracks(
        playlistId: string,
        token: string,
        total: number,
        firstPageItems: any[],
        onProgress?: (fetched: number, total: number) => void,
    ): Promise<any[]> {
        const allItems = [...firstPageItems];
        const limit = 50;
        let offset = firstPageItems.length;
        let currentToken = token;
        let hasRefreshedToken = false;
        let rateLimitRetries = 0;
        const MAX_RATE_LIMIT_RETRIES = 5;
        const trackFields = "items(track(id,name,artists(id,name),album(id,name,images),duration_ms,track_number,preview_url,external_ids)),next,total";

        logger.debug(`Spotify: Playlist has ${total} tracks, fetched ${allItems.length}, paginating remainder...`);

        while (true) {
            try {
                const response = await axios.get(
                    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
                    {
                        headers: {
                            Authorization: `Bearer ${currentToken}`,
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        },
                        params: { offset, limit, fields: trackFields },
                        timeout: 15000,
                    }
                );

                const items = response.data?.items || [];
                if (items.length === 0) break;

                allItems.push(...items);
                offset += items.length;

                if (response.data?.total && response.data.total > total) {
                    total = response.data.total;
                }

                onProgress?.(allItems.length, Math.max(total, allItems.length));

                logger.debug(`Spotify: Fetched ${allItems.length}/${Math.max(total, allItems.length)} tracks`);

                if (items.length < limit) break; // Last page (partial)

                await new Promise(r => setTimeout(r, 100));
            } catch (error: any) {
                if (error.response?.status === 429) {
                    rateLimitRetries++;
                    if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
                        logger.warn(`Spotify: Rate limited ${rateLimitRetries} times, giving up pagination at offset ${offset} — returning ${allItems.length} tracks fetched so far`);
                        break;
                    }
                    const retryAfter = parseInt(error.response?.headers?.["retry-after"] || "5", 10);
                    logger.warn(`Spotify: Rate limited, waiting ${retryAfter}s... (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`);
                    await new Promise(r => setTimeout(r, retryAfter * 1000));
                    continue;
                }
                if (error.response?.status === 401 && !hasRefreshedToken) {
                    hasRefreshedToken = true;
                    logger.warn("Spotify: Token expired mid-pagination, refreshing...");
                    this.anonymousToken = null;
                    this.tokenExpiry = 0;
                    const newToken = await this.getAnonymousToken();
                    if (newToken) {
                        currentToken = newToken;
                        continue;
                    }
                    break;
                }
                logger.error(`Spotify: Pagination failed at offset ${offset}:`, error.message);
                break;
            }
        }

        return allItems;
    }

    /**
     * Fetch playlist via anonymous token
     */
    private async fetchPlaylistViaAnonymousApi(
        playlistId: string,
        onProgress?: (fetched: number, total: number) => void,
    ): Promise<SpotifyPlaylist | null> {
        const token = await this.getAnonymousToken();
        if (!token) {
            return await this.fetchPlaylistViaEmbedHtml(playlistId);
        }

        try {
            logger.debug(`Spotify: Fetching playlist ${playlistId}...`);

            const playlistResponse = await axios.get(
                `https://api.spotify.com/v1/playlists/${playlistId}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                    params: {
                        fields: "id,name,description,owner.display_name,images,public,tracks.total,tracks.items(track(id,name,artists(id,name),album(id,name,images),duration_ms,track_number,preview_url,external_ids))",
                    },
                    timeout: 15000,
                }
            );

            const playlist = playlistResponse.data;
            const totalTracks = playlist.tracks?.total || 0;
            let allItems = playlist.tracks?.items || [];

            // Paginate if API reports more tracks, OR if we received a full page
            // (speculative: Spotify anonymous tokens may cap total at 100)
            const PAGE_SIZE = 100;
            if (allItems.length > 0 && (totalTracks > allItems.length || allItems.length >= PAGE_SIZE)) {
                const effectiveTotal = Math.max(totalTracks, allItems.length + 1);
                allItems = await this.fetchAllPlaylistTracks(
                    playlistId, token, effectiveTotal, allItems, onProgress
                );
            }

            logger.debug(`Spotify: Fetched playlist "${playlist.name}" with ${allItems.length}/${totalTracks} tracks`);

            const tracks: SpotifyTrack[] = [];

            for (const item of allItems) {
                const track = item.track;
                if (!track || !track.id) {
                    continue;
                }

                const albumName = track.album?.name?.trim() || "Unknown Album";

                tracks.push({
                    spotifyId: track.id,
                    title: track.name,
                    artist: track.artists?.[0]?.name || "Unknown Artist",
                    artistId: track.artists?.[0]?.id || "",
                    album: albumName,
                    albumId: track.album?.id || "",
                    isrc: track.external_ids?.isrc || null,
                    durationMs: track.duration_ms || 0,
                    trackNumber: track.track_number || 0,
                    previewUrl: track.preview_url || null,
                    coverUrl: track.album?.images?.[0]?.url || null,
                });
            }

            await this.fillUnknownAlbums(playlistId, tracks);

            logger.debug(`Spotify: Processed ${tracks.length} tracks`);

            return {
                id: playlist.id,
                name: playlist.name,
                description: playlist.description,
                owner: playlist.owner?.display_name || "Unknown",
                imageUrl: playlist.images?.[0]?.url || null,
                trackCount: tracks.length,
                tracks,
                isPublic: playlist.public ?? true,
            };
        } catch (error: any) {
            logger.error("Spotify API error:", error.response?.status, error.response?.data || error.message);

            // Fallback to embed HTML parsing
            return await this.fetchPlaylistViaEmbedHtml(playlistId);
        }
    }

    /**
     * Fills in tracks Spotify gave no album for, from the playlist page, then each
     * track's page, then Deezer, each tier trying only what the last one missed.
     */
    private async fillUnknownAlbums(playlistId: string, tracks: SpotifyTrack[]): Promise<void> {
        const lookup = (pending: SpotifyTrack[]) =>
            pending.map(t => ({ spotifyId: t.spotifyId, title: t.title, artist: t.artist }));
        const tiers: Array<[string, (pending: SpotifyTrack[]) => Promise<Map<string, { album: string; albumId: string }>>]> = [
            ["playlist page scraping", () => this.scrapePlaylistPageForAlbums(playlistId)],
            ["track page scraping", pending => this.scrapeTrackPagesForAlbums(lookup(pending))],
            ["Deezer", pending => this.resolveAlbumsViaDeezer(lookup(pending))],
        ];

        for (const [label, resolve] of tiers) {
            const pending = tracks.filter(t => t.album === "Unknown Album");
            if (pending.length === 0) return;

            logger.debug(`Spotify: ${pending.length} tracks have Unknown Album, trying ${label}...`);
            const found = await resolve(pending);

            let enriched = 0;
            for (const track of pending) {
                const albumData = found.get(track.spotifyId);
                if (!albumData) continue;
                track.album = albumData.album;
                track.albumId = albumData.albumId;
                enriched++;
            }
            logger.debug(`Spotify: Enriched ${enriched}/${pending.length} tracks via ${label}`);
        }
    }

    /**
     * Last resort: Parse embed HTML for track data
     */
    private async fetchPlaylistViaEmbedHtml(playlistId: string): Promise<SpotifyPlaylist | null> {
        try {
            logger.debug("Spotify: Trying embed HTML parsing...");
            
            const response = await axios.get(
                `https://open.spotify.com/embed/playlist/${playlistId}`,
                {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                    timeout: 10000,
                }
            );

            const html = response.data;
            const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
            
            if (!match) {
                logger.error("Spotify: Could not find __NEXT_DATA__ in embed HTML");
                return null;
            }

            const data = JSON.parse(match[1]);
            
            const playlistData = data.props?.pageProps?.state?.data?.entity 
                || data.props?.pageProps?.state?.data 
                || data.props?.pageProps;

            if (!playlistData) {
                logger.error("Spotify: Could not find playlist data in embed JSON");
                return null;
            }

            const tracks: SpotifyTrack[] = [];
            const trackList = playlistData.trackList || playlistData.tracks?.items || [];

            for (const item of trackList) {
                const trackData = item.track || item;
                
                // Extract primary artist - prefer artists array first element, fall back to subtitle
                // subtitle often contains "Artist1, Artist2, Artist3" but we want only primary
                let primaryArtist = trackData.artists?.[0]?.name;
                if (!primaryArtist && trackData.subtitle) {
                    primaryArtist = trackData.subtitle.split(",")[0].trim();
                }
                primaryArtist = primaryArtist || "Unknown Artist";

                const embedAlbumName = trackData.album?.name || trackData.albumName || "Unknown Album";

                // Debug log for tracks with Unknown Album
                if (embedAlbumName === "Unknown Album") {
                    logger.debug(`Spotify Embed: Track "${trackData.title || trackData.name}" has no album data:`, JSON.stringify({
                        album: trackData.album,
                        albumName: trackData.albumName,
                        hasAlbum: !!trackData.album,
                    }));
                }

                tracks.push({
                    spotifyId: trackData.uri?.split(":")[2] || trackData.id || "",
                    title: trackData.title || trackData.name || "Unknown",
                    artist: primaryArtist,
                    artistId: trackData.artists?.[0]?.uri?.split(":")[2] || trackData.artists?.[0]?.id || "",
                    album: embedAlbumName,
                    albumId: trackData.album?.uri?.split(":")[2] || trackData.album?.id || "",
                    isrc: null,
                    durationMs: trackData.duration || trackData.duration_ms || 0,
                    trackNumber: 0,
                    previewUrl: null,
                    coverUrl: trackData.album?.images?.[0]?.url || trackData.images?.[0]?.url || null,
                });
            }

            await this.fillUnknownAlbums(playlistId, tracks);

            return {
                id: playlistId,
                name: playlistData.name || "Unknown Playlist",
                description: playlistData.description || null,
                owner: playlistData.ownerV2?.data?.name || playlistData.owner?.display_name || "Unknown",
                imageUrl: playlistData.images?.items?.[0]?.sources?.[0]?.url || playlistData.images?.[0]?.url || null,
                trackCount: trackList.length,
                tracks,
                isPublic: true,
            };
        } catch (error: any) {
            logger.error("Spotify embed HTML error:", error.message);
            return null;
        }
    }

    /**
     * Fetch a playlist by ID or URL
     */
    async getPlaylist(
        urlOrId: string,
        onProgress?: (fetched: number, total: number) => void,
    ): Promise<SpotifyPlaylist | null> {
        let playlistId = urlOrId;
        const parsed = this.parseUrl(urlOrId);
        if (parsed) {
            if (parsed.type !== "playlist") {
                throw new Error(`Expected playlist URL, got ${parsed.type}`);
            }
            playlistId = parsed.id;
        }

        logger.debug("Spotify: Fetching public playlist via anonymous token");
        return await this.fetchPlaylistViaAnonymousApi(playlistId, onProgress);
    }

    /**
     * Fetch only the playlist name (lightweight, no track data).
     */
    async getPlaylistName(urlOrId: string): Promise<string | null> {
        let playlistId = urlOrId;
        const parsed = this.parseUrl(urlOrId);
        if (parsed) playlistId = parsed.id;

        const token = await this.getAnonymousToken();
        if (!token) return null;

        try {
            const resp = await axios.get(
                `https://api.spotify.com/v1/playlists/${playlistId}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                    params: { fields: "name" },
                    timeout: 5000,
                },
            );
            return resp.data?.name || null;
        } catch {
            // A failed playlist lookup counts as no name.
            return null;
        }
    }

    async getTrackBySpotifyId(spotifyId: string): Promise<SpotifyTrack | null> {
        const token = await this.getAnonymousToken();
        if (!token) return null;
        try {
            const resp = await axios.get(
                `https://api.spotify.com/v1/tracks/${spotifyId}`,
                {
                    headers: { Authorization: `Bearer ${token}`, "User-Agent": "Mozilla/5.0" },
                    timeout: 5000,
                },
            );
            const t = resp.data;
            return {
                spotifyId: t.id,
                title: t.name,
                artist: t.artists?.[0]?.name || "",
                artistId: t.artists?.[0]?.id || "",
                album: t.album?.name || "",
                albumId: t.album?.id || "",
                isrc: t.external_ids?.isrc || null,
                durationMs: t.duration_ms,
                trackNumber: t.track_number,
                previewUrl: t.preview_url || null,
                coverUrl: t.album?.images?.[0]?.url || null,
            };
        } catch {
            // A failed track lookup counts as no track.
            return null;
        }
    }
}

export const spotifyService = new SpotifyService();
