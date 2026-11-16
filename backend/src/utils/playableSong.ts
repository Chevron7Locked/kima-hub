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
 * Exactly three exceptions read songs without the rule:
 *
 * 1. Web stream by id, Discover included; corrupt refused: the Discover page plays Discover songs through it. Of the
 *    rule it refuses a missing file and a corrupt one, and asks nothing of the album.
 * 2. Status counters: they count the whole library, missing files included, and show the count (counted and shown,
 *    never silent).
 * 3. Owner lookups by id: a read of the one song a request names, to say who owns it or what it is, never a pick.
 *    Album identification reads the songs of the one album it is identifying in the same way (by album id, never to
 *    offer them): it fingerprints files that are there, corrupt ones included, so it asks only `missingSince: null`.
 *
 * Discover's own song lookups are not a fourth exception. The Discover Weekly playlist builder and GET
 * /discover/current look up the songs of a week's Discover albums, and there PLAYABLE_DISCOVER_SONG is the rule: the
 * same file-there-and-read test, on a DISCOVER album instead of a library one (/current uses PLAYABLE_SONG for a liked
 * suggestion, whose album has moved to the library). No other interface uses it.
 */
import { Prisma } from "@prisma/client";

/** The rule for a Prisma `where` on Track. */
export const PLAYABLE_SONG = { missingSince: null, corrupt: false, album: { location: "LIBRARY" } } as const;

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
    return Prisma.raw(`"${album}".location = 'LIBRARY' AND "${song}".corrupt = false AND "${song}"."missingSince" IS NULL`);
}
