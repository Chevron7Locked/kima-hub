import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";

export function normalizeCacheQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, " ");
}

interface SearchOptions {
    query: string;
    limit?: number;
    offset?: number;
}

export interface ArtistSearchResult {
    id: string;
    name: string;
    mbid: string;
    heroUrl: string | null;
    summary?: string;
    rank: number;
}

export interface AlbumSearchResult {
    id: string;
    title: string;
    artistId: string;
    artistName: string;
    year: number | null;
    coverUrl: string | null;
    rank: number;
}

export interface TrackSearchResult {
    id: string;
    title: string;
    albumId: string;
    albumTitle: string;
    artistId: string;
    artistName: string;
    duration: number;
    rank: number;
}

export interface PodcastSearchResult {
    id: string;
    title: string;
    author: string | null;
    description: string | null;
    imageUrl: string | null;
    episodeCount: number;
    rank?: number;
}

export interface EpisodeSearchResult {
    id: string;
    title: string;
    description: string | null;
    podcastId: string;
    podcastTitle: string;
    publishedAt: Date;
    duration: number;
    audioUrl: string;
    rank: number;
}

export interface AudiobookSearchResult {
    id: string;
    title: string;
    author: string | null;
    narrator: string | null;
    series: string | null;
    description: string | null;
    coverUrl: string | null;
    duration: number | null;
    rank: number;
}

export interface SearchByTypeOptions {
    query: string;
    type: string;
    limit?: number;
    offset?: number;
    genre?: string;
}

export interface SearchResults {
    artists: ArtistSearchResult[];
    albums: AlbumSearchResult[];
    tracks: TrackSearchResult[];
    podcasts: PodcastSearchResult[];
    audiobooks: AudiobookSearchResult[];
    episodes: EpisodeSearchResult[];
}

export class SearchService {
    /**
     * Convert user query to PostgreSQL tsquery format
     * Splits on whitespace and adds prefix matching (:*)
     * Example: "radio head" -> "radio:* & head:*"
     */
    private queryToTsquery(query: string): string {
        const terms = query
            .trim()
            .replace(/\s*&\s*/g, " and ")
            .split(/\s+/)
            .map((term) => term.replace(/[^\w]/g, ""))
            .filter((term) => term.length > 0);

        if (terms.length === 0) return "";

        return terms.map((term) => `${term}:*`).join(" & ");
    }

    private async searchArtistsFallback({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<ArtistSearchResult[]> {
        const results = await prisma.artist.findMany({
            where: {
                name: {
                    contains: query,
                    mode: "insensitive",
                },
                albums: {
                    some: {},
                },
            },
            select: {
                id: true,
                name: true,
                mbid: true,
                heroUrl: true,
            },
            take: limit,
            skip: offset,
            orderBy: {
                name: "asc",
            },
        });

        return results.map((r) => ({ ...r, rank: 0 }));
    }

    async searchArtists({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<ArtistSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchArtistsFallback({ query, limit, offset });
        }

        try {
            const results = await prisma.$queryRaw<ArtistSearchResult[]>`
        SELECT
          a.id,
          a.name,
          a.mbid,
          a."heroUrl",
          a.summary,
          ts_rank(a."searchVector", to_tsquery('english', ${tsquery})) AS rank
        FROM "Artist" a
        WHERE a."searchVector" @@ to_tsquery('english', ${tsquery})
          AND EXISTS (SELECT 1 FROM "Album" alb WHERE alb."artistId" = a.id)
        ORDER BY rank DESC, a.name ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results;
        } catch (error) {
            logger.error("Artist search error:", error);
            return this.searchArtistsFallback({ query, limit, offset });
        }
    }

    private async searchAlbumsFallback({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<AlbumSearchResult[]> {
        const results = await prisma.album.findMany({
            where: {
                OR: [
                    {
                        title: {
                            contains: query,
                            mode: "insensitive",
                        },
                    },
                    {
                        artist: {
                            name: {
                                contains: query,
                                mode: "insensitive",
                            },
                        },
                    },
                ],
            },
            select: {
                id: true,
                title: true,
                artistId: true,
                year: true,
                coverUrl: true,
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
            take: limit,
            skip: offset,
            orderBy: {
                title: "asc",
            },
        });

        return results.map((r) => ({
            id: r.id,
            title: r.title,
            artistId: r.artistId,
            artistName: r.artist.name,
            year: r.year,
            coverUrl: r.coverUrl,
            rank: 0,
        }));
    }

    async searchAlbums({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<AlbumSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchAlbumsFallback({ query, limit, offset });
        }

        try {
            const results = await prisma.$queryRaw<AlbumSearchResult[]>`
        SELECT * FROM (
          SELECT DISTINCT ON (id) id, title, "artistId", "artistName", year, "coverUrl", rank
          FROM (
            SELECT
              a.id,
              a.title,
              a."artistId",
              ar.name as "artistName",
              a.year,
              a."coverUrl",
              ts_rank(a."searchVector", to_tsquery('english', ${tsquery})) AS rank
            FROM "Album" a
            LEFT JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE a."searchVector" @@ to_tsquery('english', ${tsquery})

            UNION ALL

            SELECT
              a.id,
              a.title,
              a."artistId",
              ar.name as "artistName",
              a.year,
              a."coverUrl",
              ts_rank(ar."searchVector", to_tsquery('english', ${tsquery})) AS rank
            FROM "Album" a
            INNER JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE ar."searchVector" @@ to_tsquery('english', ${tsquery})
          ) combined
          ORDER BY id, rank DESC
        ) deduped
        ORDER BY rank DESC, title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results;
        } catch (error) {
            logger.error("Album search error:", error);
            return this.searchAlbumsFallback({ query, limit, offset });
        }
    }

    private async searchTracksFallback({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<TrackSearchResult[]> {
        const results = await prisma.track.findMany({
            where: {
                title: {
                    contains: query,
                    mode: "insensitive",
                },
            },
            select: {
                id: true,
                title: true,
                albumId: true,
                duration: true,
                album: {
                    select: {
                        title: true,
                        artistId: true,
                        artist: {
                            select: {
                                name: true,
                            },
                        },
                    },
                },
            },
            take: limit,
            skip: offset,
            orderBy: {
                title: "asc",
            },
        });

        return results.map((r) => ({
            id: r.id,
            title: r.title,
            albumId: r.albumId,
            albumTitle: r.album.title,
            artistId: r.album.artistId,
            artistName: r.album.artist.name,
            duration: r.duration,
            rank: 0,
        }));
    }

    async searchTracks({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<TrackSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchTracksFallback({ query, limit, offset });
        }

        try {
            const results = await prisma.$queryRaw<TrackSearchResult[]>`
        SELECT
          t.id,
          t.title,
          t."albumId",
          t.duration,
          a.title as "albumTitle",
          a."artistId",
          ar.name as "artistName",
          ts_rank(t."searchVector", to_tsquery('english', ${tsquery})) AS rank
        FROM "Track" t
        LEFT JOIN "Album" a ON t."albumId" = a.id
        LEFT JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t."searchVector" @@ to_tsquery('english', ${tsquery})
        ORDER BY rank DESC, t.title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results;
        } catch (error) {
            logger.error("Track search error:", error);
            return this.searchTracksFallback({ query, limit, offset });
        }
    }

    /**
     * Search podcasts using PostgreSQL full-text search
     */
    async searchPodcastsFTS({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<PodcastSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchPodcasts({ query, limit, offset });
        }

        try {
            const results = await prisma.$queryRaw<PodcastSearchResult[]>`
        SELECT
          id,
          title,
          author,
          description,
          "imageUrl",
          "episodeCount",
          ts_rank("searchVector", to_tsquery('english', ${tsquery})) AS rank
        FROM "Podcast"
        WHERE "searchVector" @@ to_tsquery('english', ${tsquery})
        ORDER BY rank DESC, title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results;
        } catch (error) {
            logger.error("Podcast FTS search error:", error);
            // Fallback to LIKE search
            return this.searchPodcasts({ query, limit, offset });
        }
    }

    private async searchEpisodesFallback({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<EpisodeSearchResult[]> {
        const results = await prisma.podcastEpisode.findMany({
            where: {
                OR: [
                    {
                        title: {
                            contains: query,
                            mode: "insensitive",
                        },
                    },
                    {
                        description: {
                            contains: query,
                            mode: "insensitive",
                        },
                    },
                ],
            },
            select: {
                id: true,
                title: true,
                description: true,
                podcastId: true,
                publishedAt: true,
                duration: true,
                audioUrl: true,
                podcast: {
                    select: {
                        title: true,
                    },
                },
            },
            take: limit,
            skip: offset,
            orderBy: {
                publishedAt: "desc",
            },
        });

        return results.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            podcastId: r.podcastId,
            podcastTitle: r.podcast.title,
            publishedAt: r.publishedAt,
            duration: r.duration,
            audioUrl: r.audioUrl,
            rank: 0,
        }));
    }

    async searchEpisodes({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<EpisodeSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchEpisodesFallback({ query, limit, offset });
        }

        try {
            const results = await prisma.$queryRaw<EpisodeSearchResult[]>`
        SELECT
          e.id,
          e.title,
          e.description,
          e."podcastId",
          e."publishedAt",
          e.duration,
          e."audioUrl",
          p.title as "podcastTitle",
          ts_rank(e."searchVector", to_tsquery('english', ${tsquery})) AS rank
        FROM "PodcastEpisode" e
        LEFT JOIN "Podcast" p ON e."podcastId" = p.id
        WHERE e."searchVector" @@ to_tsquery('english', ${tsquery})
        ORDER BY rank DESC, e."publishedAt" DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results;
        } catch (error) {
            logger.error("Episode search error:", error);
            return this.searchEpisodesFallback({ query, limit, offset });
        }
    }

    /**
     * Search audiobooks using PostgreSQL full-text search
     * Falls back to external API if local cache is empty
     */
    async searchAudiobooksFTS({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<AudiobookSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchAudiobooksFallback({ query, limit, offset });
        }

        try {
            const results = await prisma.$queryRaw<AudiobookSearchResult[]>`
        SELECT
          id,
          title,
          author,
          narrator,
          series,
          description,
          "coverUrl",
          duration,
          ts_rank("searchVector", to_tsquery('english', ${tsquery})) AS rank
        FROM "Audiobook"
        WHERE "searchVector" @@ to_tsquery('english', ${tsquery})
        ORDER BY rank DESC, title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            if (results.length > 0) {
                return results.map((r) => ({
                    ...r,
                    coverUrl: r.coverUrl ? `/audiobooks/${r.id}/cover` : null,
                }));
            }

            return this.searchAudiobooksFallback({ query, limit, offset });
        } catch (error) {
            logger.error("Audiobook FTS search error:", error);
            return this.searchAudiobooksFallback({ query, limit, offset });
        }
    }

    private async searchAudiobooksFallback({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<AudiobookSearchResult[]> {
        const results = await prisma.audiobook.findMany({
            where: {
                OR: [
                    {
                        title: {
                            contains: query,
                            mode: "insensitive",
                        },
                    },
                    {
                        author: {
                            contains: query,
                            mode: "insensitive",
                        },
                    },
                    {
                        narrator: {
                            contains: query,
                            mode: "insensitive",
                        },
                    },
                    {
                        series: {
                            contains: query,
                            mode: "insensitive",
                        },
                    },
                ],
            },
            select: {
                id: true,
                title: true,
                author: true,
                narrator: true,
                series: true,
                description: true,
                coverUrl: true,
                duration: true,
            },
            take: limit,
            skip: offset,
            orderBy: {
                title: "asc",
            },
        });

        return results.map((r) => ({
            ...r,
            coverUrl: r.coverUrl ? `/audiobooks/${r.id}/cover` : null,
            rank: 0,
        }));
    }

    /**
     * Legacy LIKE-based podcast search (kept as fallback)
     */
    async searchPodcasts({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<PodcastSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        // Simple LIKE search for podcasts (fallback)
        try {
            const results = await prisma.podcast.findMany({
                where: {
                    OR: [
                        {
                            title: {
                                contains: query,
                                mode: "insensitive",
                            },
                        },
                        {
                            author: {
                                contains: query,
                                mode: "insensitive",
                            },
                        },
                        {
                            description: {
                                contains: query,
                                mode: "insensitive",
                            },
                        },
                    ],
                },
                select: {
                    id: true,
                    title: true,
                    author: true,
                    description: true,
                    imageUrl: true,
                    episodeCount: true,
                },
                take: limit,
                skip: offset,
                orderBy: {
                    title: "asc",
                },
            });

            return results;
        } catch (error) {
            logger.error("Podcast search error:", error);
            return [];
        }
    }

    async searchAll({
        query,
        limit = 10,
        genre,
    }: SearchOptions & { genre?: string }): Promise<SearchResults> {
        if (!query || query.trim().length === 0) {
            return {
                artists: [],
                albums: [],
                tracks: [],
                podcasts: [],
                audiobooks: [],
                episodes: [],
            };
        }

        // Check Redis cache first
        const cacheKey = `search:all:${normalizeCacheQuery(query)}:${limit}:${genre || ""}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH] Cache HIT for query: "${query}"`);
                const parsed = JSON.parse(cached);
                // Transform cached audiobook coverUrls to ensure consistency
                if (parsed.audiobooks && Array.isArray(parsed.audiobooks)) {
                    parsed.audiobooks = parsed.audiobooks.map(
                        (book: AudiobookSearchResult) => ({
                            ...book,
                            coverUrl: book.coverUrl
                                ? `/audiobooks/${book.id}/cover`
                                : null,
                        })
                    );
                }
                return parsed;
            }
        } catch (err) {
            logger.warn("[SEARCH] Redis cache read error:", err);
        }

        logger.debug(
            `[SEARCH]  Cache MISS for query: "${query}" - fetching from database`
        );

        const [artists, albums, tracks, podcasts, audiobooks, episodes] =
            await Promise.all([
                this.searchArtists({ query, limit }),
                this.searchAlbums({ query, limit }),
                this.searchTracks({ query, limit }),
                this.searchPodcastsFTS({ query, limit }),
                this.searchAudiobooksFTS({ query, limit }),
                this.searchEpisodes({ query, limit }),
            ]);

        const results = {
            artists,
            albums,
            tracks: genre ? await this.filterTracksByGenre(tracks, genre) : tracks,
            podcasts,
            audiobooks,
            episodes,
        };

        // Cache for 5 minutes (balance freshness vs performance)
        try {
            await redisClient.setex(cacheKey, 300, JSON.stringify(results));
        } catch (err) {
            logger.warn("[SEARCH] Redis cache write error:", err);
        }

        return results;
    }

    /**
     * Filter tracks by genre
     */
    async filterTracksByGenre(
        tracks: TrackSearchResult[],
        genre: string
    ): Promise<TrackSearchResult[]> {
        if (tracks.length === 0) return [];

        const trackIds = tracks.map((t) => t.id);
        const tracksWithGenre = await prisma.track.findMany({
            where: {
                id: { in: trackIds },
                trackGenres: {
                    some: {
                        genre: {
                            name: {
                                equals: genre,
                                mode: "insensitive",
                            },
                        },
                    },
                },
            },
            select: { id: true },
        });

        const genreTrackIds = new Set(tracksWithGenre.map((t) => t.id));
        return tracks.filter((t) => genreTrackIds.has(t.id));
    }

    /**
     * Search by specific type with caching
     */
    async searchByType({
        query,
        type,
        limit = 20,
        offset = 0,
        genre,
    }: SearchByTypeOptions): Promise<SearchResults> {
        const results: SearchResults = {
            artists: [],
            albums: [],
            tracks: [],
            podcasts: [],
            audiobooks: [],
            episodes: [],
        };

        if (!query || query.trim().length === 0) {
            return results;
        }

        // Check cache
        const cacheKey = `search:${type}:${normalizeCacheQuery(query)}:${limit}:${genre || ""}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH] Cache HIT for ${type} query: "${query}"`);
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn("[SEARCH] Redis read error:", err);
        }

        // Execute single-type search
        switch (type) {
            case "artists":
                results.artists = await this.searchArtists({ query, limit, offset });
                break;
            case "albums":
                results.albums = await this.searchAlbums({ query, limit, offset });
                break;
            case "tracks": {
                let tracks = await this.searchTracks({ query, limit, offset });
                if (genre) {
                    tracks = await this.filterTracksByGenre(tracks, genre);
                }
                results.tracks = tracks;
                break;
            }
            case "podcasts":
                results.podcasts = await this.searchPodcastsFTS({ query, limit, offset });
                break;
            case "audiobooks":
                results.audiobooks = await this.searchAudiobooksFTS({ query, limit, offset });
                break;
            case "episodes":
                results.episodes = await this.searchEpisodes({ query, limit, offset });
                break;
        }

        // Cache for 2 minutes
        try {
            await redisClient.setex(cacheKey, 120, JSON.stringify(results));
        } catch (err) {
            logger.warn("[SEARCH] Redis write error:", err);
        }

        return results;
    }
}

export const searchService = new SearchService();
