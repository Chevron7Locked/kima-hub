/**
 * The genre key (genreKey), the one rule for the genres an album shows (shownAlbumGenres), the album filter Subsonic uses
 * (libraryAlbumIdsOfGenre: exactly that genre), the song filter (songGenreFilterSql: exactly that genre for Subsonic, or
 * that genre and genres containing it for the radio stations and the web's search) and the genre lists (computeGenreTotals,
 * libraryGenreTotals, librarySongGenreTotals). An album shows its own merged genres, else its artist's; a song shows its own
 * tags (most voted first, shownGenresOfSongs), else its album's.
 *
 * Which genre a thing is found and counted under follows what it shows:
 * - Album filters and album counts (libraryAlbumIdsOfGenre, libraryGenreTotals) work by the album's genres.
 * - Song filters and the song-level list (songGenreFilterSql, librarySongGenreTotals, Subsonic's getSongsByGenre,
 *   getRandomSongs and getGenres) work by the genres a song shows: a song with a usable tag of its own is found and counted
 *   under its own tags only, a song with none under its album's. A genre only songs carry lists with no albums.
 *
 * Matching and totals are computed in TypeScript, never in SQL: a database in the SQL_ASCII encoding can neither normalize
 * nor lower-case beyond ASCII, and the rule is one every surface shares.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getMergedGenres } from "./metadataOverrides";
import { albumHasPlayableSongSql } from "../services/libraryFilters";
import { assertSqlName, playableSongSql } from "./playableSong";

/**
 * Spaces (any width, no-break included), hyphens, dashes and the minus sign, underscores, slashes, dots and middle dots,
 * apostrophes, and the invisible soft hyphen, zero-width space and byte-order mark.
 */
const GENRE_KEY_STRIP = /[\s\u00a0\u202f\u00ad\u200b\ufeff_/.\u00b7'\u2018\u2019\u2010-\u2015\u2043\u2212-]+/g;

/**
 * A genre name as one genre: in one Unicode form (an accent typed as its own mark reads as the accented letter, a
 * full-width hyphen as a hyphen), lower-cased, without the characters above, so "Hip Hop", "hip-hop" and "HipHop"
 * read as one (#235). Letters of every script are kept, so different words stay apart; a name made only of the
 * characters above has the key ''.
 */
export function genreKey(name: string | null | undefined): string {
    return (name ?? "").normalize("NFKC").toLowerCase().replace(GENRE_KEY_STRIP, "");
}

/**
 * Whether one genre name is the wanted genre key: every spelling of that genre and no other ("rock" is not "punk
 * rock"). An empty key (a request made only of spaces and punctuation) is no genre and is nothing.
 */
function genreIsWanted(name: string, wantedKey: string): boolean {
    return wantedKey !== "" && genreKey(name) === wantedKey;
}

/**
 * Whether one genre name answers to a wanted genre key: every spelling of that genre, and genres that contain it ("hip
 * hop" answers "alternative hip-hop"). An empty key is no genre and answers to nothing.
 */
function genreAnswersTo(name: string, wantedKey: string): boolean {
    return wantedKey !== "" && genreKey(name).includes(wantedKey);
}

/** What the genre rule reads of an artist: its tags, and its names for dropping a tag that names the artist. */
export interface GenreArtist {
    name?: string | null;
    normalizedName?: string | null;
    genres?: unknown;
    userGenres?: unknown;
}

/** What the genre rule reads of an album: its own tags. */
export interface GenreAlbum {
    genres?: unknown;
    userGenres?: unknown;
}

/**
 * The genres an album shows, the one rule for the album, its songs, the genre filters and the genre list. The album's own
 * merged genres (getMergedGenres: the person's list when set, else the enriched one), else its artist's. An internal
 * marker (a tag starting "_"), an empty tag and a tag equal to the artist's own name (a band named "Jazz" tagged "jazz")
 * are no genre, and an album left with none shows its artist's. The first is the genre it shows; the rest are the ones it
 * answers to.
 */
export function shownAlbumGenres(album: GenreAlbum, artist: GenreArtist): string[] {
    const ofAlbum = usableGenres(getMergedGenres(album), artist);
    return ofAlbum.length > 0 ? ofAlbum : usableGenres(getMergedGenres(artist), artist);
}

/** The tags among `names` that are a genre: not empty, not an internal marker, not the artist's own name. */
function usableGenres(names: string[], artist: GenreArtist): string[] {
    const own = new Set([genreKey(artist.name), genreKey(artist.normalizedName)]);
    return names.filter((name) => {
        const key = genreKey(name);
        return !!name && !name.startsWith("_") && key !== "" && !own.has(key);
    });
}

/**
 * The genres a song shows, given its own tags already in the order to show them: the same tags an album drops are dropped
 * here, and a song left with none shows what its album shows (shownAlbumGenres). The first is the genre it shows.
 */
export function shownSongGenres(own: readonly string[] | undefined, album: GenreAlbum, artist: GenreArtist): string[] {
    const mine = usableGenres([...(own ?? [])], artist);
    return mine.length > 0 ? mine : shownAlbumGenres(album, artist);
}

/**
 * The own genre tags of these songs (the genres of each identified recording), by song id, each list most voted first: by
 * the place kept with the tag, tags stored before places were kept after the ranked ones, ties in code-unit name order
 * (not localeCompare: the same order on every host, so the first tag is the same everywhere). A song with none is not in
 * the map.
 */
async function ownSongGenres(trackIds: readonly string[]): Promise<Map<string, string[]>> {
    const byTrack = new Map<string, { name: string; rank: number | null }[]>();
    if (trackIds.length === 0) return new Map();
    const rows = await prisma.trackGenre.findMany({
        where: { trackId: { in: [...new Set(trackIds)] } },
        select: { trackId: true, rank: true, genre: { select: { name: true } } },
    });
    for (const { trackId, rank, genre } of rows) {
        const tags = byTrack.get(trackId);
        if (tags) tags.push({ name: genre.name, rank });
        else byTrack.set(trackId, [{ name: genre.name, rank }]);
    }
    const ordered = new Map<string, string[]>();
    for (const [trackId, tags] of byTrack) {
        tags.sort((a, b) => {
            if (a.rank !== b.rank) return a.rank === null ? 1 : b.rank === null ? -1 : a.rank - b.rank;
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
        ordered.set(trackId, tags.map((t) => t.name));
    }
    return ordered;
}

/** One song to show genres for: its id and the album and artist it sits on. */
export interface GenreSong {
    id: string;
    album: GenreAlbum;
    artist: GenreArtist;
}

/**
 * The genres each of these songs shows, by song id: its own tags (most voted first), else its album's. The one call every
 * song list makes for its genre fields; every song given is in the map.
 */
export async function shownGenresOfSongs(songs: readonly GenreSong[]): Promise<Map<string, string[]>> {
    const own = await ownSongGenres(songs.map((s) => s.id));
    return new Map(songs.map((s) => [s.id, shownSongGenres(own.get(s.id), s.album, s.artist)]));
}

/**
 * The ids of the library's albums (those holding a playable song) one of whose shown genres satisfies `matches`: the
 * database lists the albums that, or whose artist, carry a tag, the names are compared here.
 */
async function libraryAlbumIdsWhere(genreValue: string, matches: (name: string, wantedKey: string) => boolean): Promise<string[]> {
    const wanted = genreKey(genreValue);
    if (wanted === "") return [];
    const tagged = await prisma.$queryRaw<
        {
            id: string; genres: unknown; userGenres: unknown;
            name: string; normalizedName: string | null; artistGenres: unknown; artistUserGenres: unknown;
        }[]
    >(Prisma.sql`
        SELECT a.id, a.genres, a."userGenres", ar.name, ar."normalizedName",
               ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres"
        FROM "Album" a
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE ${albumHasPlayableSongSql("a")}
          AND (a.genres IS NOT NULL OR a."userGenres" IS NOT NULL OR ar.genres IS NOT NULL OR ar."userGenres" IS NOT NULL)
    `);
    return tagged
        .filter((row) =>
            shownAlbumGenres(row, {
                name: row.name, normalizedName: row.normalizedName, genres: row.artistGenres, userGenres: row.artistUserGenres,
            }).some((g) => matches(g, wanted)),
        )
        .map((row) => row.id);
}

/**
 * The ids of the library's albums that show exactly this genre (any spelling of it, genreKey), the filter Subsonic's
 * genre lists (byGenre, getSongsByGenre, getRandomSongs) use: "rock" lists the albums of "rock" and "Rock", not of
 * "punk rock", the same genres getGenres lists, as Subsonic and Navidrome do.
 */
export async function libraryAlbumIdsOfGenre(genreValue: string): Promise<string[]> {
    return libraryAlbumIdsWhere(genreValue, genreIsWanted);
}

/**
 * How a requested genre is compared with the genres a thing shows: `exact` is that genre in any spelling and no other (the
 * Subsonic genre filters), `contains` also takes genres that contain it ("hip hop" answers "alternative hip-hop"; the radio
 * stations and the web's search, which look for music near a genre).
 */
export type GenreMatch = "exact" | "contains";

/**
 * A SQL condition on the playable songs that show this genre (any spelling of it), for a query that names the song
 * `"Track"` as `songAlias` and its album as `albumAlias`: a song with a usable tag of its own is in when one of its tags
 * matches and out otherwise, a song with none is in when its album shows a matching genre. `match` says what matches
 * (GenreMatch); the Subsonic filters take the default, exactly that genre. A genre nothing shows, or an empty name,
 * matches no song. The database lists the candidate songs and their tags; the names are compared here.
 */
export async function songGenreFilterSql(
    genreValue: string,
    songAlias: string,
    albumAlias: string,
    match: GenreMatch = "exact",
): Promise<Prisma.Sql> {
    assertSqlName(songAlias, "songGenreFilterSql");
    assertSqlName(albumAlias, "songGenreFilterSql");
    const wanted = genreKey(genreValue);
    if (wanted === "") return Prisma.sql`1 = 0`;
    const matches = match === "exact" ? genreIsWanted : genreAnswersTo;
    const albumIds = await libraryAlbumIdsWhere(genreValue, matches);
    const genreIds = (await prisma.genre.findMany({ select: { id: true, name: true } }))
        .filter((g) => matches(g.name, wanted))
        .map((g) => g.id);
    const rows = await prisma.$queryRaw<{ id: string; name: string; normalizedName: string | null; tags: string[] }[]>(Prisma.sql`
        SELECT t.id, ar.name, ar."normalizedName", array_agg(g.name) AS tags
        FROM "Track" t
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        JOIN "TrackGenre" tg ON tg."trackId" = t.id
        JOIN "Genre" g ON g.id = tg."genreId"
        WHERE ${playableSongSql("t", "a")}
          AND (tg."genreId" = ANY(${genreIds}::text[]) OR a.id = ANY(${albumIds}::text[]))
        GROUP BY t.id, ar.id
    `);
    const included: string[] = [];
    const excluded: string[] = [];
    for (const row of rows) {
        const own = usableGenres(row.tags, row);
        if (own.length === 0) continue;
        (own.some((name) => matches(name, wanted)) ? included : excluded).push(row.id);
    }
    const song = Prisma.raw(`"${songAlias}"`);
    const album = Prisma.raw(`"${albumAlias}"`);
    return Prisma.sql`(${song}.id = ANY(${included}::text[])
        OR (${album}.id = ANY(${albumIds}::text[]) AND NOT ${song}.id = ANY(${excluded}::text[])))`;
}

/** One library album for the genre list: its id, its tags, its artist's, and the playable songs it holds. */
export interface GenreCountedAlbum extends GenreAlbum {
    id: string;
    artist: GenreArtist;
    /** Playable songs this album has. */
    songs: number;
}

/** One genre of the shared list: its key, commonest spelling, and summed library counts. */
export interface GenreTotals {
    /** The genreKey the entry groups under. */
    key: string;
    /** The spelling carrying the most songs (ties: alphabetically first). */
    name: string;
    songs: number;
    albums: number;
}

/** A playable song with a genre tag of its own: the album it sits on, its artist (for dropping a tag that names it) and its tags. */
export interface OwnTaggedSong {
    albumId: string;
    artist: GenreArtist;
    tags: readonly string[];
}

/**
 * The genre list, computed once for every surface that shows one (Subsonic's getGenres and the radio stations). Each
 * album counts under the genres it shows (shownAlbumGenres), so a genre a person added shows and counts like an enriched
 * one and a genre a person removed counts under neither. Without `ownTagged`, a song counts under its album's genres. With
 * it (the playable songs that have tags of their own), a song with a usable tag of its own counts under those tags, once
 * per genre, and not under its album's; its album still counts under the genres it shows, so a genre only songs carry
 * lists with no albums. Spellings of one genre are one genre (genreKey) listed under the spelling carrying the most
 * songs; each album is counted once per genre, so an album tagged "Hip-Hop" AND "hip hop" adds its songs once. Each
 * caller keeps its own output shape and thresholds.
 */
export function computeGenreTotals(albums: GenreCountedAlbum[], ownTagged: readonly OwnTaggedSong[] = []): GenreTotals[] {
    const songs = new Map<string, number>();
    const counted = new Map<string, number>();
    const spellings = new Map<string, Map<string, number>>();
    const spell = (key: string, name: string, weight: number) => {
        const carried = spellings.get(key) ?? new Map<string, number>();
        if (!spellings.has(key)) spellings.set(key, carried);
        carried.set(name, (carried.get(name) ?? 0) + weight);
    };

    // The songs that show tags of their own, and how many of each album's songs they are.
    const shownOwn: { tags: string[] }[] = [];
    const ownOnAlbum = new Map<string, number>();
    for (const song of ownTagged) {
        const tags = usableGenres([...song.tags], song.artist);
        if (tags.length === 0) continue;
        shownOwn.push({ tags });
        ownOnAlbum.set(song.albumId, (ownOnAlbum.get(song.albumId) ?? 0) + 1);
    }

    for (const album of albums) {
        const albumSongs = Math.max(0, album.songs - (ownOnAlbum.get(album.id) ?? 0));
        const seen = new Set<string>();
        for (const name of shownAlbumGenres(album, album.artist)) {
            const key = genreKey(name);
            // One spelling per album counted once, as one album is counted once per genre.
            if (!seen.has(key)) {
                songs.set(key, (songs.get(key) ?? 0) + albumSongs);
                counted.set(key, (counted.get(key) ?? 0) + 1);
            }
            seen.add(key);
            spell(key, name, albumSongs);
        }
    }
    for (const { tags } of shownOwn) {
        const seen = new Set<string>();
        for (const name of new Set(tags)) {
            const key = genreKey(name);
            if (!seen.has(key)) songs.set(key, (songs.get(key) ?? 0) + 1);
            seen.add(key);
            spell(key, name, 1);
        }
    }
    return Array.from(songs.entries()).map(([key, songCount]) => ({
        key,
        name: Array.from(spellings.get(key)!.entries()).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))[0][0],
        songs: songCount,
        albums: counted.get(key) ?? 0,
    }));
}

/**
 * Every library album with a genre tag of its own or its artist's and a playable song, with the playable songs it holds,
 * counted from the songs themselves. Nothing cached is read: a count kept on the album can be stale (a file went missing
 * since the last scan) and can include songs that cannot play.
 */
async function libraryGenreAlbums(): Promise<GenreCountedAlbum[]> {
    const rows = await prisma.$queryRaw<
        {
            id: string; genres: unknown; userGenres: unknown; name: string; normalizedName: string | null;
            artistGenres: unknown; artistUserGenres: unknown; songs: bigint;
        }[]
    >(Prisma.sql`
        SELECT a.id, a.genres, a."userGenres", ar.name, ar."normalizedName",
               ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres", COUNT(t.id)::bigint AS songs
        FROM "Album" a
        JOIN "Artist" ar ON ar.id = a."artistId"
        JOIN "Track" t ON t."albumId" = a.id
        WHERE ${playableSongSql("t", "a")}
          AND (a.genres IS NOT NULL OR a."userGenres" IS NOT NULL OR ar.genres IS NOT NULL OR ar."userGenres" IS NOT NULL)
        GROUP BY a.id, ar.id
    `);
    return rows.map((r) => ({
        id: r.id,
        genres: r.genres,
        userGenres: r.userGenres,
        artist: { name: r.name, normalizedName: r.normalizedName, genres: r.artistGenres, userGenres: r.artistUserGenres },
        songs: Number(r.songs),
    }));
}

/** Every playable song that has a genre tag of its own, with the album it sits on, its artist's names and its tags. */
async function libraryOwnTaggedSongs(): Promise<OwnTaggedSong[]> {
    const rows = await prisma.$queryRaw<{ albumId: string; name: string; normalizedName: string | null; tags: string[] }[]>(Prisma.sql`
        SELECT a.id AS "albumId", ar.name, ar."normalizedName", array_agg(g.name) AS tags
        FROM "TrackGenre" tg
        JOIN "Track" t ON t.id = tg."trackId"
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        JOIN "Genre" g ON g.id = tg."genreId"
        WHERE ${playableSongSql("t", "a")}
        GROUP BY t.id, a.id, ar.id
    `);
    return rows.map((r) => ({ albumId: r.albumId, artist: { name: r.name, normalizedName: r.normalizedName }, tags: r.tags }));
}

/**
 * The genre list of the library as its albums show it: computeGenreTotals over libraryGenreAlbums. The radio stations
 * select albums, so they read this one.
 */
export async function libraryGenreTotals(): Promise<GenreTotals[]> {
    return computeGenreTotals(await libraryGenreAlbums());
}

/**
 * The genre list of the library as its songs show it (Subsonic's getGenres): each song under its own tags, else its album's
 * genres, so it agrees with songGenreFilterSql.
 */
export async function librarySongGenreTotals(): Promise<GenreTotals[]> {
    const [albums, ownTagged] = await Promise.all([libraryGenreAlbums(), libraryOwnTaggedSongs()]);
    return computeGenreTotals(albums, ownTagged);
}
