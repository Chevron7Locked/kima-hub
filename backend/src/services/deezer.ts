import { AxiosRequestConfig } from "axios";
import { logger } from "../utils/logger";
import { CacheWrapper } from "../utils/cacheWrapper";
import { rateLimitedGet } from "./httpClient";
import { normalizeString } from "../utils/normalization";
import { UpstreamReplyError } from "../utils/upstream";
import type { SimilarArtist } from "./listenBrainz";

/** Fetches images, previews and public playlist data from Deezer's unauthenticated API. */

const DEEZER_API = "https://api.deezer.com";

// Deezer ranks search hits by popularity, so a hit counts only when its name
// matches the query, exactly or after normalisation (all-punctuation names
// must match exactly).
function namesAgree(found: string | undefined, wanted: string): boolean {
    if (found === undefined) return false;
    const a = normalizeString(found);
    const b = normalizeString(wanted);
    if (a === "" || b === "") return found === wanted;
    return a === b;
}

type DeezerTrackTitles = { title?: string; title_short?: string; preview?: string };

/**
 * The first track with a preview whose `title` agrees, or whose `title_short` (the title without the version and
 * credits Deezer splits off: "Get Lucky (feat. …)" is "Get Lucky") agrees.
 */
function playableWithTitle<T extends DeezerTrackTitles>(tracks: T[], wanted: string, by: "title" | "title_short"): T | undefined {
    return tracks.find((t) => Boolean(t?.preview) && namesAgree(t[by], wanted));
}

/** Deezer's error codes that answer "nothing by that id" rather than "the request failed". */
const DEEZER_NO_DATA = 800;

/** An artist's popular songs fetched once and shared by the artist page and the preview fallback. */
const ARTIST_TOP_COUNT = 50;

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

/** One of an artist's most popular tracks on Deezer (its /artist/{id}/top). */
export interface DeezerTopTrack {
    title: string;
    artist: string;
    album: string | null;
    coverUrl: string | null;
    previewUrl: string | null;
    durationMs: number;
    rank: number;
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

function mapDeezerTrack(track: any): DeezerTrack {
    return {
        deezerId: String(track.id),
        title: track.title || "Unknown",
        artist: track.artist?.name || "Unknown Artist",
        artistId: String(track.artist?.id || ""),
        album: track.album?.title || "Unknown Album",
        albumId: String(track.album?.id || ""),
        durationMs: (track.duration || 0) * 1000,
        previewUrl: track.preview || null,
        coverUrl: track.album?.cover_medium || track.album?.cover || null,
    };
}

function mapPlaylistPreview(playlist: any, defaultCreator: string, fans: number): DeezerPlaylistPreview {
    return {
        id: String(playlist.id),
        title: playlist.title || "Unknown",
        description: null,
        creator: playlist.user?.name || defaultCreator,
        imageUrl: playlist.picture_medium || playlist.picture || null,
        trackCount: playlist.nb_tracks || 0,
        fans,
    };
}

class DeezerService {
    private readonly cachePrefix = "deezer:";
    private readonly cacheTTL = 86400; // 24 hours
    private cache: CacheWrapper;

    constructor() {
        this.cache = new CacheWrapper('deezer');
    }

    /**
     * Redis first; on a miss run `requestFn` (which must call `deezerGet`) and
     * cache the result, including a null answer.
     */
    private async cachedRequest<T>(cacheKey: string, requestFn: () => Promise<T>): Promise<T> {
        const cached = await this.cache.get<string>(`${this.cachePrefix}${cacheKey}`);
        if (cached !== null) {
            try {
                return cached === "null" ? (null as T) : (JSON.parse(cached) as T);
            } catch {
                // Stale/incompatible cache entry - fall through and refetch.
            }
        }

        const data = await requestFn();
        await this.cache.set(
            `${this.cachePrefix}${cacheKey}`,
            data === null || data === undefined ? "null" : JSON.stringify(data),
            this.cacheTTL
        );
        return data;
    }

    /**
     * Rate-limited Deezer GET through the global limiter (service key "deezer"). Deezer answers its errors as a
     * 200 with an `error` object: "no data" is an answer, any other error is a failed request, so it throws instead
     * of being read (and cached) as an empty result.
     */
    private async deezerGet<T = any>(path: string, config?: AxiosRequestConfig): Promise<T> {
        const body = await rateLimitedGet<any>("deezer", `${DEEZER_API}${path}`, config);
        const error = body?.error;
        if (error && Number(error.code) !== DEEZER_NO_DATA) {
            throw new UpstreamReplyError(`Deezer ${path}: ${error.message ?? "error"} (code ${error.code})`);
        }
        return body as T;
    }

    /**
     * The Deezer artist a name means. Deezer's rank puts namesakes first (an obscure exact "Adele" outranks the
     * Adele, who sits at position 6) and shared names normalize alike (Emine'm == Eminem), so search wide and let
     * fan count decide among the names that agree. Null when no name agrees.
     */
    private async findArtist(artistName: string): Promise<{ id: number; name: string; picture_xl?: string; picture_big?: string; picture_medium?: string } | null> {
        const search = await this.deezerGet<any>("/search/artist", {
            params: { q: artistName, limit: 25 },
            timeout: 5000,
        });
        const hits: any[] = search?.data || [];
        return (
            hits
                .filter((h) => h?.id && namesAgree(h.name, artistName))
                .sort((a, b) => (Number(b.nb_fan) || 0) - (Number(a.nb_fan) || 0))[0] ?? null
        );
    }

    async getArtistImage(artistName: string): Promise<string | null> {
        const cacheKey = `artist:${artistName.toLowerCase()}`;

        try {
            return await this.cachedRequest(cacheKey, async () => {
                const artist = await this.findArtist(artistName);
                if (!artist) {
                    logger.debug(
                        `[DEEZER] No verified artist image for "${artistName}"`
                    );
                    return null;
                }
                return artist?.picture_xl || artist?.picture_big || artist?.picture_medium || null;
            });
        } catch (error: any) {
            // A failed request is not "no image": the caller must not remember it as one.
            logger.warn(`Deezer artist image error for ${artistName}:`, error.message);
            throw error;
        }
    }

    /**
     * Deezer's related artists for a name, resolved to an id by search. Deezer
     * publishes no similarity score, so `match` falls linearly by position from
     * 0.9 to 0.5. [] when unresolved; a failed request throws.
     */
    async getRelatedArtists(artistName: string, limit = 30): Promise<SimilarArtist[]> {
        const cacheKey = `related:${artistName.toLowerCase()}:${limit}`;

        try {
            return await this.cachedRequest(cacheKey, async () => {
                // Only the artist asked about: another artist's neighbours are not this one's.
                const seed = await this.findArtist(artistName);
                if (!seed) {
                    logger.debug(
                        `[DEEZER] Seed "${artistName}" unresolved or mis-resolved; no related artists`
                    );
                    return [];
                }

                const related = await this.deezerGet<any>(`/artist/${seed.id}/related`, {
                    params: { limit },
                    timeout: 5000,
                });
                const list: any[] = related?.data || [];
                if (list.length === 0) return [];

                const n = Math.max(list.length - 1, 1);
                const results: SimilarArtist[] = [];
                list.forEach((a: any, i: number) => {
                    if (!a?.name) return;
                    if (String(a.id) === String(seed.id)) return; // exclude the seed itself
                    results.push({
                        name: String(a.name),
                        match: Math.max(0.5, 0.9 - (0.4 * i) / n),
                        url: a.link || `https://www.deezer.com/artist/${a.id}`,
                    });
                });
                return results;
            });
        } catch (error: any) {
            // An error is not "no related artists": the caller decides what a failed source means.
            logger.warn(`Deezer related artists error for ${artistName}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Deezer's own track objects for an artist's most popular songs, in its rank order: the artist found by
     * findArtist, then `/artist/{id}/top`. Cached; [] when no artist has the name; a failed request throws.
     */
    private fetchArtistTop(artistName: string): Promise<any[]> {
        return this.cachedRequest(`artist-top-tracks:${artistName.toLowerCase()}`, async () => {
            const seed = await this.findArtist(artistName);
            if (!seed) {
                logger.debug(`[DEEZER] Seed "${artistName}" unresolved for top tracks`);
                return [];
            }
            const top = await this.deezerGet<any>(`/artist/${seed.id}/top`, {
                params: { limit: ARTIST_TOP_COUNT },
                timeout: 5000,
            });
            return top?.data || [];
        });
    }

    /**
     * An artist's most popular tracks on Deezer (its own rank order), for the artist page's "Popular" section.
     * [] when unresolved or the artist has no top list; throws on a transport error so the caller can decide.
     */
    async getArtistTopTracks(artistName: string, limit = 10): Promise<DeezerTopTrack[]> {
        try {
            const list = await this.fetchArtistTop(artistName);
            return list
                .filter((t: any) => t?.title)
                .slice(0, limit)
                .map((t: any) => ({
                    title: String(t.title),
                    artist: t.artist?.name || artistName,
                    album: t.album?.title || null,
                    coverUrl: t.album?.cover_medium || t.album?.cover || null,
                    previewUrl: t.preview || null,
                    durationMs: (Number(t.duration) || 0) * 1000,
                    rank: Number(t.rank) || 0,
                }));
        } catch (error: any) {
            logger.warn(`Deezer artist top tracks error for ${artistName}:`, error.message);
            throw error;
        }
    }

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

                const match = albums.find(
                    (a: any) =>
                        namesAgree(a?.artist?.name, artistName) &&
                        namesAgree(a?.title, albumName)
                );
                if (!match) {
                    logger.debug(
                        `[DEEZER] No verified cover for "${artistName}" - "${albumName}"`
                    );
                    return null;
                }

                return match.cover_xl || match.cover_big || match.cover_medium || null;
            });
        } catch (error: any) {
            // A failed request is not "no cover": the caller must not remember it as one.
            logger.warn(`Deezer album cover error for ${artistName} - ${albumName}:`, error.message);
            throw error;
        }
    }

    /**
     * A preview of this artist's song, or null. Deezer no longer honours its structured search (artist:"…" track:"…"
     * finds nothing), so ask plainly. Covers and remixes of a well-known song can push the original out of a plain
     * search, so then look among the artist's own popular songs. A full title in either list beats a short one, so a
     * live or acoustic take in the search never wins over the song itself.
     */
    private async searchTrackPreview(artistName: string, trackName: string): Promise<string | null> {
        const body = await this.deezerGet<any>("/search/track", {
            params: { q: `${artistName} ${trackName}`, limit: 10 },
            timeout: 5000,
        });
        const byArtist = ((body?.data ?? []) as any[]).filter((t) => namesAgree(t?.artist?.name ?? t?.artist, artistName));
        let preview: string | undefined = playableWithTitle(byArtist, trackName, "title")?.preview;
        if (!preview) {
            const popular = await this.fetchArtistTop(artistName);
            // The popular list is remembered for a day and Deezer's preview links last minutes: a song found there is
            // asked for again for a link that still plays (none if it has left Deezer since).
            const tried = new Set<number>();
            const fromPopular = async (by: "title" | "title_short"): Promise<string | undefined> => {
                const track = playableWithTitle(popular.filter((t) => !tried.has(t?.id)), trackName, by);
                if (!track?.id) return undefined;
                tried.add(track.id);
                return (await this.deezerGet<any>(`/track/${track.id}`, { timeout: 5000 }))?.preview || undefined;
            };
            preview =
                (await fromPopular("title")) ??
                playableWithTitle(byArtist, trackName, "title_short")?.preview ??
                (await fromPopular("title_short"));
        }
        if (!preview) {
            logger.debug(`[DEEZER] No verified preview for "${artistName}" - "${trackName}"`);
            return null;
        }
        return preview;
    }

    async getTrackPreview(artistName: string, trackName: string): Promise<string | null> {
        const cacheKey = `track-preview:${artistName.toLowerCase()}:${trackName.toLowerCase()}`;

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
                const cleanTrackName = trackName
                    .replace(/\s*[\(\[](?:feat\.?|ft\.?|with|featuring)[^\)\]]*[\)\]]/gi, "")
                    .replace(/\s*(?:feat\.?|ft\.?|featuring)\s+.*/gi, "")
                    .trim();

                const query = `${artistName} ${cleanTrackName}`;

                const body = await this.deezerGet<any>("/search/track", {
                    params: { q: query, limit: 5 },
                    timeout: 5000,
                });

                // Take a track only if it is by the queried artist and its
                // title is the queried title (either spelling). No
                // first-result fallback — that was some other record's
                // album.
                const tracks = body?.data || [];
                const match = tracks.find(
                    (t: any) =>
                        namesAgree(t?.artist?.name, artistName) &&
                        (namesAgree(t?.title, cleanTrackName) ||
                            namesAgree(t?.title, trackName))
                );

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

            const tracks = allTrackData.map(mapDeezerTrack);

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

    async getChartPlaylists(limit: number = 20): Promise<DeezerPlaylistPreview[]> {
        try {
            const body = await this.deezerGet<any>("/chart/0/playlists", {
                params: { limit },
                timeout: 10000,
            });

            return (body?.data || []).map((playlist: any) =>
                mapPlaylistPreview(playlist, "Deezer", playlist.fans || 0)
            );
        } catch (error: any) {
            logger.error("Deezer chart playlists error:", error.message);
            return [];
        }
    }

    async searchPlaylists(query: string, limit: number = 20): Promise<DeezerPlaylistPreview[]> {
        try {
            const body = await this.deezerGet<any>("/search/playlist", {
                params: { q: query, limit },
                timeout: 10000,
            });

            return (body?.data || []).map((playlist: any) =>
                mapPlaylistPreview(playlist, "Unknown", 0)
            );
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

                logger.debug("Deezer: Fetching chart playlists from API...");
                const chartPlaylists = await this.getChartPlaylists(Math.min(limit, 99));
                for (const p of chartPlaylists) {
                    if (!seenIds.has(p.id)) {
                        seenIds.add(p.id);
                        allPlaylists.push(p);
                    }
                }
                logger.debug(`Deezer: Got ${chartPlaylists.length} chart playlists`);

                // Chart playlists are capped at 99; top up from popular genre searches
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
                        } catch {
                            // One genre failing must not stop the others
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

    async getGenrePlaylists(genreName: string, limit: number = 20): Promise<DeezerPlaylistPreview[]> {
        return this.searchPlaylists(genreName, limit);
    }
}

export const deezerService = new DeezerService();
