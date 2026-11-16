/**
 * The genre key (genreKey), the one rule for the genres an album shows (shownAlbumGenres), the two filters
 * built on it (libraryAlbumIdsOfGenre: exactly that genre, for Subsonic; libraryAlbumIdsAnsweringToGenre: that genre or
 * one containing it, for the radio stations and the web's search), and the genre list (computeGenreTotals,
 * libraryGenreTotals). An album shows its own merged genres, else its artist's; a song shows its own tags
 * (ownSongGenres, shown through shownSongGenres), else its album's. The filters and the list work by the album's genres
 * only, so a song that shows tags of its own is not found under them and they are not in the list: the two do not agree
 * until the filters and totals read song tags too. Matching and totals are computed in
 * TypeScript, never in SQL: a database in the SQL_ASCII encoding can neither normalize nor lower-case beyond ASCII, and
 * the rule is one every surface shares (Subsonic's genre fields, filters and getGenres, the web's search and the radio
 * stations).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getMergedGenres } from "./metadataOverrides";
import { albumHasPlayableSongSql } from "../services/libraryFilters";
import { playableSongSql } from "./playableSong";

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
 * The genres a song shows: its own tags (the genres of its identified recording, `ownSongGenres`) first, the same tags
 * an album drops being dropped here, else what its album shows (shownAlbumGenres). Own tags carry no order, so they come
 * in name order; the first is the genre it shows.
 */
export function shownSongGenres(own: readonly string[] | undefined, album: GenreAlbum, artist: GenreArtist): string[] {
    const mine = usableGenres([...(own ?? [])], artist);
    return mine.length > 0 ? mine : shownAlbumGenres(album, artist);
}

/** The own genre tags of these songs, by song id, each list in name order; a song with none is not in the map. */
export async function ownSongGenres(trackIds: readonly string[]): Promise<Map<string, string[]>> {
    const byTrack = new Map<string, string[]>();
    if (trackIds.length === 0) return byTrack;
    const rows = await prisma.trackGenre.findMany({
        where: { trackId: { in: [...new Set(trackIds)] } },
        select: { trackId: true, genre: { select: { name: true } } },
    });
    for (const { trackId, genre } of rows) {
        const names = byTrack.get(trackId);
        if (names) names.push(genre.name);
        else byTrack.set(trackId, [genre.name]);
    }
    // Code-unit order, not localeCompare: the same order on every host and locale, so the first tag is the same everywhere.
    for (const names of byTrack.values()) names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return byTrack;
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
 * The ids of the library's albums that show this genre or one containing it ("hip hop" answers "alternative hip-hop"),
 * the broad filter the radio stations and the web's search use to find music near a genre.
 */
export async function libraryAlbumIdsAnsweringToGenre(genreValue: string): Promise<string[]> {
    return libraryAlbumIdsWhere(genreValue, genreAnswersTo);
}

/** One library album for the genre list: its tags, its artist's, and the playable songs it holds. */
export interface GenreCountedAlbum extends GenreAlbum {
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

/**
 * The genre list, computed once for every surface that shows one (Subsonic's getGenres and the radio stations). Each
 * album counts under the genres it shows (shownAlbumGenres), so a genre a person added shows and counts like an enriched
 * one, a genre a person removed counts under neither, and a song counts under its album's genres, the ones its genre field
 * and its filters read. Spellings of one genre are one genre (genreKey) listed under the spelling carrying the most
 * songs; each album is counted once per genre, so an album tagged "Hip-Hop" AND "hip hop" adds its songs once. Each
 * caller keeps its own output shape and thresholds.
 */
export function computeGenreTotals(albums: GenreCountedAlbum[]): GenreTotals[] {
    const songs = new Map<string, number>();
    const counted = new Map<string, number>();
    const spellings = new Map<string, Map<string, number>>();
    for (const album of albums) {
        const seen = new Set<string>();
        for (const name of shownAlbumGenres(album, album.artist)) {
            const key = genreKey(name);
            // One spelling per album counted once, as one album is counted once per genre.
            if (!seen.has(key)) {
                songs.set(key, (songs.get(key) ?? 0) + album.songs);
                counted.set(key, (counted.get(key) ?? 0) + 1);
            }
            seen.add(key);
            const carried = spellings.get(key) ?? new Map<string, number>();
            if (!spellings.has(key)) spellings.set(key, carried);
            carried.set(name, (carried.get(name) ?? 0) + album.songs);
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
export async function libraryGenreAlbums(): Promise<GenreCountedAlbum[]> {
    const rows = await prisma.$queryRaw<
        {
            genres: unknown; userGenres: unknown; name: string; normalizedName: string | null;
            artistGenres: unknown; artistUserGenres: unknown; songs: bigint;
        }[]
    >(Prisma.sql`
        SELECT a.genres, a."userGenres", ar.name, ar."normalizedName",
               ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres", COUNT(t.id)::bigint AS songs
        FROM "Album" a
        JOIN "Artist" ar ON ar.id = a."artistId"
        JOIN "Track" t ON t."albumId" = a.id
        WHERE ${playableSongSql("t", "a")}
          AND (a.genres IS NOT NULL OR a."userGenres" IS NOT NULL OR ar.genres IS NOT NULL OR ar."userGenres" IS NOT NULL)
        GROUP BY a.id, ar.id
    `);
    return rows.map((r) => ({
        genres: r.genres,
        userGenres: r.userGenres,
        artist: { name: r.name, normalizedName: r.normalizedName, genres: r.artistGenres, userGenres: r.artistUserGenres },
        songs: Number(r.songs),
    }));
}

/** The genre list of the library as it plays now: computeGenreTotals over libraryGenreAlbums. */
export async function libraryGenreTotals(): Promise<GenreTotals[]> {
    return computeGenreTotals(await libraryGenreAlbums());
}
