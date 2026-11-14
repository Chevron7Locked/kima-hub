import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { playableSongSql } from "../utils/playableSong";
import { albumHasPlayableSongSql, artistHasPlayableSongSql } from "./libraryFilters";
import { genreKey, libraryArtistIdsForGenre } from "../utils/genreSql";
import { searchRows, containsSql, hasNonAscii } from "./textMatch";
import { audiobookCoverAddress } from "./imageStorage";

export function normalizeCacheQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, " ");
}

interface SearchOptions {
    query: string;
    limit?: number;
    offset?: number;
}

/** What a genre filter keeps: the songs of artists tagged with the genre, and the songs tagged with it themselves. */
interface GenreScope {
    artistIds: string[];
    genreIds: string[];
}

/**
 * The artists and song genres that answer to a genre. Both are matched as genreKeys here, not in SQL: on SQL_ASCII the
 * database folds ASCII case only. A genre nothing carries has an empty scope, which keeps no song.
 */
async function genreScopeOf(genre: string): Promise<GenreScope> {
    const wanted = genreKey(genre);
    if (wanted === "") return { artistIds: [], genreIds: [] };
    const [artistIds, genres] = await Promise.all([
        libraryArtistIdsForGenre(genre),
        prisma.genre.findMany({ select: { id: true, name: true } }),
    ]);
    return { artistIds, genreIds: genres.filter((g) => genreKey(g.name) === wanted).map((g) => g.id) };
}

/** The genre condition for a raw song query that names the song `t` and its album `a`; nothing when there is no scope. */
function genreSql(scope: GenreScope | undefined): Prisma.Sql {
    if (!scope) return Prisma.empty;
    return Prisma.sql`AND (a."artistId" = ANY(${scope.artistIds}::text[])
              OR EXISTS (SELECT 1 FROM "TrackGenre" tg WHERE tg."trackId" = t.id AND tg."genreId" = ANY(${scope.genreIds}::text[])))`;
}

/** A song's title as shown, lower-cased, for ordering: the edited title, else the file's. `song` is the table name or alias. */
export function shownSongTitleSql(song: string): Prisma.Sql {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(song)) throw new Error(`"${song}" is not a table name or alias`);
    return Prisma.sql`LOWER(COALESCE(NULLIF("${Prisma.raw(song)}"."displayTitle", ''), "${Prisma.raw(song)}".title))`;
}

const ARTIST_FIELDS = { id: true, name: true, mbid: true, heroUrl: true } as const;
const ALBUM_FIELDS = {
    id: true, title: true, artistId: true, year: true, coverUrl: true, artist: { select: { name: true } },
} as const;
const TRACK_FIELDS = {
    id: true, title: true, displayTitle: true, albumId: true, duration: true,
    album: { select: { title: true, artistId: true, artist: { select: { name: true } } } },
} as const;
const EPISODE_FIELDS = {
    id: true, title: true, description: true, podcastId: true, publishedAt: true, duration: true, audioUrl: true,
    podcast: { select: { title: true } },
} as const;
const AUDIOBOOK_FIELDS = {
    id: true, title: true, author: true, narrator: true, series: true, description: true, coverUrl: true, duration: true,
    localCoverPath: true, coverVersion: true,
} as const;

/** What a search row reads to name an audiobook's cover; the result shows the address, not these. */
type AudiobookCoverColumns = { localCoverPath: string | null; coverVersion: string | null };

/** An audiobook row as search shows it: the cover as its versioned address, without the columns the address is made from. */
function audiobookResult<T extends { id: string; coverUrl: string | null } & AudiobookCoverColumns>(
    row: T,
): Omit<T, "localCoverPath" | "coverVersion"> {
    const { localCoverPath, coverVersion, ...rest } = row;
    return { ...rest, coverUrl: audiobookCoverAddress({ id: row.id, localCoverPath, coverUrl: row.coverUrl, coverVersion }) };
}
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

interface ArtistSearchResult {
    id: string;
    name: string;
    /** null when MusicBrainz has not resolved this artist yet. */
    mbid: string | null;
    heroUrl: string | null;
    summary?: string;
    rank: number;
}

interface AlbumSearchResult {
    id: string;
    title: string;
    artistId: string;
    artistName: string;
    year: number | null;
    coverUrl: string | null;
    rank: number;
}

interface TrackSearchResult {
    id: string;
    title: string;
    /** The title as edited in Kima, if it was. */
    displayTitle: string | null;
    albumId: string;
    albumTitle: string;
    artistId: string;
    artistName: string;
    duration: number;
    rank: number;
}

interface PodcastSearchResult {
    id: string;
    title: string;
    author: string | null;
    description: string | null;
    imageUrl: string | null;
    episodeCount: number;
    rank?: number;
}

interface EpisodeSearchResult {
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

interface AudiobookSearchResult {
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

interface SearchByTypeOptions {
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

/** Rows read by id come back in the order of `found`. */
async function inOrder<T extends { id: string }>(found: { id: string }[], load: (ids: string[]) => Promise<T[]>): Promise<T[]> {
    const ids = found.map((r) => r.id);
    if (ids.length === 0) return [];
    const byId = new Map((await load(ids)).map((row) => [row.id, row]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}

export class SearchService {
    /**
     * Full-text search first; the substring search when the query has no searchable words, holds a letter outside ASCII
     * (full-text search would read "hunié" as "huni"), or when full-text search fails; and, when `fallbackOnEmpty` is
     * set, when full-text search finds nothing for the query. A page past the end of the full-text hits is empty: only
     * a query full-text search finds nothing for at all falls back, on every page of it, so one search keeps one
     * result set across its pages. An empty query finds nothing.
     */
    private async ftsOrFallback<T>(
        query: string,
        label: string,
        fts: (tsquery: string, page: { skip: number; take: number }) => Promise<T[]>,
        fallback: () => Promise<T[]>,
        page: { limit: number; offset: number; fallbackOnEmpty: boolean },
    ): Promise<T[]> {
        if (!query || query.trim().length === 0) return [];
        const tsquery = hasNonAscii(query) ? "" : this.queryToTsquery(query);
        if (!tsquery) return fallback();
        try {
            const results = await fts(tsquery, { skip: page.offset, take: page.limit });
            if (results.length > 0 || !page.fallbackOnEmpty) return results;
            if (page.offset === 0 || (await fts(tsquery, { skip: 0, take: 1 })).length === 0) return fallback();
            return results;
        } catch (error) {
            logger.error(`${label} search error:`, error);
            return fallback();
        }
    }

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
        // The ids are paged in the order of the name shown (Prisma cannot order by an edited name or the file's), then read.
        const found = await prisma.$queryRaw<{ id: string }[]>`
            SELECT a.id FROM "Artist" a
             WHERE ${containsSql([Prisma.sql`a.name`, Prisma.sql`a."displayName"`], query)}
               AND ${artistHasPlayableSongSql("a")}
             ORDER BY LOWER(COALESCE(NULLIF(a."displayName", ''), a.name)) ASC, a.id ASC LIMIT ${limit} OFFSET ${offset}`;
        const results = await inOrder(found, (ids) => prisma.artist.findMany({ where: { id: { in: ids } }, select: ARTIST_FIELDS }));
        return results.map((r) => ({ ...r, rank: 0 }));
    }

    async searchArtists({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<ArtistSearchResult[]> {
        return this.ftsOrFallback(
            query,
            "Artist",
            (tsquery, { skip, take }) => prisma.$queryRaw<ArtistSearchResult[]>`
            SELECT
              a.id,
              a.name,
              a.mbid,
              a."heroUrl",
              a.summary,
              ts_rank(a."searchVector", to_tsquery('english', ${tsquery})) AS rank
            FROM "Artist" a
            WHERE a."searchVector" @@ to_tsquery('english', ${tsquery})
              AND ${artistHasPlayableSongSql("a")}
            ORDER BY rank DESC, LOWER(COALESCE(NULLIF(a."displayName", ''), a.name)) ASC, a.id ASC
            LIMIT ${take}
            OFFSET ${skip}
          `,
            () => this.searchArtistsFallback({ query, limit, offset }),
            { limit, offset, fallbackOnEmpty: true },
        );
    }

    private async searchAlbumsFallback({
        query,
        limit = 20,
        offset = 0,
    }: SearchOptions): Promise<AlbumSearchResult[]> {
        // The ids are paged in the order of the title shown (Prisma cannot order by an edited title or the file's), then read.
        const match = containsSql(
            [Prisma.sql`al.title`, Prisma.sql`al."displayTitle"`, Prisma.sql`ar.name`, Prisma.sql`ar."displayName"`],
            query,
        );
        const found = await prisma.$queryRaw<{ id: string }[]>`
            SELECT al.id FROM "Album" al JOIN "Artist" ar ON ar.id = al."artistId"
             WHERE ${albumHasPlayableSongSql("al")} AND ${match}
             ORDER BY LOWER(COALESCE(NULLIF(al."displayTitle", ''), al.title)) ASC, al.id ASC LIMIT ${limit} OFFSET ${offset}`;
        const results = await inOrder(found, (ids) => prisma.album.findMany({ where: { id: { in: ids } }, select: ALBUM_FIELDS }));

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
        return this.ftsOrFallback(
            query,
            "Album",
            (tsquery, { skip, take }) => prisma.$queryRaw<AlbumSearchResult[]>`
            SELECT id, title, "artistId", "artistName", year, "coverUrl", rank FROM (
              SELECT DISTINCT ON (id) id, title, "displayTitle", "artistId", "artistName", year, "coverUrl", rank
              FROM (
                SELECT
                  a.id,
                  a.title,
                  a."displayTitle",
                  a."artistId",
                  ar.name as "artistName",
                  a.year,
                  a."coverUrl",
                  ts_rank(a."searchVector", to_tsquery('english', ${tsquery})) AS rank
                FROM "Album" a
                LEFT JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE a."searchVector" @@ to_tsquery('english', ${tsquery})
                  AND ${albumHasPlayableSongSql("a")}

                UNION ALL

                SELECT
                  a.id,
                  a.title,
                  a."displayTitle",
                  a."artistId",
                  ar.name as "artistName",
                  a.year,
                  a."coverUrl",
                  ts_rank(ar."searchVector", to_tsquery('english', ${tsquery})) AS rank
                FROM "Album" a
                INNER JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE ar."searchVector" @@ to_tsquery('english', ${tsquery})
                  AND ${albumHasPlayableSongSql("a")}
              ) combined
              ORDER BY id, rank DESC
            ) deduped
            ORDER BY rank DESC, LOWER(COALESCE(NULLIF("displayTitle", ''), title)) ASC, id ASC
            LIMIT ${take}
            OFFSET ${skip}
          `,
            () => this.searchAlbumsFallback({ query, limit, offset }),
            { limit, offset, fallbackOnEmpty: true },
        );
    }

    private async searchTracksFallback({
        query,
        limit = 20,
        offset = 0,
        scope,
    }: SearchOptions & { scope?: GenreScope }): Promise<TrackSearchResult[]> {
        // The ids are paged in the order of the title shown (Prisma cannot order by an edited title or the file's), then read.
        const found = await prisma.$queryRaw<{ id: string }[]>`
            SELECT t.id FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
             WHERE ${containsSql([Prisma.sql`t.title`, Prisma.sql`t."displayTitle"`], query)} AND ${playableSongSql("t", "a")}
             ${genreSql(scope)}
             ORDER BY ${shownSongTitleSql("t")} ASC, t.id ASC LIMIT ${limit} OFFSET ${offset}`;
        const results = await inOrder(found, (ids) => prisma.track.findMany({ where: { id: { in: ids } }, select: TRACK_FIELDS }));

        return results.map((r) => ({
            id: r.id,
            title: r.title,
            displayTitle: r.displayTitle,
            albumId: r.albumId,
            albumTitle: r.album.title,
            artistId: r.album.artistId,
            artistName: r.album.artist.name,
            duration: r.duration,
            rank: 0,
        }));
    }

    /**
     * One page of song matches. Full-text search ranks them; the substring search answers only a search full-text
     * search finds nothing for, on every page of it, so one search keeps one result set across its pages. With a
     * `genre`, only that genre's songs are searched, before the page is cut.
     */
    async searchTracks({
        query,
        limit = 20,
        offset = 0,
        genre,
    }: SearchOptions & { genre?: string }): Promise<TrackSearchResult[]> {
        if (!query || query.trim().length === 0) return [];
        const scope = genre ? await genreScopeOf(genre) : undefined;
        return this.ftsOrFallback(
            query,
            "Track",
            (tsquery, { skip, take }) => prisma.$queryRaw<TrackSearchResult[]>`
            SELECT
              t.id,
              t.title,
              t."displayTitle",
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
            AND ${playableSongSql("t", "a")}
            ${genreSql(scope)}
            ORDER BY rank DESC, ${shownSongTitleSql("t")} ASC, t.id ASC
            LIMIT ${take}
            OFFSET ${skip}
          `,
            () => this.searchTracksFallback({ query, limit, offset, scope }),
            { limit, offset, fallbackOnEmpty: true },
        );
    }

    /**
     * The songs the old Subsonic `search` call asks for: each field given must hold (a blank one is not asked). `any` holds
     * when every word of it is found in the song's title, album or artist, as shown or as in the file; `title`,
     * `album` and `artist` hold when their text is found in that one name. Songs come in the order of the title shown.
     */
    async searchSongsByFields({
        any,
        artist,
        album,
        title,
        limit = 20,
        offset = 0,
    }: {
        any?: string;
        artist?: string;
        album?: string;
        title?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ ids: string[]; total: number }> {
        const names = {
            title: [Prisma.sql`t.title`, Prisma.sql`t."displayTitle"`],
            album: [Prisma.sql`a.title`, Prisma.sql`a."displayTitle"`],
            artist: [Prisma.sql`ar.name`, Prisma.sql`ar."displayName"`],
        };
        const asked: Prisma.Sql[] = [];
        for (const word of (any ?? "").split(/\s+/).filter((w) => w.length > 0)) {
            asked.push(containsSql([...names.title, ...names.album, ...names.artist], word));
        }
        for (const [field, text] of [["title", title], ["album", album], ["artist", artist]] as const) {
            if (text && text.trim().length > 0) asked.push(containsSql(names[field], text.trim()));
        }
        const where = Prisma.join([playableSongSql("t", "a"), ...asked], " AND ");
        const from = Prisma.sql`"Track" t JOIN "Album" a ON a.id = t."albumId" JOIN "Artist" ar ON ar.id = a."artistId"`;
        const [found, counted] = await Promise.all([
            prisma.$queryRaw<{ id: string }[]>`
                SELECT t.id FROM ${from} WHERE ${where}
                ORDER BY ${shownSongTitleSql("t")} ASC, t.id ASC LIMIT ${limit} OFFSET ${offset}`,
            prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${from} WHERE ${where}`,
        ]);
        return { ids: found.map((r) => r.id), total: counted[0]?.n ?? 0 };
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
        return this.ftsOrFallback(
            query,
            "Podcast FTS",
            async (tsquery, { skip, take }) => {
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
            LIMIT ${take}
            OFFSET ${skip}
          `;
                return results;
            },
            () => this.searchPodcasts({ query, limit, offset, userId }),
            { limit, offset, fallbackOnEmpty: false },
        );
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
        return this.ftsOrFallback(
            query,
            "Episode",
            async (tsquery, { skip, take }) => {
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
            LIMIT ${take}
            OFFSET ${skip}
          `;
                return results;
            },
            () => this.searchEpisodesFallback({ query, limit, offset, userId }),
            { limit, offset, fallbackOnEmpty: false },
        );
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
        return this.ftsOrFallback(
            query,
            "Audiobook FTS",
            async (tsquery, { skip, take }) => {
                const results = await prisma.$queryRaw<Array<Omit<AudiobookSearchResult, "coverUrl"> & AudiobookCoverColumns & { coverUrl: string | null }>>`
            SELECT
              id,
              title,
              author,
              narrator,
              series,
              description,
              "coverUrl",
              "localCoverPath",
              "coverVersion",
              duration,
              ts_rank("searchVector", to_tsquery('english', ${tsquery})) AS rank
            FROM "Audiobook"
            WHERE "searchVector" @@ to_tsquery('english', ${tsquery})
            ORDER BY rank DESC, title ASC
            LIMIT ${take}
            OFFSET ${skip}
          `;
                return results.map(audiobookResult);
            },
            () => this.searchAudiobooksFallback({ query, limit, offset }),
            { limit, offset, fallbackOnEmpty: true },
        );
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
                            { description: { contains: query, mode: "insensitive" } },
                        ],
                    },
                    select: AUDIOBOOK_FIELDS,
                    take,
                    skip,
                    orderBy: [{ title: "asc" }, { id: "asc" }],
                }),
            (pattern, { skip, take }) => prisma.$queryRaw<{ id: string }[]>`
                SELECT b.id FROM "Audiobook" b
                 WHERE b.title ~ ${pattern} OR b.author ~ ${pattern} OR b.narrator ~ ${pattern} OR b.series ~ ${pattern} OR b.description ~ ${pattern}
                 ORDER BY b.title ASC, b.id ASC LIMIT ${take} OFFSET ${skip}`,
            (ids) => prisma.audiobook.findMany({ where: { id: { in: ids } }, select: AUDIOBOOK_FIELDS }),
        );

        return results.map((r) => ({ ...audiobookResult(r), rank: 0 }));
    }

    /**
     * LIKE search of the shows a listener follows; used when the query has no searchable words or full-text search
     * fails
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
                // Cached as answered, audiobook cover links already rewritten.
                return JSON.parse(cached);
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
                this.searchTracks({ query, limit, genre }),
                this.searchPodcastsFTS({ query, limit, userId }),
                this.searchAudiobooksFTS({ query, limit }),
                this.searchEpisodes({ query, limit, userId }),
            ]);

        const results = {
            artists,
            albums,
            tracks,
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
            case "tracks":
                results.tracks = await this.searchTracks({ query, limit, offset, genre });
                break;
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
