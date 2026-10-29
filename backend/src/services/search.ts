import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { IN_LIBRARY, PLAYABLE } from "../utils/libraryEligibility";
import { artistTaggedWithGenre, genreKey } from "../utils/genreSql";
import { searchRows } from "./textMatch";

export function normalizeCacheQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, " ");
}

interface SearchOptions {
    query: string;
    limit?: number;
    offset?: number;
}

const ARTIST_FIELDS = { id: true, name: true, mbid: true, heroUrl: true } as const;
const ALBUM_FIELDS = {
    id: true, title: true, artistId: true, year: true, coverUrl: true, artist: { select: { name: true } },
} as const;
const TRACK_FIELDS = {
    id: true, title: true, albumId: true, duration: true,
    album: { select: { title: true, artistId: true, artist: { select: { name: true } } } },
} as const;
const EPISODE_FIELDS = {
    id: true, title: true, description: true, podcastId: true, publishedAt: true, duration: true, audioUrl: true,
    podcast: { select: { title: true } },
} as const;
const AUDIOBOOK_FIELDS = {
    id: true, title: true, author: true, narrator: true, series: true, description: true, coverUrl: true, duration: true,
} as const;
const PODCAST_FIELDS = { id: true, title: true, author: true, description: true, imageUrl: true, episodeCount: true } as const;

/** Shows and episodes are each user's own: only those of the shows they follow are searched. */
interface FollowedSearchOptions extends SearchOptions {
    userId: string;
}

/**
 * Drop one person's cached searches. What their shows and episodes searches find depends on the shows they follow, so
 * following or removing a show must not leave an older answer cached.
 */
export async function forgetSearchesOf(userId: string): Promise<void> {
    const keys: string[] = [];
    for (const prefix of [`search:all:${userId}:`, `search:podcasts:${userId}:`, `search:episodes:${userId}:`]) {
        let cursor = "0";
        do {
            const [next, batch] = await redisClient.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
            cursor = next;
            keys.push(...batch);
        } while (cursor !== "0");
    }
    if (keys.length > 0) await redisClient.del(...keys);
}

export interface ArtistSearchResult {
    id: string;
    name: string;
    /** null when MusicBrainz has not resolved this artist yet. */
    mbid: string | null;
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
    userId: string;
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
        const results = await searchRows(
            query,
            limit,
            offset,
            ({ skip, take }) =>
                prisma.artist.findMany({
                    where: {
                        name: { contains: query, mode: "insensitive" },
                        albums: {
                            some: { location: "LIBRARY" },
                        },
                    },
                    select: ARTIST_FIELDS,
                    take,
                    skip,
                    orderBy: [{ name: "asc" }, { id: "asc" }],
                }),
            (pattern, { skip, take }) => prisma.$queryRaw<{ id: string }[]>`
                SELECT a.id FROM "Artist" a
                 WHERE a.name ~ ${pattern}
                   AND EXISTS (SELECT 1 FROM "Album" al WHERE al."artistId" = a.id AND al.location = 'LIBRARY')
                 ORDER BY a.name ASC, a.id ASC LIMIT ${take} OFFSET ${skip}`,
            (ids) => prisma.artist.findMany({ where: { id: { in: ids } }, select: ARTIST_FIELDS }),
        );

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
          AND EXISTS (SELECT 1 FROM "Album" alb WHERE alb."artistId" = a.id AND alb.location = 'LIBRARY')
        ORDER BY rank DESC, a.name ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results.length > 0 ? results : this.searchArtistsFallback({ query, limit, offset });
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
        const results = await searchRows(
            query,
            limit,
            offset,
            ({ skip, take }) =>
                prisma.album.findMany({
                    where: {
                        location: "LIBRARY",
                        OR: [
                            { title: { contains: query, mode: "insensitive" } },
                            { artist: { name: { contains: query, mode: "insensitive" } } },
                        ],
                    },
                    select: ALBUM_FIELDS,
                    take,
                    skip,
                    orderBy: [{ title: "asc" }, { id: "asc" }],
                }),
            (pattern, { skip, take }) => prisma.$queryRaw<{ id: string }[]>`
                SELECT al.id FROM "Album" al JOIN "Artist" ar ON ar.id = al."artistId"
                 WHERE al.location = 'LIBRARY' AND (al.title ~ ${pattern} OR ar.name ~ ${pattern})
                 ORDER BY al.title ASC, al.id ASC LIMIT ${take} OFFSET ${skip}`,
            (ids) => prisma.album.findMany({ where: { id: { in: ids } }, select: ALBUM_FIELDS }),
        );

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
              AND a.location = 'LIBRARY'

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
              AND a.location = 'LIBRARY'
          ) combined
          ORDER BY id, rank DESC
        ) deduped
        ORDER BY rank DESC, title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results.length > 0 ? results : this.searchAlbumsFallback({ query, limit, offset });
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
        const results = await searchRows(
            query,
            limit,
            offset,
            ({ skip, take }) =>
                prisma.track.findMany({
                    where: { title: { contains: query, mode: "insensitive" }, ...PLAYABLE, ...IN_LIBRARY },
                    select: TRACK_FIELDS,
                    take,
                    skip,
                    orderBy: [{ title: "asc" }, { id: "asc" }],
                }),
            (pattern, { skip, take }) => prisma.$queryRaw<{ id: string }[]>`
                SELECT t.id FROM "Track" t JOIN "Album" al ON al.id = t."albumId"
                 WHERE t.title ~ ${pattern} AND t."missingSince" IS NULL AND t.corrupt = false AND al.location = 'LIBRARY'
                 ORDER BY t.title ASC, t.id ASC LIMIT ${take} OFFSET ${skip}`,
            (ids) => prisma.track.findMany({ where: { id: { in: ids } }, select: TRACK_FIELDS }),
        );

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
        AND t."missingSince" IS NULL
        AND t.corrupt = false
        AND a.location = 'LIBRARY'
        ORDER BY rank DESC, t.title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results.length > 0 ? results : this.searchTracksFallback({ query, limit, offset });
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
        userId,
    }: FollowedSearchOptions): Promise<PodcastSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchPodcasts({ query, limit, offset, userId });
        }

        try {
            const results = await prisma.$queryRaw<PodcastSearchResult[]>`
        SELECT
          p.id,
          p.title,
          p.author,
          p.description,
          p."imageUrl",
          p."episodeCount",
          ts_rank(p."searchVector", to_tsquery('english', ${tsquery})) AS rank
        FROM "Podcast" p
        JOIN "PodcastSubscription" s ON s."podcastId" = p.id AND s."userId" = ${userId}
        WHERE p."searchVector" @@ to_tsquery('english', ${tsquery})
        ORDER BY rank DESC, p.title ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results;
        } catch (error) {
            logger.error("Podcast FTS search error:", error);
            // Fallback to LIKE search
            return this.searchPodcasts({ query, limit, offset, userId });
        }
    }

    private async searchEpisodesFallback({
        query,
        limit = 20,
        offset = 0,
        userId,
    }: FollowedSearchOptions): Promise<EpisodeSearchResult[]> {
        const results = await searchRows(
            query,
            limit,
            offset,
            ({ skip, take }) =>
                prisma.podcastEpisode.findMany({
                    where: {
                        podcast: { subscriptions: { some: { userId } } },
                        OR: [
                            { title: { contains: query, mode: "insensitive" } },
                            { description: { contains: query, mode: "insensitive" } },
                        ],
                    },
                    select: EPISODE_FIELDS,
                    take,
                    skip,
                    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
                }),
            (pattern, { skip, take }) => prisma.$queryRaw<{ id: string }[]>`
                SELECT e.id FROM "PodcastEpisode" e
                 WHERE (e.title ~ ${pattern} OR e.description ~ ${pattern})
                   AND EXISTS (SELECT 1 FROM "PodcastSubscription" s WHERE s."podcastId" = e."podcastId" AND s."userId" = ${userId})
                 ORDER BY e."publishedAt" DESC, e.id ASC LIMIT ${take} OFFSET ${skip}`,
            (ids) => prisma.podcastEpisode.findMany({ where: { id: { in: ids } }, select: EPISODE_FIELDS }),
        );

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
        userId,
    }: FollowedSearchOptions): Promise<EpisodeSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        const tsquery = this.queryToTsquery(query);
        if (!tsquery) {
            return this.searchEpisodesFallback({ query, limit, offset, userId });
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
        JOIN "Podcast" p ON e."podcastId" = p.id
        JOIN "PodcastSubscription" s ON s."podcastId" = p.id AND s."userId" = ${userId}
        WHERE e."searchVector" @@ to_tsquery('english', ${tsquery})
        ORDER BY rank DESC, e."publishedAt" DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

            return results;
        } catch (error) {
            logger.error("Episode search error:", error);
            return this.searchEpisodesFallback({ query, limit, offset, userId });
        }
    }

    /**
     * Search audiobooks using PostgreSQL full-text search
     * Falls back to a LIKE query on the local table when the search finds nothing
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
        const results = await searchRows(
            query,
            limit,
            offset,
            ({ skip, take }) =>
                prisma.audiobook.findMany({
                    where: {
                        OR: [
                            { title: { contains: query, mode: "insensitive" } },
                            { author: { contains: query, mode: "insensitive" } },
                            { narrator: { contains: query, mode: "insensitive" } },
                            { series: { contains: query, mode: "insensitive" } },
                        ],
                    },
                    select: AUDIOBOOK_FIELDS,
                    take,
                    skip,
                    orderBy: [{ title: "asc" }, { id: "asc" }],
                }),
            (pattern, { skip, take }) => prisma.$queryRaw<{ id: string }[]>`
                SELECT b.id FROM "Audiobook" b
                 WHERE b.title ~ ${pattern} OR b.author ~ ${pattern} OR b.narrator ~ ${pattern} OR b.series ~ ${pattern}
                 ORDER BY b.title ASC, b.id ASC LIMIT ${take} OFFSET ${skip}`,
            (ids) => prisma.audiobook.findMany({ where: { id: { in: ids } }, select: AUDIOBOOK_FIELDS }),
        );

        return results.map((r) => ({
            ...r,
            coverUrl: r.coverUrl ? `/audiobooks/${r.id}/cover` : null,
            rank: 0,
        }));
    }

    /**
     * LIKE-based podcast search, the fallback when full-text search finds nothing
     */
    async searchPodcasts({
        query,
        limit = 20,
        offset = 0,
        userId,
    }: FollowedSearchOptions): Promise<PodcastSearchResult[]> {
        if (!query || query.trim().length === 0) {
            return [];
        }

        try {
            const results = await searchRows(
                query,
                limit,
                offset,
                ({ skip, take }) =>
                    prisma.podcast.findMany({
                        where: {
                            subscriptions: { some: { userId } },
                            OR: [
                                { title: { contains: query, mode: "insensitive" } },
                                { author: { contains: query, mode: "insensitive" } },
                                { description: { contains: query, mode: "insensitive" } },
                            ],
                        },
                        select: PODCAST_FIELDS,
                        take,
                        skip,
                        orderBy: [{ title: "asc" }, { id: "asc" }],
                    }),
                (pattern, { skip, take }) => prisma.$queryRaw<{ id: string }[]>`
                    SELECT p.id FROM "Podcast" p
                     WHERE (p.title ~ ${pattern} OR p.author ~ ${pattern} OR p.description ~ ${pattern})
                       AND EXISTS (SELECT 1 FROM "PodcastSubscription" s WHERE s."podcastId" = p.id AND s."userId" = ${userId})
                     ORDER BY p.title ASC, p.id ASC LIMIT ${take} OFFSET ${skip}`,
                (ids) => prisma.podcast.findMany({ where: { id: { in: ids } }, select: PODCAST_FIELDS }),
            );

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
        userId,
    }: FollowedSearchOptions & { genre?: string }): Promise<SearchResults> {
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

        // Check Redis cache first. Per user: the answer includes the shows and episodes they follow.
        const cacheKey = `search:all:${userId}:${normalizeCacheQuery(query)}:${limit}:${genre || ""}`;
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
                this.searchPodcastsFTS({ query, limit, userId }),
                this.searchAudiobooksFTS({ query, limit }),
                this.searchEpisodes({ query, limit, userId }),
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
        // Genre names are compared as genreKeys here, not in SQL: on SQL_ASCII the database folds ASCII case only.
        const wanted = genreKey(genre);
        const candidates = await prisma.track.findMany({
            where: { id: { in: trackIds } },
            select: {
                id: true,
                trackGenres: { select: { genre: { select: { name: true } } } },
                album: { select: { artist: { select: { genres: true, userGenres: true } } } },
            },
        });
        const tracksWithGenre = candidates.filter(
            (t) =>
                (wanted !== "" && t.trackGenres.some((tg) => genreKey(tg.genre.name) === wanted)) ||
                artistTaggedWithGenre(t.album.artist.genres, t.album.artist.userGenres, genre),
        );

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
        userId,
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
        // Shows and episodes depend on who is asking; the library's music does not.
        const who = type === "podcasts" || type === "episodes" ? userId : "";
        const cacheKey = `search:${type}:${who}:${normalizeCacheQuery(query)}:${limit}:${offset}:${genre || ""}`;
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
                results.podcasts = await this.searchPodcastsFTS({ query, limit, offset, userId });
                break;
            case "audiobooks":
                results.audiobooks = await this.searchAudiobooksFTS({ query, limit, offset });
                break;
            case "episodes":
                results.episodes = await this.searchEpisodes({ query, limit, offset, userId });
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
