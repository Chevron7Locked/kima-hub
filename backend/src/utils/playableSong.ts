/**
 * The playable-song rule, the one place it is written.
 *
 * A playable song is a song on a library album whose file is there (`missingSince` unset) and was read (not
 * `corrupt`). Every interface that picks, lists, plays or measures songs offers only playable ones, through
 * PLAYABLE_SONG in a Prisma `where` or playableSongSql in raw SQL:
 *
 * - A Discover song lives only in Discover. It plays on the Discover page and nowhere else until a like moves its
 *   album to the library.
 * - A missing file is flagged by the scan, never deleted here. The flag clears when the file returns and the song
 *   comes back to every interface with no extra work; deleting flagged rows is the reconcile step's job.
 * - A corrupt file cannot be read, so it cannot be played.
 *
 * Exactly four exceptions read songs without the rule:
 *
 * 1. Web stream by id, Discover included; corrupt refused: the Discover page plays Discover songs through it. Of the
 *    rule it refuses a missing file and a corrupt one, and asks nothing of the album.
 * 2. Status counters: they count the whole library, missing files included, and show the count (counted and shown,
 *    never silent).
 * 3. Owner lookups by id: a read of the one song a request names, to say who owns it or what it is, never a pick.
 *    Album identification reads the songs of the one album it is identifying in the same way (by album id, never to
 *    offer them): it fingerprints files that are there, corrupt ones included, so it asks only `missingSince: null`.
 * 4. The enrichment offer rule (`ownedSongSql`): a song on a library album with its file there, corrupt ones
 *    included, so a corrupt song's stages are offered again to be retried or closed rather than hidden from the
 *    offer, the pending counts and the one-at-a-time check.
 *
 * A taste read is not an exception either, because it picks no song: Discover seeding, the artist-similar mix and
 * /recommendations count a person's listens of any library song (`librarySong` in stats/listens.ts), missing and
 * corrupt included, since what someone played says what they like whatever the file's state now.
 *
 * Discover's own song lookups are not an exception. The Discover Weekly playlist builder and GET /discover/current
 * look up the songs of a week's Discover albums, and there PLAYABLE_DISCOVER_SONG is the rule: the same
 * file-there-and-read test, on a DISCOVER album instead of a library one (/current uses PLAYABLE_SONG for a liked
 * suggestion, whose album has moved to the library). No other interface uses it.
 *
 * Every export, and why it exists:
 *
 * - PLAYABLE_SONG: the rule as a Prisma `where` piece on Track.
 * - playableSongSql: the rule as a SQL fragment, given the song and album table names the query uses (the album must
 *   be joined). assertSqlName is the one check every name written into raw SQL goes through.
 * - PLAYABLE_DISCOVER_SONG: the rule's file test on a Discover album, for Discover's own song lookups (above).
 * - ownedSongSql: the enrichment offer rule (exception 4), a sibling of the rule. It needs no album join: it looks
 *   the album up itself.
 * - services/libraryFilters.ts builds on the rule for lists of albums and artists, which show only those with a
 *   playable song, so an album or artist whose every file is missing or corrupt is left out until a file returns:
 *   PLAYABLE_ALBUM_WHERE (a library album with a playable song, as a Prisma `where` piece), albumHasPlayableSongSql
 *   and artistHasPlayableSongSql (the album and artist versions as SQL fragments), collectionAlbumWhere with
 *   collectionFilter and yourDiscoverRgMbids (the collection's "show" choice: library albums, this listener's own
 *   current Discover albums, or both).
 * - LIBRARY_LOCATION: the `Album.location` value of an owned album, for the rule and for location checks that are
 *   not the rule. Defined here, where libraryFilters (which builds on the rule) re-exports it.
 * - bestCopyFirst: the order that chooses among copies of one recording, playable first, so the library sweep, the
 *   song-history module and the listens module pick the same copy.
 */
import { Prisma } from "@prisma/client";
import { losslessCodecSql } from "./audioCodec";

/** `Album.location` for owned albums. */
export const LIBRARY_LOCATION = "LIBRARY";

/** The rule for a Prisma `where` on Track. */
export const PLAYABLE_SONG = { missingSince: null, corrupt: false, album: { location: LIBRARY_LOCATION } } as const;

/** Discover's own song lookup (the Discover Weekly playlist builder): the rule's file test, on a Discover album. */
export const PLAYABLE_DISCOVER_SONG = { ...PLAYABLE_SONG, album: { location: "DISCOVER" } } as const;

const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Throws unless `name` is a plain table name or alias. Every name written into raw SQL text goes through this, so the
 * check is one rule; `what` names the caller in the error.
 */
export function assertSqlName(name: string, what: string): void {
    if (!SQL_NAME.test(name)) throw new Error(`${what}: "${name}" is not a table name or alias`);
}

/**
 * The rule for raw SQL, given the names the query uses for the song (`"Track"`) and its album (`"Album"`): an alias
 * such as `t` and `al`, or the table names themselves. The album must be joined in the query.
 */
export function playableSongSql(song: string, album: string): Prisma.Sql {
    assertSqlName(song, "playableSongSql");
    assertSqlName(album, "playableSongSql");
    return Prisma.raw(`"${album}".location = '${LIBRARY_LOCATION}' AND "${song}".corrupt = false AND "${song}"."missingSince" IS NULL`);
}

const OWNED_ALBUM_ALIAS = "owned_album";

/**
 * The enrichment offer's song rule (exception 4 above): the playable-song rule without the corruption test, so a
 * corrupt song stays owed. A Discover song is never owed anything (a like moves its album to the library and it is due
 * from then), and a song whose file is gone is not owed until a scan finds the file.
 *
 * Raw SQL, given the name the query uses for the song's table (`"Track"` or an alias). The album needs no join: the
 * condition looks it up itself.
 */
export function ownedSongSql(song: string): Prisma.Sql {
    assertSqlName(song, "ownedSongSql");
    // The lookup names its subquery `owned_album`; a song of that name would be shadowed by it.
    if (song === OWNED_ALBUM_ALIAS) throw new Error(`"${song}" clashes with an alias ownedSongSql uses inside`);
    return Prisma.raw(
        `"${song}"."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" ${OWNED_ALBUM_ALIAS} WHERE ${OWNED_ALBUM_ALIAS}.id = "${song}"."albumId" AND ${OWNED_ALBUM_ALIAS}.location = '${LIBRARY_LOCATION}')`,
    );
}

/**
 * The order that chooses among copies of one recording, for a query that names the copy `k` and its album `ka`: a playable
 * one, then lossless, then the higher bitrate, then the id. The library sweep and the song-history module choose a
 * successor by it, and the listens module attributes a kept play by it, so all three pick the same copy.
 */
export function bestCopyFirst(): Prisma.Sql {
    return Prisma.sql`(${playableSongSql("k", "ka")}) DESC,
                  (${losslessCodecSql(Prisma.sql`k.mime`)}) DESC,
                  COALESCE(k.bitrate::float8, k."fileSize"::float8 * 8 / 1000 / NULLIF(k.duration, 0)) DESC NULLS LAST,
                  k.id`;
}
