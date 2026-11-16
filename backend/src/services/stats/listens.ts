/**
 * The listens module: every question about what a person has played.
 *
 * A Play row is one recorded play. A listen is what those rows fold into: a row
 * joins the listen in progress while the song could still be playing, measured
 * from where that listen began. Rows further apart than the track's length
 * always split, so the recursive walk only runs inside short bursts.
 *
 * There is one way to count. Every count, and every yes or no "has this person
 * played this", reads listens (`listenRows`, `hasListenedSql`, `neverListenedSql`,
 * `listenedMoreThanSql`, `listenCounts`, `listenedArtists`, `recentListenArtists`,
 * `albumsListenedAtLeast`, `withListens`), of one person's own plays of songs on
 * a library album. A play of a Discover song is in no library count; the one
 * read that wants a Discover song's listens is a single song's (`listenRows`
 * with `trackId`), which reads that song's listens wherever its album is. Which
 * of those songs a reader offers is the caller's rule: what is offered to play
 * passes the playable-song rule, and a taste read (`listenedArtists`,
 * `recentListenArtists`, and the readers that seed from them) counts every
 * library song listened to whatever the state of its file, named `librarySong`.
 * The `heard` flag a play is stored with is recorded by the listen rule and read
 * only by the history audit and repair, never by a count.
 *
 * Kept plays: a song removed with no copy to take its history leaves its plays
 * (`Play.trackId` null, with the song's title, artist, album, recording and
 * length written on each; only a library song's plays are kept, a Discover
 * song's go with it). A kept play counts wherever it can be attributed:
 * - to the present song with its recording id, else with its title, album and
 *   artist names (a library song whose file is there, the best copy when there are
 *   several): it folds with that song's own plays and every count of that song
 *   includes it; when several copies carry the name, the one whose edited title it
 *   carries wins before the better copy that only has that file title;
 * - with no such song, under its stored names (folded as `nameKeySql` folds them,
 *   so spellings of one song are one), in the counts of the stats page and of the
 *   artist readers (an artist or album of that name that the library lists now,
 *   else the stored name). What needs the song's audio (the taste plot, drift, key, shape) or the
 *   song itself (top songs, the songs of an hour or a region) reads the songs
 *   that are there.
 *
 * Three readers stay on raw Play rows, because they are not counts:
 * `hasPlayBetween` (the duplicate-play check), `playHistoryPages` and
 * `countPlaysBefore` (the history audit and repair, which must see every row,
 * kept ones included). `listenersOf` names who has any Play row of a song, to
 * lock that history while the song moves: a row is a listen, so existence needs
 * no fold. `keptRecordings` names who has kept plays, for the song-history
 * module's adoption of them by a returning song.
 * Plays are read only here: no other module reads the Play table (the writes that record, relabel, move or delete rows stay with their owners).
 */

import { Prisma, type Artist, type ListenSource } from "@prisma/client";
import { prisma } from "../../utils/db";
import { assertSqlName, bestCopyFirst, LIBRARY_LOCATION } from "../../utils/playableSong";
import { artistHasPlayableSongSql } from "../libraryFilters";

/**
 * A song on a library album, whatever the state of its file: a condition on the album alias `al`. What a person listened to
 * is a fact about the listening, so the readers that learn a taste from it (Discover seeding, the artist-similar mix,
 * recommendations) pass this where the readers that offer songs to play pass the playable-song rule.
 */
export const librarySong = Prisma.sql`al.location = ${LIBRARY_LOCATION}::"AlbumLocation"`;

/** A table alias written in code, checked before it goes into SQL text. */
function alias(name: string, fn: string): Prisma.Sql {
    assertSqlName(name, fn);
    return Prisma.raw(`"${name}"`);
}

/**
 * The window clause, or nothing at all for "all". The interval text comes from a
 * closed map keyed by a validated `Period`, never from the request, so `Prisma.raw`
 * cannot carry anything a caller supplied.
 */
function window(period: Period): Prisma.Sql {
    if (period === "all") return Prisma.empty;
    return Prisma.sql`AND "playedAt" >= now() - ${Prisma.raw(`interval '${WINDOW[period]}'`)}`;
}

/** The clause that keeps the listens inside the period and, when given, those that began at or after `since`. */
function bounds(period: Period, since?: Date): Prisma.Sql {
    return Prisma.sql`${window(period)}${since ? Prisma.sql` AND "playedAt" >= ${since}` : Prisma.empty}`;
}

/** How far back `recentListenArtists` looks before walking the whole history. */
const RECENT_LISTEN_DAYS = 30;

/** A row closer than this to its listen's start is the same listen. The play-history audit uses it too, so both group alike. */
export const MIN_LISTEN_WINDOW_SECONDS = 30;

/** The windows the page offers. Rolling, so there is no start-of-month cliff. */
export type Period = "30d" | "12mo" | "all";

/** Guard a string off the wire into a `Period`, defaulting to all time. */
export function asPeriod(value: unknown): Period {
    return value === "30d" || value === "12mo" ? value : "all";
}

/** How far back each window reaches, said the way Postgres wants it. */
const WINDOW: Record<Exclude<Period, "all">, string> = {
    "30d": "30 days",
    "12mo": "12 months",
};

/** Which of a person's listens a read covers. */
export interface ListenScope {
    /** The window the listens began in; all time when left out. */
    period?: Period;
    /** Only the listens that began at or after it. The walk is narrowed to the songs touched since, each walked whole, so the listens are exact. */
    since?: Date;
    /** Only this song's listens, the narrowest walk, wherever its album is: a Discover song has listens too, though no library count holds them. */
    trackId?: string;
}

/** Every character from `from` to `to` inclusive, as the characters themselves. */
function codePoints(from: number, to: number): string[] {
    return Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));
}

/**
 * Punctuation, spaces and invisible marks outside ASCII that `unaccent` leaves alone and a C-ctype database's `[:punct:]` cannot see (it
 * knows ASCII only). Listed whole, not as a character set: on a database whose encoding is not UTF8 (SQL_ASCII) every
 * byte is a character, so a set would also take bytes out of other letters, while a whole sequence only matches itself.
 * Full-width letters and digits (U+FF10-FF19, U+FF21-FF3A, U+FF41-FF5A) are letters of their script and stay.
 */
const WIDE_PUNCTUATION_AND_SPACE = [
    "\u00a0", // no-break space
    "\u00b4", // acute accent
    "\u00b7", // middle dot
    "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", // spaces
    "\u200b", "\u200c", "\u200d", // zero-width space, non-joiner, joiner
    "\u200e", "\u200f", // left-to-right and right-to-left marks
    "\u2028", "\u2029", // line and paragraph separators
    "\ufeff", // zero-width no-break space (byte order mark)
    "\u2022", // bullet
    "\u202f", // narrow no-break space
    "\u205f", // medium mathematical space
    "\u3000", // ideographic space
    "\u30fb", // katakana middle dot
    ...codePoints(0x3001, 0x3003), // ideographic comma and full stop, ditto mark
    ...codePoints(0x3008, 0x3011), // CJK angle, double angle, corner, white corner and black lenticular brackets
    ...codePoints(0x3014, 0x301f), // CJK tortoise-shell, white lenticular and other brackets, wave dash, quotation marks
    ...codePoints(0xff01, 0xff0f), // full-width ! to /
    ...codePoints(0xff1a, 0xff20), // full-width : to @
    ...codePoints(0xff3b, 0xff40), // full-width [ to `
    ...codePoints(0xff5b, 0xff65), // full-width { to the half-width ideographic and katakana punctuation
].join("|");

/**
 * `nameKey` (nameFold.ts) as SQL, for a column or expression: trimmed, unaccented, lowercased, with only what is known
 * to be punctuation or space removed. It never drops a letter it cannot classify: a database with a C ctype (the
 * all-in-one image's) cannot tell a letter outside ASCII from a symbol, and a fold that deleted whatever it cannot
 * classify would join names such as "Би-2" and "Ди-2". So a name in another script keeps its letters (and its case, which
 * `lower` cannot fold there), and a punctuation mark it does not list stays: that can only miss a match, never make a
 * false one.
 * A name with nothing left keeps itself, so "!!!" still finds "!!!" rather than every other name made of symbols. The
 * argument is a fixed column expression written in code, never a value (it is exported only so the fold can be checked
 * against `nameKey` on a real database). Decomposed text is composed first (NFC, as `nameKey` does) on a database whose
 * encoding is UTF8, the only one Postgres can compose on; the all-in-one image's is SQL_ASCII, where the fold leaves it
 * decomposed. The branch is Postgres's own answer to `server_encoding`, so one statement is right on either. The argument
 * must be a column or expression of one, not a constant: Postgres evaluates `normalize` of a constant while planning,
 * even in a branch that is not taken.
 */
export function nameKeySql(expr: string): Prisma.Sql {
    const composed = `CASE WHEN current_setting('server_encoding') = 'UTF8' THEN normalize(${expr}, NFC) ELSE ${expr} END`;
    return Prisma.raw(
        `coalesce(nullif(regexp_replace(regexp_replace(lower(unaccent(kima_text_trim(${composed}))), '${WIDE_PUNCTUATION_AND_SPACE}', '', 'g'), '[[:space:][:punct:]]', '', 'g'), ''), ${composed})`,
    );
}

/**
 * The folded edited title and the folded file title of the album or song a table alias names, as a set-returning function
 * to put after `CROSS JOIN LATERAL`, so a kept name is compared with either by a plain equality the planner can hash.
 * Name its columns `(key, ord)`: `ord` is 1 for the edited title (which has no key when there is none) and 2 for the file's.
 */
function shownOrFileTitleKeys(table: "ka" | "k" | "b"): Prisma.Sql {
    return Prisma.sql`unnest(ARRAY[${nameKeySql(`${table}."displayTitle"`)}, ${nameKeySql(`${table}.title`)}]) WITH ORDINALITY`;
}

/**
 * The CTEs that attribute a person's kept plays: each to the one present song it is found by, first by its recording id,
 * else by its title, album and artist names (compared as `nameKey` folds them, so a name that returns in another case,
 * accent or punctuation is still the name), the best copy winning (`bestCopyFirst`), as `kept_resolved` with the
 * kept play's columns and `matched`, that song's id (null when no present song is found). An album or song is named by
 * its edited title or its file's, so a song given an edited title after its plays were kept is still found. A kept play
 * from a Various Artists album is found on an album of that artist like any other, never on a same-titled album of a
 * named artist.
 * Set-based on purpose: the recording id has no index, so each distinct id is looked for in one pass over the songs, and
 * the names are folded once per row of each table, not once per kept play.
 */
function keptCtes(userId: string): Prisma.Sql {
    return Prisma.sql`
        kept_plays AS MATERIALIZED (
            SELECT p.id, p."playedAt", p.source, p."keptTitle", p."keptArtistName", p."keptAlbumTitle",
                   p."keptRecordingMbid", p."keptDuration",
                   ${nameKeySql('p."keptArtistName"')} AS artist_key,
                   ${nameKeySql('p."keptAlbumTitle"')} AS album_key,
                   ${nameKeySql('p."keptTitle"')} AS title_key
            FROM "Play" p
            WHERE p."userId" = ${userId} AND p."trackId" IS NULL AND p."keptTitle" IS NOT NULL
        ),
        kept_by_recording AS (
            SELECT DISTINCT ON (k."recordingMbid") k."recordingMbid", k.id
            FROM "Track" k
            JOIN "Album" ka ON ka.id = k."albumId" AND ka.location = 'LIBRARY'
            WHERE k."missingSince" IS NULL
              AND k."recordingMbid" IN (SELECT kp."keptRecordingMbid" FROM kept_plays kp)
            ORDER BY k."recordingMbid", ${bestCopyFirst()}
        ),
        kept_by_names AS (
            SELECT DISTINCT ON (kp.id) kp.id AS play_id, k.id
            FROM kept_plays kp
            JOIN "Album" ka ON ka.location = 'LIBRARY'
            CROSS JOIN LATERAL ${shownOrFileTitleKeys("ka")} AS ak(key, ord)
            JOIN "Track" k ON k."albumId" = ka.id
            CROSS JOIN LATERAL ${shownOrFileTitleKeys("k")} AS tk(key, ord)
            WHERE ak.key = kp.album_key AND tk.key = kp.title_key
              AND k."missingSince" IS NULL
              AND NOT EXISTS (SELECT 1 FROM kept_by_recording br WHERE br."recordingMbid" = kp."keptRecordingMbid")
              AND EXISTS (SELECT 1 FROM "Artist" a WHERE a.id = ka."artistId" AND ${nameKeySql("a.name")} = kp.artist_key)
            -- The copy carrying the edited title a person gave wins before the better copy that only has that file title:
            -- the kept play names that very song.
            ORDER BY kp.id, tk.ord, ak.ord, ${bestCopyFirst()}
        ),
        -- The artist and album the library lists now under a kept play's names, for a play no present song is found for.
        -- A Discover-only artist is not one. Resolved here once per distinct name rather than once per kept play.
        kept_artist_ids AS (
            SELECT DISTINCT ON (kn.artist_key) kn.artist_key, a.id
            FROM (SELECT DISTINCT artist_key FROM kept_plays) kn
            JOIN "Artist" a ON ${nameKeySql("a.name")} = kn.artist_key
            WHERE ${artistHasPlayableSongSql("a")}
            ORDER BY kn.artist_key, a.id
        ),
        kept_album_ids AS (
            SELECT DISTINCT ON (kn.artist_key, kn.album_key) kn.artist_key, kn.album_key, b.id
            FROM (SELECT DISTINCT artist_key, album_key FROM kept_plays) kn
            JOIN kept_artist_ids kai ON kai.artist_key = kn.artist_key
            JOIN "Album" b ON b."artistId" = kai.id AND b.location = 'LIBRARY'
            CROSS JOIN LATERAL ${shownOrFileTitleKeys("b")} AS bk(key, ord)
            WHERE bk.key = kn.album_key
            ORDER BY kn.artist_key, kn.album_key, b.id
        ),
        kept_resolved AS (
            SELECT kp.*, coalesce(br.id, bn.id) AS matched
            FROM kept_plays kp
            LEFT JOIN kept_by_recording br ON br."recordingMbid" = kp."keptRecordingMbid"
            LEFT JOIN kept_by_names bn ON bn.play_id = kp.id
        )`;
}

/** The ids of the present songs this person's kept plays are attributed to, as a subquery to put after `IN` or `NOT IN`. */
function keptSongsSql(userId: string): Prisma.Sql {
    return Prisma.sql`WITH ${keptCtes(userId)} SELECT kr.matched FROM kept_resolved kr WHERE kr.matched IS NOT NULL`;
}

/**
 * A `WITH RECURSIVE` chain ending in `p`, one row per listen of this person's plays of songs on library albums, kept plays
 * attributed as the header says; append the rest of the query (extra CTEs with a leading comma). The date window applies
 * after the walk, or a listen starting before it would look like one starting inside it. `trackId` can narrow the input
 * because the walk is per song, and then the song's listens are read wherever its album is (a Discover song's included,
 * which no other read holds); so can `since`, which walks only the songs with a row at or after it, then keeps the
 * listens that began at or after it.
 * Every row carries `artist_key`, `album_key`, `kept_title` and `kept_artist`: what the stats page counts artists and albums by.
 */
export function listenRows(userId: string, scope: ListenScope = {}): Prisma.Sql {
    const { period = "all", since, trackId } = scope;
    const touched = since
        ? Prisma.sql`AND (p."trackId" IN (SELECT r."trackId" FROM "Play" r WHERE r."userId" = ${userId} AND r."playedAt" >= ${since})
                     OR p."trackId" IN (SELECT kr.matched FROM kept_resolved kr WHERE kr.matched IS NOT NULL AND kr."playedAt" >= ${since}))`
        : Prisma.empty;
    const live = Prisma.sql`
            SELECT p.id, p."trackId", p."trackId" AS fkey, p."playedAt", p.source,
                   t.duration, t."albumId", t."trackNo",
                   t.energy, t.valence, t.bpm, t.key, t."keyScale",
                   t.instrumentalness, t."dynamicRange", t.acousticness,
                   lib."artistId" AS artist_key, t."albumId" AS album_key, NULL::text AS kept_title, NULL::text AS kept_artist
            FROM "Play" p
            JOIN "Track" t ON t.id = p."trackId"
            JOIN "Album" lib ON lib.id = t."albumId" ${trackId ? Prisma.empty : Prisma.sql`AND lib.location = 'LIBRARY'`}
            WHERE p."userId" = ${userId}
              ${trackId ? Prisma.sql`AND p."trackId" = ${trackId}` : Prisma.empty}
              ${touched}`;
    // A kept play found for a song folds under that song, with its columns.
    const found = Prisma.sql`
          UNION ALL
            SELECT kr.id, mt.id, mt.id, kr."playedAt", kr.source,
                   mt.duration, mt."albumId", mt."trackNo",
                   mt.energy, mt.valence, mt.bpm, mt.key, mt."keyScale",
                   mt.instrumentalness, mt."dynamicRange", mt.acousticness,
                   mal."artistId", mt."albumId", NULL, NULL
            FROM kept_resolved kr
            JOIN "Track" mt ON mt.id = kr.matched
            JOIN "Album" mal ON mal.id = mt."albumId"
            ${trackId ? Prisma.sql`WHERE mt.id = ${trackId}` : Prisma.empty}`;
    // One found for no song keeps its stored names. Its artist and album are the ones of that name that the library lists
    // now (a Discover-only artist is not one), so its listen counts with theirs; with none, the stored names stand in for
    // them. Its audio features are not kept, so only the counts that need none read it. Plays of one song fold together
    // by recording id, else by its names as `nameKeySql` folds them, so a song spelled two ways is one song here as it is
    // when a present song is found for it.
    const lost = trackId
        ? Prisma.empty
        : Prisma.sql`
          UNION ALL
            SELECT kr.id, NULL, 'kept:' || coalesce(kr."keptRecordingMbid",
                       concat_ws(chr(31), kr.artist_key, kr.album_key, kr.title_key)),
                   kr."playedAt", kr.source, kr."keptDuration", kbi.id, NULL,
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   coalesce(kai.id, 'kept:' || kr.artist_key),
                   coalesce(kbi.id, 'kept:' || concat_ws(chr(31), kr.artist_key, kr.album_key)),
                   kr."keptTitle", kr."keptArtistName"
            FROM kept_resolved kr
            LEFT JOIN kept_artist_ids kai ON kai.artist_key = kr.artist_key
            LEFT JOIN kept_album_ids kbi ON kbi.artist_key = kr.artist_key AND kbi.album_key = kr.album_key
            WHERE kr.matched IS NULL`;
    return Prisma.sql`
        WITH RECURSIVE ${keptCtes(userId)},
        src AS (${live}${found}${lost}
        ),
        ordered AS (
            SELECT s.id, s."trackId", s.fkey, s."playedAt", s.source,
                   s.duration, s."albumId", s."trackNo",
                   s.energy, s.valence, s.bpm, s.key, s."keyScale",
                   s.instrumentalness, s."dynamicRange", s.acousticness,
                   s.artist_key, s.album_key, s.kept_title, s.kept_artist,
                   GREATEST(s.duration, ${MIN_LISTEN_WINDOW_SECONDS}) AS listen_window,
                   -- A gap wider than the track is long settles the row on its
                   -- own: nothing that far from its predecessor can be the same
                   -- listen, whatever happened before it.
                   coalesce(EXTRACT(EPOCH FROM (s."playedAt" - LAG(s."playedAt")
                       OVER (PARTITION BY s.fkey ORDER BY s."playedAt", s.id))), 1e9)
                       > GREATEST(s.duration, ${MIN_LISTEN_WINDOW_SECONDS}) AS opens_run
            FROM src s
        ),
        -- Two passes, because Postgres will not let a window function appear
        -- inside another one's PARTITION BY: number the runs first, then
        -- number the rows within a run.
        grouped AS (
            SELECT o.*,
                   sum(CASE WHEN o.opens_run THEN 1 ELSE 0 END)
                       OVER (PARTITION BY o.fkey ORDER BY o."playedAt", o.id) AS run_id
            FROM ordered o
        ),
        runs AS (
            SELECT g.*,
                   row_number() OVER (PARTITION BY g.fkey, g.run_id
                                      ORDER BY g."playedAt", g.id) AS seq,
                   count(*) OVER (PARTITION BY g.fkey, g.run_id) AS run_len
            FROM grouped g
        ),
        -- Only a run of two or more rows has anything to decide: a lone row is
        -- its own listen. Walking just these, and only the few columns the walk
        -- reads, keeps the recursion small. Postgres re-sorts the recursive
        -- term's input at every level, so a wide table of every play made the
        -- cost grow faster than the history did.
        bursts AS MATERIALIZED (
            SELECT r.id, r.fkey, r.run_id, r.seq, r."playedAt", r.listen_window
            FROM runs r
            WHERE r.run_len > 1
        ),
        -- Inside a run every row sits within one duration of the row before it,
        -- so which of them open listens depends on the running decision. Walk
        -- it, carrying the timestamp the current listen began at. Depth here is
        -- the longest single burst of rows, not the track's whole history.
        walk AS (
            SELECT b.id, b.fkey, b.run_id, b.seq, b."playedAt" AS listen_started, TRUE AS starts_listen
            FROM bursts b
            WHERE b.seq = 1
          UNION ALL
            SELECT b.id, b.fkey, b.run_id, b.seq,
                   -- Greater-or-equal: at exactly one duration the track has
                   -- finished, so that row opens a new listen. The recording
                   -- path and the audit draw the line in the same place.
                   CASE WHEN EXTRACT(EPOCH FROM (b."playedAt" - w.listen_started)) >= b.listen_window
                        THEN b."playedAt" ELSE w.listen_started END,
                   EXTRACT(EPOCH FROM (b."playedAt" - w.listen_started)) >= b.listen_window
            FROM bursts b
            JOIN walk w ON w.fkey = b.fkey
                       AND w.run_id = b.run_id
                       AND b.seq = w.seq + 1
        ),
        p AS (SELECT r.* FROM runs r
              WHERE (r.run_len = 1 OR r.id IN (SELECT w.id FROM walk w WHERE w.starts_listen))
              ${bounds(period, since)})`;
}

/** The plays of one listener and period, folded into listens once, as a request reads them. */
export interface FoldedListens {
    /** A `listenRows`-shaped prefix over the folded table: it ends in `p`, and extra CTEs follow with a leading comma. */
    fold: Prisma.Sql;
    /** The connection the folded table is on, so every query that reads `fold` must run through it. */
    db: Prisma.TransactionClient;
}

/**
 * Fold the plays once and read the listens as often as `work` likes. Only songs on library albums are folded, since a
 * Discover play is in no statistic. A page that shows several figures from the same listens would otherwise run the whole recursive fold once per figure, all at the same time, each holding a
 * connection. The fold lands in a temporary table that lives until the transaction ends. One request folds once: a
 * request with several sections calls this once and hands the result to each.
 */
export async function withListens<T>(
    userId: string,
    period: Period,
    work: (listens: FoldedListens) => Promise<T>,
): Promise<T> {
    return prisma.$transaction(
        async (db) => {
            await db.$executeRaw(
                Prisma.sql`CREATE TEMP TABLE folded_listens ON COMMIT DROP AS ${listenRows(userId, { period })} SELECT * FROM p`,
            );
            return work({ fold: Prisma.sql`WITH p AS (SELECT * FROM folded_listens)`, db });
        },
        // The fold of a long history takes seconds, and the default five would cut it off.
        { timeout: 120_000, maxWait: 30_000 },
    );
}

/**
 * Has listened: true of a song this listener has listened to, a fragment for the song's `WHERE`, the song being the query's
 * `Track` under `song`. A song on a Discover album has no listens. Any Play row of the song is a listen and a kept play
 * attributed to it is one, so no fold is needed to tell. An `EXISTS` and an `IN`, because `plays: { some: {} }` becomes a
 * per-song rescan once Play is too large to hash.
 */
export function hasListenedSql(userId: string, song = "t"): Prisma.Sql {
    const t = alias(song, "hasListenedSql");
    return Prisma.sql`(EXISTS (${listenedOnceSql(userId, t)}) OR ${t}.id IN (${keptSongsSql(userId)}))`;
}

/** Never listened to: the opposite of `hasListenedSql`, as an anti-join. */
export function neverListenedSql(userId: string, song = "t"): Prisma.Sql {
    const t = alias(song, "neverListenedSql");
    return Prisma.sql`(NOT EXISTS (${listenedOnceSql(userId, t)}) AND ${t}.id NOT IN (${keptSongsSql(userId)}))`;
}

/** A row for each Play of the song `t` by this listener, when the song is on a library album. */
function listenedOnceSql(userId: string, t: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`SELECT 1 FROM "Play" lp JOIN "Album" lal ON lal.id = ${t}."albumId" AND lal.location = 'LIBRARY'
                      WHERE lp."trackId" = ${t}.id AND lp."userId" = ${userId}`;
}

/**
 * The ids of songs this listener has listened to more than `count` times. A subquery to put after `IN` or `NOT IN`; the
 * `NOT IN` form reads the few over-listened songs into one hashed list, where counting every song's listens took 2.2 s at
 * 500,000 songs.
 */
export function listenedMoreThanSql(userId: string, count: number): Prisma.Sql {
    // A kept play found for no song has no song id: left in, its null would make every `NOT IN` unknown.
    return Prisma.sql`${listenRows(userId)} SELECT p."trackId" FROM p WHERE p."trackId" IS NOT NULL GROUP BY p."trackId" HAVING count(*) > ${count}`;
}

/**
 * Each of this listener's songs among those `song` lets through with how many listens it has and when the newest began,
 * most listened first and then the most recently. `song` is a condition on the song (`t`) and its album (`al`): the
 * caller's rule, the playable-song rule usually, and required because what a count offers is never decided here.
 * `since` keeps the listens that began at or after it, `sources` keeps only listens from those sources, `take` stops after
 * that many songs.
 */
export async function listenCounts(
    userId: string,
    args: { song: Prisma.Sql; since?: Date; sources?: ListenSource[]; take?: number },
): Promise<Array<{ trackId: string; listens: number; lastListenedAt: Date }>> {
    const sources = args.sources ? Prisma.sql`AND p.source = ANY(${args.sources}::"ListenSource"[])` : Prisma.empty;
    const take = args.take === undefined ? Prisma.empty : Prisma.sql`LIMIT ${args.take}`;
    return prisma.$queryRaw<Array<{ trackId: string; listens: number; lastListenedAt: Date }>>(Prisma.sql`
        ${listenRows(userId, { since: args.since })}
        SELECT p."trackId" AS "trackId", count(*)::int AS listens, max(p."playedAt") AS "lastListenedAt"
        FROM p
        JOIN "Track" t ON t.id = p."trackId"
        JOIN "Album" al ON al.id = t."albumId"
        WHERE (${args.song}) ${sources}
        GROUP BY p."trackId"
        ORDER BY count(*) DESC, max(p."playedAt") DESC, p."trackId"
        ${take}`);
}

/**
 * The album artist of each of this listener's listens of library songs, newest listen first: one entry per listen, so an
 * artist listened to often appears often. It is a taste read, so every listen counts whatever the state of the song's file
 * (the playable-song rule is for what is offered to play, not for what was listened to), and a kept play whose song is gone
 * counts toward the library artist of its name; one whose artist the library does not list reads no artist. `since` keeps
 * the listens that began at or after it; `take` stops after that many listens.
 */
export async function listenedArtists(
    userId: string,
    args: { since?: Date; take?: number } = {},
): Promise<Artist[]> {
    const take = args.take === undefined ? Prisma.empty : Prisma.sql`LIMIT ${args.take}`;
    const rows = await prisma.$queryRaw<Array<{ artistId: string }>>(Prisma.sql`
        ${listenRows(userId, { since: args.since })}
        SELECT p.artist_key AS "artistId"
        FROM p
        JOIN "Artist" ar ON ar.id = p.artist_key
        ORDER BY p."playedAt" DESC, p.id
        ${take}`);
    if (rows.length === 0) return [];
    const artists = await prisma.artist.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.artistId))] } } });
    const byId = new Map(artists.map((a) => [a.id, a]));
    return rows.flatMap((r) => {
        const artist = byId.get(r.artistId);
        return artist ? [artist] : [];
    });
}

/**
 * The albums among `albumIds` that some listener has listened to at least `listens` times over at least `songs` different
 * songs. One listener's listens, not a tally of everyone's: an album is not made someone's by several people each listening
 * once.
 */
export async function albumsListenedAtLeast(
    albumIds: string[],
    args: { listens: number; songs: number },
): Promise<Set<string>> {
    if (albumIds.length === 0) return new Set();
    // A listener with a kept play can have a listen on any album its song is now on, so each is folded.
    const listeners = await prisma.$queryRaw<Array<{ userId: string }>>`
        SELECT p."userId" FROM "Play" p JOIN "Track" t ON t.id = p."trackId" WHERE t."albumId" = ANY(${albumIds})
        UNION
        SELECT p."userId" FROM "Play" p WHERE p."trackId" IS NULL AND p."keptTitle" IS NOT NULL`;
    const kept = new Set<string>();
    for (const { userId } of listeners) {
        const rows = await prisma.$queryRaw<Array<{ albumId: string }>>(Prisma.sql`
            ${listenRows(userId)}
            SELECT p.album_key AS "albumId"
            FROM p
            WHERE p.album_key = ANY(${albumIds})
            GROUP BY p.album_key
            HAVING count(*) >= ${args.listens} AND count(DISTINCT p.fkey) >= ${args.songs}`);
        for (const r of rows) kept.add(r.albumId);
    }
    return kept;
}

/** How many Play rows `playHistoryPages` reads at a time. */
export const PLAY_HISTORY_PAGE_SIZE = 5000;

/** The song of a play: its title, length and artist. */
interface PlayedSong {
    title: string;
    displayTitle: string | null;
    duration: number;
    album: { artist: { name: string; displayName: string | null } };
}

/**
 * One Play row of the history. A library play has its song; any other (a Discover play, or a kept play, whose song is
 * gone) is there to be sequenced only, so its song may be missing.
 */
export type PlayHistoryRow = {
    id: string;
    playedAt: Date;
    heard: boolean;
} & (
    | { /** The song is on a library album, told by the album's location. */ library: true; trackId: string; track: PlayedSong }
    | { library: false; trackId: string | null; track: PlayedSong | null }
);

/** The rows of one page: strictly after `after` in (playedAt, id) order, at most `take` of them. */
async function playHistoryPage(
    db: Prisma.TransactionClient,
    userId: string,
    after: { playedAt: Date; id: string } | null,
    take: number,
): Promise<PlayHistoryRow[]> {
    const rows = await db.play.findMany({
        where: {
            userId,
            ...(after
                ? { OR: [{ playedAt: { gt: after.playedAt } }, { playedAt: after.playedAt, id: { gt: after.id } }] }
                : {}),
        },
        orderBy: [{ playedAt: "asc" }, { id: "asc" }],
        take,
        select: {
            id: true,
            trackId: true,
            playedAt: true,
            heard: true,
            track: {
                select: {
                    title: true,
                    displayTitle: true,
                    duration: true,
                    album: { select: { location: true, artist: { select: { name: true, displayName: true } } } },
                },
            },
        },
    });
    return rows.map((row): PlayHistoryRow => {
        const { track: song, trackId, ...play } = row;
        // A kept play has no song, and is not reported: the audit sequences it only.
        if (!song || trackId === null) return { ...play, library: false, trackId: null, track: null };
        const { album: { location, artist }, ...track } = song;
        const shaped = { ...track, album: { artist } };
        return location === "LIBRARY"
            ? { ...play, library: true, trackId, track: shaped }
            : { ...play, library: false, trackId, track: shaped };
    });
}

/**
 * Every Play row of this listener's, oldest first (the row id breaks a tie), a page at a time: for the audit that looks for
 * skips, which must see the whole history but never hold it. Pages are cut by keyset on (playedAt, id), so a page costs
 * the same however deep it is, and each starts strictly after the last row of the one before. Nothing calls it on a page
 * load. `library` says whether the song is on a library album: the audit sequences every play but reports, collapses and
 * removes library plays only. `db` is the transaction to read through, when the caller holds one.
 */
export async function* playHistoryPages(
    userId: string,
    options: { db?: Prisma.TransactionClient; pageSize?: number } = {},
): AsyncGenerator<PlayHistoryRow[]> {
    const db = options.db ?? prisma;
    const take = options.pageSize ?? PLAY_HISTORY_PAGE_SIZE;
    let after: { playedAt: Date; id: string } | null = null;
    for (;;) {
        const page: PlayHistoryRow[] = await playHistoryPage(db, userId, after, take);
        if (page.length === 0) return;
        yield page;
        if (page.length < take) return;
        const last: PlayHistoryRow = page[page.length - 1];
        after = { playedAt: last.playedAt, id: last.id };
    }
}

/** How many Play rows this listener has from before `moment`. */
export function countPlaysBefore(userId: string, moment: Date): Promise<number> {
    return prisma.play.count({ where: { userId, playedAt: { lt: moment } } });
}

/**
 * Whether this listener has a Play row of the song strictly between `after` and `before`: on a bound is outside, because
 * exactly one duration away the song has finished. Reads through `db`, so a transaction holding the dedupe lock sees its own.
 */
export async function hasPlayBetween(
    db: Prisma.TransactionClient,
    args: { userId: string; trackId: string; after: Date; before: Date },
): Promise<boolean> {
    const found = await db.play.findFirst({
        where: { userId: args.userId, trackId: args.trackId, playedAt: { gt: args.after, lt: args.before } },
        select: { id: true },
    });
    return found !== null;
}

/**
 * Who has played each of these songs: one entry per listener and song with a Play row, ordered by listener and then
 * song. Anyone's plays, as the question is about the songs, not one listener. Reads through `db`, so a transaction
 * holding the songs' rows sees its own. The ids go in as one array parameter, so a list of any length is one statement
 * (a statement takes at most 32767 bind parameters).
 */
export async function listenersOf(
    db: Prisma.TransactionClient,
    trackIds: string[],
): Promise<Array<{ trackId: string; userId: string }>> {
    if (trackIds.length === 0) return [];
    return db.$queryRaw<Array<{ trackId: string; userId: string }>>`
        SELECT DISTINCT "trackId", "userId" FROM "Play"
         WHERE "trackId" = ANY(${trackIds}::text[])
         ORDER BY "userId", "trackId"`;
}

/**
 * Who has kept plays, and of which recordings (MusicBrainz recording ids): the plays of songs that left the library with
 * no copy and have not attached to a song again, one entry per listener and recording. `mbids` narrows it to those
 * recordings; left out, every one.
 */
export async function keptRecordings(
    db: Prisma.TransactionClient | typeof prisma,
    mbids?: string[],
): Promise<Array<{ userId: string; recordingMbid: string }>> {
    if (mbids && mbids.length === 0) return [];
    return db.$queryRaw<Array<{ userId: string; recordingMbid: string }>>`
        SELECT DISTINCT "userId", "keptRecordingMbid" AS "recordingMbid" FROM "Play"
         WHERE "trackId" IS NULL AND "keptTitle" IS NOT NULL AND "keptRecordingMbid" IS NOT NULL
           ${mbids ? Prisma.sql`AND "keptRecordingMbid" = ANY(${mbids}::text[])` : Prisma.empty}`;
}

/**
 * The artists of this listener's newest listens, one entry per artist, each stamped with when their newest listen began,
 * newest first: `take` artists whenever that many were listened to, however often one of them was. `sources` keeps only
 * listens from those sources. `where` is a condition on the album artist (`ar`), composed by the caller. A kept play whose
 * song is gone counts toward the library artist of its name, as in `listenedArtists`.
 */
export async function recentListenArtists(
    userId: string,
    args: { take: number; sources?: ListenSource[]; where?: Prisma.Sql },
): Promise<Array<{ artistId: string; lastListenedAt: Date }>> {
    if (!Number.isInteger(args.take) || args.take < 1) {
        throw new Error(`recentListenArtists: take must be a whole number above 0, got ${args.take}`);
    }
    const sources = args.sources ? Prisma.sql`AND p.source = ANY(${args.sources}::"ListenSource"[])` : Prisma.empty;
    const where = args.where ? Prisma.sql`AND (${args.where})` : Prisma.empty;
    const newest = (since?: Date) =>
        prisma.$queryRaw<Array<{ artistId: string; lastListenedAt: Date }>>(Prisma.sql`
            ${listenRows(userId, { since })}
            SELECT ar.id AS "artistId", max(p."playedAt") AS "lastListenedAt"
            FROM p
            JOIN "Artist" ar ON ar.id = p.artist_key
            WHERE TRUE ${sources} ${where}
            GROUP BY ar.id
            ORDER BY max(p."playedAt") DESC, ar.id
            LIMIT ${args.take}`);
    // Walk only the songs heard lately first: a song untouched since the cutoff has no listen after it, so when `take`
    // artists already came back from after it, nobody outside the walk can beat them. Else walk the whole history.
    const cutoff = new Date(Date.now() - RECENT_LISTEN_DAYS * 86_400_000);
    const lately = await newest(cutoff);
    if (lately.length === args.take) return lately;
    return newest();
}
