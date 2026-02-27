import axios from "axios";
import { logger } from "../utils/logger";
import { deezerService } from "./deezer";
import { rateLimiter } from "./rateLimiter";

/**
 * Spotify Service
 *
 * Fetches public playlist data from Spotify using anonymous tokens.
 * No API credentials required - uses Spotify's web player token endpoint.
 * Falls back to Deezer API when Spotify scraping fails.
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

export interface SpotifyPlaylist {
    id: string;
    name: string;
    description: string | null;
    owner: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: SpotifyTrack[];
    isPublic: boolean;
}

export interface SpotifyAlbum {
    id: string;
    name: string;
    artist: string;
    artistId: string;
    imageUrl: string | null;
    releaseDate: string | null;
    trackCount: number;
}

export interface SpotifyPlaylistPreview {
    id: string;
    name: string;
    description: string | null;
    owner: string;
    imageUrl: string | null;
    trackCount: number;
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
        // Check if we have a valid token
        if (this.anonymousToken && Date.now() < this.tokenExpiry - 60000) {
            return this.anonymousToken;
        }

        // If already fetching, wait for that promise (prevents race condition)
        if (this.tokenRefreshPromise) {
            return this.tokenRefreshPromise;
        }

        // Start new fetch and store the promise
        this.tokenRefreshPromise = this.performTokenRefresh();

        try {
            return await this.tokenRefreshPromise;
        } finally {
            // Clear the promise once complete
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
                    } catch (parseError) {
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
     * Scrape the full Spotify playlist page HTML to extract album data
     * This is used as a fallback when the API returns "Unknown Album"
     *
     * Tries multiple extraction methods in order of reliability:
     * 1. __NEXT_DATA__ JSON with multiple path fallbacks
     * 2. Apollo/GraphQL cache
     * 3. HTML regex parsing
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

                    // Log available data structure for debugging
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

                        // Extract track ID from multiple possible locations
                        const trackId = track.uri?.split(":")[2]
                            || track.id
                            || item.uid
                            || item.itemV2?.data?.uri?.split(":")[2];

                        // Extract album name from multiple possible locations
                        const albumName = track.album?.name
                            || track.albumOfTrack?.name
                            || item.itemV2?.data?.albumOfTrack?.name;

                        // Extract album ID from multiple possible locations
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

                // Extract track ID from internal-track-link
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
            } catch (error: unknown) {
                logger.debug(`[Deezer Fallback] Rate limit hit for "${track.title}", skipping`);
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
        const trackFields = "items(track(id,name,artists(id,name),album(id,name,images),duration_ms,track_number,preview_url,external_ids)),next,total";

        logger.debug(`Spotify: Playlist has ${total} tracks, fetched ${allItems.length}, paginating remainder...`);

        while (offset < total) {
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
                onProgress?.(allItems.length, total);

                logger.debug(`Spotify: Fetched ${allItems.length}/${total} tracks`);

                if (offset < total) {
                    await new Promise(r => setTimeout(r, 100));
                }
            } catch (error: any) {
                if (error.response?.status === 429) {
                    const retryAfter = parseInt(error.response?.headers?.["retry-after"] || "5", 10);
                    logger.warn(`Spotify: Rate limited, waiting ${retryAfter}s...`);
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

            if (totalTracks > allItems.length && allItems.length > 0) {
                allItems = await this.fetchAllPlaylistTracks(
                    playlistId, token, totalTracks, allItems, onProgress
                );
            }

            logger.debug(`Spotify: Fetched playlist "${playlist.name}" with ${allItems.length}/${totalTracks} tracks`);

            const tracks: SpotifyTrack[] = [];
            let unknownAlbumCount = 0;

            for (const item of allItems) {
                const track = item.track;
                if (!track || !track.id) {
                    continue;
                }

                // Get album name, handling null, undefined, and empty strings
                const albumName = track.album?.name?.trim() || "Unknown Album";

                if (albumName === "Unknown Album") {
                    unknownAlbumCount++;
                }

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

            // If we have tracks with Unknown Album, try to fill them in via page scraping
            if (unknownAlbumCount > 0) {
                logger.debug(`Spotify: ${unknownAlbumCount} tracks have Unknown Album, attempting page scrape...`);
                const scrapedAlbums = await this.scrapePlaylistPageForAlbums(playlistId);

                if (scrapedAlbums.size > 0) {
                    let enrichedCount = 0;
                    for (const track of tracks) {
                        if (track.album === "Unknown Album" && scrapedAlbums.has(track.spotifyId)) {
                            const albumData = scrapedAlbums.get(track.spotifyId)!;
                            track.album = albumData.album;
                            track.albumId = albumData.albumId;
                            enrichedCount++;
                            logger.debug(`Spotify: Enriched "${track.title}" with album "${albumData.album}"`);
                        }
                    }
                    logger.debug(`Spotify: Enriched ${enrichedCount}/${unknownAlbumCount} tracks with scraped album data`);
                }
            }

            // If we STILL have tracks with Unknown Album, try individual track pages
            // Note: scrapeTrackPagesForAlbums internally limits to 30 tracks
            const remainingUnknown = tracks.filter(t => t.album === "Unknown Album");
            if (remainingUnknown.length > 0) {
                logger.debug(`Spotify: ${remainingUnknown.length} tracks still unknown, trying track page scraping...`);
                const trackPageAlbums = await this.scrapeTrackPagesForAlbums(
                    remainingUnknown.map(t => ({ spotifyId: t.spotifyId, title: t.title, artist: t.artist }))
                );

                if (trackPageAlbums.size > 0) {
                    let enrichedCount = 0;
                    for (const track of tracks) {
                        if (track.album === "Unknown Album" && trackPageAlbums.has(track.spotifyId)) {
                            const albumData = trackPageAlbums.get(track.spotifyId)!;
                            track.album = albumData.album;
                            track.albumId = albumData.albumId;
                            enrichedCount++;
                            logger.debug(`Spotify: Enriched "${track.title}" via track page: "${albumData.album}"`);
                        }
                    }
                    logger.debug(`Spotify: Enriched ${enrichedCount} tracks via individual track page scraping`);
                }
            }

            // Final fallback: Use Deezer to resolve remaining unknown albums
            const stillUnknown = tracks.filter(t => t.album === "Unknown Album");
            if (stillUnknown.length > 0) {
                logger.debug(`Spotify: ${stillUnknown.length} tracks still unknown, trying Deezer fallback...`);
                const deezerAlbums = await this.resolveAlbumsViaDeezer(
                    stillUnknown.map(t => ({ spotifyId: t.spotifyId, title: t.title, artist: t.artist }))
                );

                if (deezerAlbums.size > 0) {
                    let enrichedCount = 0;
                    for (const track of tracks) {
                        if (track.album === "Unknown Album" && deezerAlbums.has(track.spotifyId)) {
                            const albumData = deezerAlbums.get(track.spotifyId)!;
                            track.album = albumData.album;
                            track.albumId = albumData.albumId;
                            enrichedCount++;
                            logger.debug(`Spotify: Enriched "${track.title}" via Deezer: "${albumData.album}"`);
                        }
                    }
                    logger.debug(`Spotify: Enriched ${enrichedCount} tracks via Deezer fallback`);
                }
            }

            logger.debug(`Spotify: Processed ${tracks.length} tracks`);

            return {
                id: playlist.id,
                name: playlist.name,
                description: playlist.description,
                owner: playlist.owner?.display_name || "Unknown",
                imageUrl: playlist.images?.[0]?.url || null,
                trackCount: playlist.tracks?.total || tracks.length,
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
                    // Extract first artist from subtitle (before any comma)
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

            // Count tracks with Unknown Album
            const unknownAlbumCount = tracks.filter(t => t.album === "Unknown Album").length;

            // If we have tracks with Unknown Album, try to fill them in via page scraping
            if (unknownAlbumCount > 0) {
                logger.debug(`Spotify Embed: ${unknownAlbumCount} tracks have Unknown Album, attempting page scrape...`);
                const scrapedAlbums = await this.scrapePlaylistPageForAlbums(playlistId);

                if (scrapedAlbums.size > 0) {
                    let enrichedCount = 0;
                    for (const track of tracks) {
                        if (track.album === "Unknown Album" && scrapedAlbums.has(track.spotifyId)) {
                            const albumData = scrapedAlbums.get(track.spotifyId)!;
                            track.album = albumData.album;
                            track.albumId = albumData.albumId;
                            enrichedCount++;
                            logger.debug(`Spotify Embed: Enriched "${track.title}" with album "${albumData.album}"`);
                        }
                    }
                    logger.debug(`Spotify Embed: Enriched ${enrichedCount}/${unknownAlbumCount} tracks with scraped album data`);
                }
            }

            // If we STILL have tracks with Unknown Album, try individual track pages
            // Note: scrapeTrackPagesForAlbums internally limits to 30 tracks
            const remainingUnknown = tracks.filter(t => t.album === "Unknown Album");
            if (remainingUnknown.length > 0) {
                logger.debug(`Spotify Embed: ${remainingUnknown.length} tracks still unknown, trying track page scraping...`);
                const trackPageAlbums = await this.scrapeTrackPagesForAlbums(
                    remainingUnknown.map(t => ({ spotifyId: t.spotifyId, title: t.title, artist: t.artist }))
                );

                if (trackPageAlbums.size > 0) {
                    let enrichedCount = 0;
                    for (const track of tracks) {
                        if (track.album === "Unknown Album" && trackPageAlbums.has(track.spotifyId)) {
                            const albumData = trackPageAlbums.get(track.spotifyId)!;
                            track.album = albumData.album;
                            track.albumId = albumData.albumId;
                            enrichedCount++;
                            logger.debug(`Spotify Embed: Enriched "${track.title}" via track page: "${albumData.album}"`);
                        }
                    }
                    logger.debug(`Spotify Embed: Enriched ${enrichedCount} tracks via individual track page scraping`);
                }
            }

            // Final fallback: Use Deezer to resolve remaining unknown albums
            const stillUnknown = tracks.filter(t => t.album === "Unknown Album");
            if (stillUnknown.length > 0) {
                logger.debug(`Spotify Embed: ${stillUnknown.length} tracks still unknown, trying Deezer fallback...`);
                const deezerAlbums = await this.resolveAlbumsViaDeezer(
                    stillUnknown.map(t => ({ spotifyId: t.spotifyId, title: t.title, artist: t.artist }))
                );

                if (deezerAlbums.size > 0) {
                    let enrichedCount = 0;
                    for (const track of tracks) {
                        if (track.album === "Unknown Album" && deezerAlbums.has(track.spotifyId)) {
                            const albumData = deezerAlbums.get(track.spotifyId)!;
                            track.album = albumData.album;
                            track.albumId = albumData.albumId;
                            enrichedCount++;
                            logger.debug(`Spotify Embed: Enriched "${track.title}" via Deezer: "${albumData.album}"`);
                        }
                    }
                    logger.debug(`Spotify Embed: Enriched ${enrichedCount} tracks via Deezer fallback`);
                }
            }

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
        // Extract ID from URL if needed
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
     * Get featured/popular playlists from Spotify
     * Uses multiple fallback approaches
     */
    async getFeaturedPlaylists(limit: number = 20): Promise<SpotifyPlaylistPreview[]> {
        const token = await this.getAnonymousToken();
        if (!token) {
            logger.error("Spotify: Cannot fetch featured playlists without token");
            return [];
        }

        // Try official API first
        try {
            logger.debug("Spotify: Trying featured playlists via official API...");

            const response = await axios.get(
                "https://api.spotify.com/v1/browse/featured-playlists",
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                    params: {
                        limit,
                        country: "US",
                    },
                    timeout: 10000,
                }
            );

            const playlists = response.data?.playlists?.items || [];
            if (playlists.length > 0) {
                logger.debug(`Spotify: Got ${playlists.length} featured playlists via official API`);
                return playlists.map((playlist: any) => ({
                    id: playlist.id,
                    name: playlist.name,
                    description: playlist.description || null,
                    owner: playlist.owner?.display_name || "Spotify",
                    imageUrl: playlist.images?.[0]?.url || null,
                    trackCount: playlist.tracks?.total || 0,
                }));
            }
        } catch (error: any) {
            logger.debug("Spotify: Featured playlists API failed, trying search fallback...", error.response?.status || error.message);
        }

        // Fallback: Search for popular playlists
        try {
            logger.debug("Spotify: Trying search fallback for featured playlists...");
            
            // Search for popular/curated playlists
            const searches = ["Today's Top Hits", "Hot Hits", "Viral Hits", "All Out", "Rock Classics", "Chill Hits"];
            const allPlaylists: SpotifyPlaylistPreview[] = [];
            
            for (const query of searches.slice(0, 3)) {
                const results = await this.searchPlaylists(query, 5);
                // Filter to only include Spotify-owned playlists
                const spotifyOwned = results.filter(p => 
                    p.owner.toLowerCase() === "spotify" || 
                    p.owner.toLowerCase().includes("spotify")
                );
                allPlaylists.push(...spotifyOwned);
                
                if (allPlaylists.length >= limit) break;
            }
            
            logger.debug(`Spotify: Got ${allPlaylists.length} playlists via search fallback`);
            return allPlaylists.slice(0, limit);
        } catch (searchError: any) {
            logger.error("Spotify: Search fallback also failed:", searchError.message);
            return [];
        }
    }

    /**
     * Get playlists by category
     */
    async getCategoryPlaylists(categoryId: string, limit: number = 20): Promise<SpotifyPlaylistPreview[]> {
        const token = await this.getAnonymousToken();
        if (!token) {
            return [];
        }

        try {
            logger.debug(`Spotify: Fetching playlists for category ${categoryId}...`);

            const response = await axios.get(
                `https://api.spotify.com/v1/browse/categories/${categoryId}/playlists`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                    params: {
                        limit,
                        country: "US",
                    },
                    timeout: 10000,
                }
            );

            const playlists = response.data?.playlists?.items || [];
            return playlists.map((playlist: any) => ({
                id: playlist.id,
                name: playlist.name,
                description: playlist.description || null,
                owner: playlist.owner?.display_name || "Spotify",
                imageUrl: playlist.images?.[0]?.url || null,
                trackCount: playlist.tracks?.total || 0,
            }));
        } catch (error: any) {
            logger.error(`Spotify category playlists error for ${categoryId}:`, error.message);
            return [];
        }
    }

    /**
     * Search for playlists on Spotify
     */
    async searchPlaylists(query: string, limit: number = 20): Promise<SpotifyPlaylistPreview[]> {
        const token = await this.getAnonymousToken();
        if (!token) {
            logger.error("Spotify: Cannot search without token");
            return [];
        }

        try {
            logger.debug(`Spotify: Searching playlists for "${query}"...`);

            const response = await axios.get(
                "https://api.spotify.com/v1/search",
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "application/json",
                    },
                    params: {
                        q: query,
                        type: "playlist",
                        limit,
                        market: "US",
                    },
                    timeout: 15000,
                }
            );

            const playlists = response.data?.playlists?.items || [];
            logger.debug(`Spotify: Found ${playlists.length} playlists for "${query}"`);

            return playlists
                .filter((playlist: any) => playlist && playlist.id) // Filter out null entries
                .map((playlist: any) => ({
                    id: playlist.id,
                    name: playlist.name,
                    description: playlist.description || null,
                    owner: playlist.owner?.display_name || "Unknown",
                    imageUrl: playlist.images?.[0]?.url || null,
                    trackCount: playlist.tracks?.total || 0,
                }));
        } catch (error: any) {
            logger.error("Spotify search playlists error:", error.response?.status, error.response?.data || error.message);
            // If unauthorized, try refreshing token and retry once
            if (error.response?.status === 401) {
                logger.debug("Spotify: Token expired, refreshing...");
                this.anonymousToken = null;
                this.tokenExpiry = 0;
                const newToken = await this.getAnonymousToken();
                if (newToken) {
                    try {
                        const retryResponse = await axios.get(
                            "https://api.spotify.com/v1/search",
                            {
                                headers: {
                                    Authorization: `Bearer ${newToken}`,
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                },
                                params: { q: query, type: "playlist", limit, market: "US" },
                                timeout: 15000,
                            }
                        );
                        const retryPlaylists = retryResponse.data?.playlists?.items || [];
                        return retryPlaylists
                            .filter((p: any) => p && p.id)
                            .map((p: any) => ({
                                id: p.id,
                                name: p.name,
                                description: p.description || null,
                                owner: p.owner?.display_name || "Unknown",
                                imageUrl: p.images?.[0]?.url || null,
                                trackCount: p.tracks?.total || 0,
                            }));
                    } catch (retryError) {
                        logger.error("Spotify: Retry also failed");
                    }
                }
            }
            return [];
        }
    }

    /**
     * Get available browse categories
     */
    async getCategories(limit: number = 20): Promise<Array<{ id: string; name: string; imageUrl: string | null }>> {
        const token = await this.getAnonymousToken();
        if (!token) {
            return [];
        }

        try {
            const response = await axios.get(
                "https://api.spotify.com/v1/browse/categories",
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                    params: {
                        limit,
                        country: "US",
                    },
                    timeout: 10000,
                }
            );

            return (response.data?.categories?.items || []).map((cat: any) => ({
                id: cat.id,
                name: cat.name,
                imageUrl: cat.icons?.[0]?.url || null,
            }));
        } catch (error: any) {
            logger.error("Spotify categories error:", error.message);
            return [];
        }
    }
}

export const spotifyService = new SpotifyService();
