import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { normalizeArtistName } from "../utils/artistNormalization";

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
    topResult?: {
        type: "artist" | "album" | "track";
        id: string;
        rank: number;
    };
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

        const q = query.trim();
        const nq = normalizeArtistName(query);
        const tsquery = this.queryToTsquery(query);

        // Unified FTS + trigram query. The FTS arm gets a +1.0 boost so any
        // full-text hit (ts_rank up to ~1.6) always outranks a pure trigram
        // hit (similarity 0..1). MAX(rank) dedupes rows matched by both arms.
        // Both arms always run so a typo'd term still gets fuzzy coverage even
        // when other terms produce FTS hits. If queryToTsquery is empty
        // (punctuation-only query) we skip the FTS arm and run trigram-only.
        // FTS uses the 'simple' config to match the searchVector (see migration
        // 20260606000000): band names like "The The"/"Yes" stay searchable.
        // The trigram arm also matches normalizedName so accent/&-folded
        // queries hit (e.g. "of mice and men" -> stored "Of Mice & Men").
        const ftsArm = tsquery
            ? Prisma.sql`
              SELECT a.id, a.name, a.mbid, a."heroUrl", a.summary,
                     ts_rank(a."searchVector", to_tsquery('simple', ${tsquery})) + 1.0 AS rank
                FROM "Artist" a
               WHERE a."searchVector" @@ to_tsquery('simple', ${tsquery})
                 AND EXISTS (SELECT 1 FROM "Album" alb WHERE alb."artistId" = a.id)
              UNION ALL`
            : Prisma.empty;

        try {
            const results = await prisma.$queryRaw<ArtistSearchResult[]>(Prisma.sql`
        SELECT id, name, mbid, "heroUrl", summary, MAX(rank) AS rank FROM (
          ${ftsArm}
          SELECT a.id, a.name, a.mbid, a."heroUrl", a.summary,
                 GREATEST(similarity(a.name, ${q}), similarity(a."normalizedName", ${nq})) AS rank
            FROM "Artist" a
           WHERE (a.name % ${q} OR a."normalizedName" % ${nq})
             AND EXISTS (SELECT 1 FROM "Album" alb WHERE alb."artistId" = a.id)
        ) u
        GROUP BY id, name, mbid, "heroUrl", summary
        ORDER BY rank DESC, name ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

            if (results.length > 0) return results;
            return this.searchArtistsFallback({ query, limit, offset });
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

        const q = query.trim();
        const tsquery = this.queryToTsquery(query);

        // Unified FTS + trigram query. The FTS arm matches either the album's
        // own searchVector or the artist's searchVector (folded into the LEFT
        // JOIN via OR), each +1.0 boosted so any FTS hit outranks pure-fuzzy.
        // The trigram arm matches album title OR artist name. MAX(rank) dedupes
        // an album matched by several arms. Both arms always run; FTS arm is
        // skipped when tsquery is empty (punctuation-only query).
        const ftsArm = tsquery
            ? Prisma.sql`
              SELECT a.id, a.title, a."artistId", ar.name as "artistName",
                     a.year, a."coverUrl",
                     GREATEST(
                       CASE WHEN a."searchVector" @@ to_tsquery('simple', ${tsquery})
                            THEN ts_rank(a."searchVector", to_tsquery('simple', ${tsquery})) ELSE 0 END,
                       CASE WHEN ar."searchVector" @@ to_tsquery('simple', ${tsquery})
                            THEN ts_rank(ar."searchVector", to_tsquery('simple', ${tsquery})) ELSE 0 END
                     ) + 1.0 AS rank
                FROM "Album" a
                LEFT JOIN "Artist" ar ON a."artistId" = ar.id
               WHERE a."searchVector" @@ to_tsquery('simple', ${tsquery})
                  OR ar."searchVector" @@ to_tsquery('simple', ${tsquery})
              UNION ALL`
            : Prisma.empty;

        try {
            const results = await prisma.$queryRaw<AlbumSearchResult[]>(Prisma.sql`
        SELECT id, title, "artistId", "artistName", year, "coverUrl", MAX(rank) AS rank FROM (
          ${ftsArm}
          SELECT a.id, a.title, a."artistId", ar.name as "artistName",
                 a.year, a."coverUrl",
                 GREATEST(
                   similarity(a.title, ${q}),
                   similarity(COALESCE(ar.name, ''), ${q})
                 ) AS rank
            FROM "Album" a
            LEFT JOIN "Artist" ar ON a."artistId" = ar.id
           WHERE a.title % ${q} OR ar.name % ${q}
        ) u
        GROUP BY id, title, "artistId", "artistName", year, "coverUrl"
        ORDER BY rank DESC, title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

            if (results.length > 0) return results;
            return this.searchAlbumsFallback({ query, limit, offset });
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

        const q = query.trim();
        const tsquery = this.queryToTsquery(query);

        // Unified FTS + trigram query. FTS arm +1.0 boosted so any full-text
        // hit outranks a pure trigram hit; trigram arm matches the track title.
        // MAX(rank) dedupes a track matched by both arms. Both arms always run;
        // FTS arm skipped when tsquery is empty (punctuation-only query).
        const ftsArm = tsquery
            ? Prisma.sql`
              SELECT t.id, t.title, t."albumId", t.duration,
                     a.title as "albumTitle", a."artistId", ar.name as "artistName",
                     ts_rank(t."searchVector", to_tsquery('simple', ${tsquery})) + 1.0 AS rank
                FROM "Track" t
                LEFT JOIN "Album" a ON t."albumId" = a.id
                LEFT JOIN "Artist" ar ON a."artistId" = ar.id
               WHERE t."searchVector" @@ to_tsquery('simple', ${tsquery})
              UNION ALL`
            : Prisma.empty;

        try {
            const results = await prisma.$queryRaw<TrackSearchResult[]>(Prisma.sql`
        SELECT id, title, "albumId", duration, "albumTitle", "artistId", "artistName", MAX(rank) AS rank FROM (
          ${ftsArm}
          SELECT t.id, t.title, t."albumId", t.duration,
                 a.title as "albumTitle", a."artistId", ar.name as "artistName",
                 similarity(t.title, ${q}) AS rank
            FROM "Track" t
            LEFT JOIN "Album" a ON t."albumId" = a.id
            LEFT JOIN "Artist" ar ON a."artistId" = ar.id
           WHERE t.title % ${q}
        ) u
        GROUP BY id, title, "albumId", duration, "albumTitle", "artistId", "artistName"
        ORDER BY rank DESC, title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `);

            if (results.length > 0) return results;
            return this.searchTracksFallback({ query, limit, offset });
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

    /**
     * Record a query that returned zero results across all types into a Redis
     * sorted set (key `search:zeroresults`), so we get a ranked "miss list" to
     * tune search later. Best-effort only: never throws, so logging cannot
     * break search. Skips empty/whitespace and very short (<2 char) queries.
     */
    private async recordZeroResult(query: string): Promise<void> {
        const member = normalizeCacheQuery(query);
        if (member.length < 2) return;

        const ZERORESULTS_KEY = "search:zeroresults";
        const MAX_ENTRIES = 500;
        const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

        try {
            await redisClient.zincrby(ZERORESULTS_KEY, 1, member);
            // Keep only the top ~500 entries (highest scores), dropping the
            // lowest-ranked overflow.
            await redisClient.zremrangebyrank(ZERORESULTS_KEY, 0, -(MAX_ENTRIES + 1));
            // Refresh TTL so the miss list self-expires when searches go quiet.
            await redisClient.expire(ZERORESULTS_KEY, TTL_SECONDS);
        } catch (err) {
            logger.warn("[SEARCH] Redis zero-result record error:", err);
        }
    }

    /**
     * Return the most frequent zero-result queries, highest count first.
     * Intended for a future admin "miss list" view.
     */
    async getZeroResultQueries(
        limit = 50
    ): Promise<Array<{ query: string; count: number }>> {
        try {
            const flat = await redisClient.zrevrange(
                "search:zeroresults",
                0,
                limit - 1,
                "WITHSCORES"
            );
            const out: Array<{ query: string; count: number }> = [];
            for (let i = 0; i < flat.length; i += 2) {
                out.push({ query: flat[i], count: Number(flat[i + 1]) });
            }
            return out;
        } catch (err) {
            logger.warn("[SEARCH] Redis zero-result read error:", err);
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

        const filteredTracks = genre
            ? await this.filterTracksByGenre(tracks, genre)
            : tracks;

        // Cross-type top result: highest-rank item across the first (already
        // rank-sorted desc) entry of each music type. Tie-break artist > album
        // > track, achieved by considering them in that order with strict `>`.
        let topResult: SearchResults["topResult"];
        const candidates: Array<{
            type: "artist" | "album" | "track";
            id: string;
            rank: number;
        }> = [];
        if (artists[0]) {
            candidates.push({ type: "artist", id: artists[0].id, rank: artists[0].rank });
        }
        if (albums[0]) {
            candidates.push({ type: "album", id: albums[0].id, rank: albums[0].rank });
        }
        if (filteredTracks[0]) {
            candidates.push({ type: "track", id: filteredTracks[0].id, rank: filteredTracks[0].rank });
        }
        for (const c of candidates) {
            if (!topResult || c.rank > topResult.rank) {
                topResult = c;
            }
        }

        const results: SearchResults = {
            artists,
            albums,
            tracks: filteredTracks,
            podcasts,
            audiobooks,
            episodes,
            ...(topResult ? { topResult } : {}),
        };

        // Cache for 5 minutes (balance freshness vs performance)
        try {
            await redisClient.setex(cacheKey, 300, JSON.stringify(results));
        } catch (err) {
            logger.warn("[SEARCH] Redis cache write error:", err);
        }

        // Record genuine DB misses (cache-miss branch only) into the ranked
        // zero-result list to tune search later.
        if (
            results.artists.length === 0 &&
            results.albums.length === 0 &&
            results.tracks.length === 0 &&
            results.podcasts.length === 0 &&
            results.audiobooks.length === 0 &&
            results.episodes.length === 0
        ) {
            await this.recordZeroResult(query);
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

        // Record genuine DB misses (cache-miss branch only) when the requested
        // type returned nothing.
        const typedResults = results[
            type as Exclude<keyof SearchResults, "topResult">
        ];
        if ((typedResults ?? []).length === 0) {
            await this.recordZeroResult(query);
        }

        return results;
    }
}

export const searchService = new SearchService();
