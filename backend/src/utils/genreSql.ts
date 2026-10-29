/**
 * The genre key (genreKey), the shared genre matching built on it (genreMatchesWanted,
 * artistTaggedWithGenre, libraryArtistIdsForGenre), and the genre list built on getMergedGenres
 * (computeGenreTotals). Matching and totals are computed in TypeScript, never in SQL: a database
 * in the SQL_ASCII encoding can neither normalize nor lower-case beyond ASCII, and the list is
 * one rule every surface shares (the web's GET /genres and Subsonic's getGenres).
 */
import { prisma } from "./db";
import { getMergedGenres } from "./metadataOverrides";

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
 * Whether one genre name answers to a wanted genre key: every spelling of that genre, and genres
 * that contain it ("hip hop" answers "alternative hip-hop"). An empty key (a request made only of spaces and
 * punctuation) is no genre and answers to nothing.
 */
function genreMatchesWanted(name: string, wantedKey: string): boolean {
    return wantedKey !== "" && genreKey(name).includes(wantedKey);
}

/**
 * Whether an artist's genre tags answer to a requested genre. The tags read are getMergedGenres —
 * the ones a person set when they set any, else the enriched ones — the same list the web's genre
 * filters read. The one matching rule, shared by the web and the Subsonic layer, so all surfaces
 * select the same artists for the same genre string.
 */
export function artistTaggedWithGenre(genres: unknown, userGenres: unknown, genreValue: string | null | undefined): boolean {
    const wanted = genreKey(genreValue);
    return wanted !== "" && getMergedGenres({ genres, userGenres }).some((g) => genreMatchesWanted(g, wanted));
}

/**
 * The ids of the artists tagged with a genre, matched by genreKey (the rule above): the database
 * lists the library's artists, the names are compared here. Every surface that filters library
 * music by genre asks this, so none can drift from the others.
 */
export async function libraryArtistIdsForGenre(genreValue: string): Promise<string[]> {
    if (genreKey(genreValue) === "") return [];
    const tagged = await prisma.$queryRaw<{ id: string; genres: unknown; userGenres: unknown }[]>`
        SELECT DISTINCT ar.id, ar.genres, ar."userGenres"
        FROM "Artist" ar
        JOIN "Album" a ON a."artistId" = ar.id
        WHERE a.location = 'LIBRARY' AND (ar.genres IS NOT NULL OR ar."userGenres" IS NOT NULL)
    `;
    return tagged.filter((ar) => artistTaggedWithGenre(ar.genres, ar.userGenres, genreValue)).map((ar) => ar.id);
}

/** One artist's genres for the genre list, with the songs and albums its library music carries. */
export interface GenreCountedArtist {
    /** The artist's name, for dropping its self-name tag. */
    name?: string | null;
    normalizedName?: string | null;
    genres?: unknown;
    userGenres?: unknown;
    /** Library songs this artist has. */
    songs: number;
    /** Library albums this artist has. */
    albums: number;
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
 * The genre list, computed once for every surface that shows one (the web's GET /genres and Subsonic's
 * getGenres). For each artist the genres read are getMergedGenres — the person's tags when they set any,
 * else the enriched ones — so a genre a person added shows and counts like an enriched one, and a genre
 * a person removed counts under neither. Spellings of one
 * genre are one genre (genreKey) listed under the spelling carrying the most songs; each artist is
 * counted once per genre, so an artist tagged "Hip-Hop" AND "hip hop" adds its songs once. A tag equal
 * to the artist's own name (a band named "Jazz" tagged "jazz") is not a genre: it is dropped from
 * that artist only, so the band neither adds nor hides the genre. The one rule the web and the
 * Subsonic layer share; each caller keeps its own output shape and thresholds.
 */
export function computeGenreTotals(artists: GenreCountedArtist[]): GenreTotals[] {
    const songs = new Map<string, number>();
    const albums = new Map<string, number>();
    const spellings = new Map<string, Map<string, number>>();
    for (const artist of artists) {
        const own = new Set([genreKey(artist.name), genreKey(artist.normalizedName)]);
        const seen = new Set<string>();
        for (const name of getMergedGenres(artist)) {
            if (!name || name.startsWith("_")) continue;
            const key = genreKey(name);
            if (!key || own.has(key)) continue;
            // One spelling per artist counted once, as one artist is counted once per genre.
            if (!seen.has(key)) {
                songs.set(key, (songs.get(key) ?? 0) + artist.songs);
                albums.set(key, (albums.get(key) ?? 0) + artist.albums);
            }
            seen.add(key);
            const carried = spellings.get(key) ?? new Map<string, number>();
            if (!spellings.has(key)) spellings.set(key, carried);
            carried.set(name, (carried.get(name) ?? 0) + artist.songs);
        }
    }
    return Array.from(songs.entries()).map(([key, songCount]) => ({
        key,
        name: Array.from(spellings.get(key)!.entries()).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))[0][0],
        songs: songCount,
        albums: albums.get(key) ?? 0,
    }));
}

