/**
 * The listens module: every question about what a person has played.
 *
 * A Play row is one recorded play. A listen is what those rows fold into: a row
 * joins the listen in progress while the song could still be playing, measured
 * from where that listen began. Rows further apart than the track's length
 * always split, so the recursive walk only runs inside short bursts.
 *
 * Two meanings are kept apart, each as its first readers had it:
 * - played: raw Play rows, repeats and skips included (`playRowsSql`,
 *   `neverPlayedSql`, `playedMoreThanSql`, `playCounts`, `mostPlayedTrackIds`,
 *   `recentPlayArtists`, `playHistoryPages`, `countPlaysBefore`, `hasPlayBetween`, `listenersOf`);
 * - listened: the folded listens (`listenRows`, `listenedMoreThanSql`,
 *   `withListens`, `recentListenArtists`).
 * Two readers keep to the rows the listen rule recorded (`heard`: the mixes' night
 * songs and familiar songs); `playRowsSql` takes that as a choice, and no other
 * reader looks at it.
 * Every question is scoped to one listener, except `albumsPlayedAtLeast`, which
 * asks of albums whoever played them. Which songs count is the caller's rule
 * (the playable-song rule, usually), passed in or composed in its own SQL.
 * The stats page (`libraryOnly`, which `withListens` sets) and the play-history audit (which reports library plays only, though
 * its `playHistoryPages` carry every play, so a Discover play still ends the gap after a library one) leave Discover plays out of
 * their statistics. Every other reader keeps its own meaning.
 * Plays are read only here: no other module reads the Play table (the writes that record, relabel, move or delete rows stay with their owners).
 *
 * Kept plays: a song removed with no copy to take its history leaves its plays (`Play.trackId` null, with the song's
 * title, artist, album, recording and length written on each, and whether its album was a library or a Discover album).
 * Each reader keeps its meaning and counts a kept play wherever it can attribute it:
 * - the stats page (`withListens`) folds kept library plays with the rest, so its plays, listening time, clock, sources,
 *   distinct songs, artists and albums and per-artist counts are what they were before the delete. A kept play's artist and
 *   album are the ones of that name that exist now, else its stored names. What needs the song's audio (the taste plot,
 *   drift, key, era of an album not found, shape) or the song itself (top songs, the songs of an hour or a region) reads
 *   the songs that are there;
 * - `countPlaysBefore` and `playHistoryPages` count every row, kept ones included (the audit sequences a kept play, so it still
 *   ends a gap, but reports and removes library songs only);
 * - every reader that offers, seeds or ranks songs (`playCounts`, `mostPlayedTrackIds`, `recentPlayArtists`,
 *   `recentListenArtists`, `neverPlayedSql`, `playedMoreThanSql`, `listenedMoreThanSql`, `playRowsSql`, `albumsPlayedAtLeast`,
 *   `listenersOf`) reads plays of songs that are there, and so never sees a kept play;
 * - a Discover play is never kept (a Discover song's plays are Discover's, and a kept one stays out of every statistic).
 */

import { Prisma, type Artist, type ListenSource } from "@prisma/client";
import { prisma } from "../../utils/db";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A table alias written in code, checked before it goes into SQL text. */
function alias(name: string, fn: string): Prisma.Sql {
    if (!IDENTIFIER.test(name)) throw new Error(`${fn}: "${name}" is not a table alias`);
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

/**
 * A `WITH RECURSIVE` chain ending in `p`, one row per listen; append the rest
 * of the query (extra CTEs with a leading comma). The date window applies after
 * the walk, or a listen starting before it would look like one starting inside
 * it. `onlyTrackId` can narrow the input because the walk is per track; so can
 * `touchedSince`, which walks only the songs with a row at or after it (each such song
 * is walked whole, so its listens are exact; songs untouched since have no listen after it).
 * `libraryOnly` drops the plays of songs on a Discover album, told by the album's location: the stats page counts
 * those nowhere.
 */
export function listenRows(
    userId: string,
    period: Period = "all",
    onlyTrackId?: string,
    touchedSince?: Date,
    libraryOnly?: true,
): Prisma.Sql {
    // The stats page also reads the plays of songs that left the library with no copy (kept plays): they fold like any
    // other, by the song's recording or, failing that, its stored names, and carry the keys the page counts by.
    const withKept = libraryOnly && !onlyTrackId && !touchedSince;
    const live = Prisma.sql`
            SELECT p.id, p."trackId", p."trackId" AS fkey, p."playedAt", p.source,
                   t.duration, t."albumId", t."trackNo",
                   t.energy, t.valence, t.bpm, t.key, t."keyScale",
                   t.instrumentalness, t."dynamicRange", t.acousticness${libraryOnly
                       ? Prisma.sql`,
                   lib."artistId" AS artist_key, t."albumId" AS album_key, NULL::text AS kept_title, NULL::text AS kept_artist`
                       : Prisma.empty}
            FROM "Play" p
            JOIN "Track" t ON t.id = p."trackId"
            ${libraryOnly ? Prisma.sql`JOIN "Album" lib ON lib.id = t."albumId" AND lib.location = 'LIBRARY'` : Prisma.empty}
            WHERE p."userId" = ${userId}
              ${onlyTrackId ? Prisma.sql`AND p."trackId" = ${onlyTrackId}` : Prisma.empty}
              ${touchedSince
                  ? Prisma.sql`AND p."trackId" IN (SELECT r."trackId" FROM "Play" r WHERE r."userId" = ${userId} AND r."playedAt" >= ${touchedSince})`
                  : Prisma.empty}`;
    // A kept play's artist and album are the ones of that name that exist now, so its listen counts with theirs; with none,
    // the stored names stand in for them. Its audio features are not kept, so only the counts that need none read it.
    const kept = withKept
        ? Prisma.sql`
          UNION ALL
            SELECT p.id, NULL, 'kept:' || coalesce(p."keptRecordingMbid",
                       concat_ws(chr(31), p."keptArtistName", p."keptAlbumTitle", p."keptTitle")),
                   p."playedAt", p.source, p."keptDuration", kb.id, NULL,
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                   coalesce(ka.id, 'kept:' || p."keptArtistName"),
                   coalesce(kb.id, 'kept:' || concat_ws(chr(31), p."keptArtistName", p."keptAlbumTitle")),
                   p."keptTitle", p."keptArtistName"
            FROM "Play" p
            LEFT JOIN LATERAL (SELECT a.id FROM "Artist" a WHERE a.name = p."keptArtistName" ORDER BY a.id LIMIT 1) ka ON TRUE
            LEFT JOIN LATERAL (SELECT b.id FROM "Album" b
                                WHERE b."artistId" = ka.id AND b.title = p."keptAlbumTitle" AND b.location = 'LIBRARY'
                                ORDER BY b.id LIMIT 1) kb ON TRUE
            WHERE p."userId" = ${userId} AND p."trackId" IS NULL AND p."keptLibrary"`
        : Prisma.empty;
    const extra = libraryOnly ? Prisma.sql`, s.artist_key, s.album_key, s.kept_title, s.kept_artist` : Prisma.empty;
    return Prisma.sql`
        WITH RECURSIVE src AS (${live}${kept}
        ),
        ordered AS (
            SELECT s.id, s."trackId", s.fkey, s."playedAt", s.source,
                   s.duration, s."albumId", s."trackNo",
                   s.energy, s.valence, s.bpm, s.key, s."keyScale",
                   s.instrumentalness, s."dynamicRange", s.acousticness${extra},
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
              ${window(period)})`;
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
                Prisma.sql`CREATE TEMP TABLE folded_listens ON COMMIT DROP AS ${listenRows(userId, period, undefined, undefined, true)} SELECT * FROM p`,
            );
            return work({ fold: Prisma.sql`WITH p AS (SELECT * FROM folded_listens)`, db });
        },
        // The fold of a long history takes seconds, and the default five would cut it off.
        { timeout: 120_000, maxWait: 30_000 },
    );
}

/**
 * Ever played: true of a song this listener has no Play row for. A fragment for the song's `WHERE`, the song being the
 * query's `Track` under `song`. As an anti-join, because `plays: { none: {} }` becomes a per-song rescan once Play is
 * too large to hash.
 */
export function neverPlayedSql(userId: string, song = "t"): Prisma.Sql {
    const t = alias(song, "neverPlayedSql");
    return Prisma.sql`NOT EXISTS (SELECT 1 FROM "Play" p WHERE p."trackId" = ${t}.id AND p."userId" = ${userId})`;
}

/**
 * The ids of songs this listener has played more than `count` times, counting every Play row. A subquery to put after
 * `IN` or `NOT IN`; the `NOT IN` form reads the few over-played songs into one hashed list, where counting every song's
 * plays took 2.2 s at 500,000 songs.
 */
export function playedMoreThanSql(userId: string, count: number): Prisma.Sql {
    // A kept play has no song: left in, its null would make every `NOT IN` unknown.
    return Prisma.sql`SELECT p."trackId" FROM "Play" p WHERE p."userId" = ${userId} AND p."trackId" IS NOT NULL GROUP BY p."trackId" HAVING count(*) > ${count}`;
}

/** The ids of songs this listener has listened to more than `count` times, counting listens, not rows. A subquery, as `playedMoreThanSql`. */
export function listenedMoreThanSql(userId: string, count: number): Prisma.Sql {
    return Prisma.sql`${listenRows(userId)} SELECT p."trackId" FROM p GROUP BY p."trackId" HAVING count(*) > ${count}`;
}

/**
 * This listener's Play rows as a subquery to join or select from under an alias (`JOIN (${playRowsSql(id)}) p ON ...`):
 * every column of the row, one per Play row of a song that is there (a kept play has no song). `since` drops rows before it;
 * `heard` keeps the rows the listen rule recorded.
 */
export function playRowsSql(userId: string, args: { since?: Date; heard?: true } = {}): Prisma.Sql {
    return Prisma.sql`SELECT p.* FROM "Play" p WHERE p."userId" = ${userId} AND p."trackId" IS NOT NULL${
        args.since ? Prisma.sql` AND p."playedAt" >= ${args.since}` : Prisma.empty
    }${args.heard ? Prisma.sql` AND p.heard` : Prisma.empty}`;
}

/**
 * Each of this listener's songs among those `song` lets through (all of them, when it is left out) with how many Play rows
 * it has and when it was last played, most played first and then the most recently played. `since` drops plays before it,
 * `sources` keeps only plays from those sources, `take` stops after that many songs.
 */
export async function playCounts(
    userId: string,
    args: { song?: Prisma.TrackWhereInput; since?: Date; sources?: ListenSource[]; take?: number } = {},
): Promise<Array<{ trackId: string; plays: number; lastPlayedAt: Date }>> {
    const counted = await prisma.play.groupBy({
        by: ["trackId"],
        where: {
            userId,
            trackId: { not: null },
            ...(args.song && { track: args.song }),
            ...(args.since && { playedAt: { gte: args.since } }),
            ...(args.sources && { source: { in: args.sources } }),
        },
        _count: { id: true },
        _max: { playedAt: true },
        orderBy: [{ _count: { id: "desc" } }, { _max: { playedAt: "desc" } }, { trackId: "asc" }],
        take: args.take,
    });
    return counted.flatMap((c) => (c.trackId === null ? [] : [{ trackId: c.trackId, plays: c._count.id, lastPlayedAt: c._max.playedAt! }]));
}

/** The ids of this listener's most played songs among those `song` lets through, most played first, counting every Play row. */
export async function mostPlayedTrackIds(
    userId: string,
    args: { song: Prisma.TrackWhereInput; take: number },
): Promise<string[]> {
    return (await playCounts(userId, args)).map((c) => c.trackId);
}

/**
 * The albums among `albumIds` with at least `plays` Play rows over at least `songs` different songs, the rows being
 * anyone's: whether an album was made someone's is not one listener's question.
 */
export async function albumsPlayedAtLeast(
    albumIds: string[],
    args: { plays: number; songs: number },
): Promise<Set<string>> {
    if (albumIds.length === 0) return new Set();
    const rows = await prisma.$queryRaw<{ albumId: string }[]>`
        SELECT t."albumId"
        FROM "Play" p JOIN "Track" t ON t.id = p."trackId"
        WHERE t."albumId" = ANY(${albumIds})
        GROUP BY t."albumId"
        HAVING count(*) >= ${args.plays} AND count(DISTINCT p."trackId") >= ${args.songs}`;
    return new Set(rows.map((r) => r.albumId));
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
 * The artists of this listener's newest listens, one entry per artist, each stamped with when their newest listen began,
 * newest first: `take` artists whenever that many were listened to, however often one of them was. `sources` keeps only
 * listens from those sources. `where` is a condition on the listen's song (`t`), album (`al`) and album artist (`ar`),
 * composed by the caller.
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
    const newest = (touchedSince?: Date) =>
        prisma.$queryRaw<Array<{ artistId: string; lastListenedAt: Date }>>(Prisma.sql`
            ${listenRows(userId, "all", undefined, touchedSince)}
            SELECT al."artistId" AS "artistId", max(p."playedAt") AS "lastListenedAt"
            FROM p
            JOIN "Track" t ON t.id = p."trackId"
            JOIN "Album" al ON al.id = t."albumId"
            JOIN "Artist" ar ON ar.id = al."artistId"
            WHERE TRUE ${sources} ${where}
            GROUP BY al."artistId"
            ORDER BY max(p."playedAt") DESC, al."artistId"
            LIMIT ${args.take}`);
    // Walk only the songs heard lately first: a song untouched since the cutoff has no listen after it, so when `take`
    // artists already came back from after it, nobody outside the walk can beat them. Else walk the whole history.
    const cutoff = new Date(Date.now() - RECENT_LISTEN_DAYS * 86_400_000);
    const lately = await newest(cutoff);
    if (lately.length === args.take && lately.every((r) => r.lastListenedAt >= cutoff)) return lately;
    return newest();
}

/**
 * The artist of each of this listener's plays of songs `song` lets through, newest play first: one entry per Play row, so
 * an artist played often appears often. `since` drops plays before it; `take` stops after that many plays.
 */
export async function recentPlayArtists(
    userId: string,
    args: { song: Prisma.TrackWhereInput; since?: Date; take?: number },
): Promise<Artist[]> {
    const plays = await prisma.play.findMany({
        where: { userId, track: args.song, ...(args.since && { playedAt: { gte: args.since } }) },
        orderBy: { playedAt: "desc" },
        take: args.take,
        select: { track: { select: { album: { select: { artist: true } } } } },
    });
    return plays.flatMap((p) => (p.track ? [p.track.album.artist] : []));
}
