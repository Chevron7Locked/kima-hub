/**
 * The listens module: every question about what a person has played.
 *
 * A Play row is one recorded play. A listen is what those rows fold into: a row
 * joins the listen in progress while the song could still be playing, measured
 * from where that listen began. Rows further apart than the track's length
 * always split, so the recursive walk only runs inside short bursts.
 *
 * Two meanings are kept apart, each as its first readers had it:
 * - played: raw Play rows, repeats and skips included (`neverPlayedSql`,
 *   `playedMoreThanSql`, `mostPlayedTrackIds`, `playedCounts`, `recentPlayArtists`);
 * - listened: the folded listens (`listenRows`, `listenedMoreThanSql`).
 * Every question is scoped to one listener. Which songs count is the caller's
 * rule (the playable-song rule, usually), passed in or composed in its own SQL.
 */

import { Prisma, type Artist } from "@prisma/client";
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
 * it. `onlyTrackId` can narrow the input because the walk is per track.
 */
export function listenRows(
    userId: string,
    period: Period = "all",
    onlyTrackId?: string,
): Prisma.Sql {
    return Prisma.sql`
        WITH RECURSIVE ordered AS (
            SELECT p.id, p."trackId", p."playedAt", p.source,
                   t.duration, t."albumId", t."trackNo",
                   t.energy, t.valence, t.bpm, t.key, t."keyScale",
                   t.instrumentalness, t."dynamicRange", t.acousticness,
                   GREATEST(t.duration, ${MIN_LISTEN_WINDOW_SECONDS}) AS listen_window,
                   -- A gap wider than the track is long settles the row on its
                   -- own: nothing that far from its predecessor can be the same
                   -- listen, whatever happened before it.
                   coalesce(EXTRACT(EPOCH FROM (p."playedAt" - LAG(p."playedAt")
                       OVER (PARTITION BY p."trackId" ORDER BY p."playedAt", p.id))), 1e9)
                       > GREATEST(t.duration, ${MIN_LISTEN_WINDOW_SECONDS}) AS opens_run
            FROM "Play" p
            JOIN "Track" t ON t.id = p."trackId"
            WHERE p."userId" = ${userId}
              ${onlyTrackId ? Prisma.sql`AND p."trackId" = ${onlyTrackId}` : Prisma.empty}
        ),
        -- Two passes, because Postgres will not let a window function appear
        -- inside another one's PARTITION BY: number the runs first, then
        -- number the rows within a run.
        grouped AS (
            SELECT o.*,
                   sum(CASE WHEN o.opens_run THEN 1 ELSE 0 END)
                       OVER (PARTITION BY o."trackId" ORDER BY o."playedAt", o.id) AS run_id
            FROM ordered o
        ),
        runs AS (
            SELECT g.*,
                   row_number() OVER (PARTITION BY g."trackId", g.run_id
                                      ORDER BY g."playedAt", g.id) AS seq
            FROM grouped g
        ),
        -- Inside a run every row sits within one duration of the row before it,
        -- so which of them open listens depends on the running decision. Walk
        -- it, carrying the timestamp the current listen began at. Depth here is
        -- the longest single burst of rows, not the track's whole history.
        walk AS (
            SELECT r.*, r."playedAt" AS listen_started, TRUE AS starts_listen
            FROM runs r
            WHERE r.seq = 1
          UNION ALL
            SELECT r.*,
                   -- Greater-or-equal: at exactly one duration the track has
                   -- finished, so that row opens a new listen. The recording
                   -- path and the audit draw the line in the same place.
                   CASE WHEN EXTRACT(EPOCH FROM (r."playedAt" - w.listen_started)) >= r.listen_window
                        THEN r."playedAt" ELSE w.listen_started END,
                   EXTRACT(EPOCH FROM (r."playedAt" - w.listen_started)) >= r.listen_window
            FROM runs r
            JOIN walk w ON w."trackId" = r."trackId"
                       AND w.run_id = r.run_id
                       AND r.seq = w.seq + 1
        ),
        p AS (SELECT * FROM walk WHERE starts_listen ${window(period)})`;
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
    return Prisma.sql`SELECT p."trackId" FROM "Play" p WHERE p."userId" = ${userId} GROUP BY p."trackId" HAVING count(*) > ${count}`;
}

/** The ids of songs this listener has listened to more than `count` times, counting listens, not rows. A subquery, as `playedMoreThanSql`. */
export function listenedMoreThanSql(userId: string, count: number): Prisma.Sql {
    return Prisma.sql`${listenRows(userId)} SELECT p."trackId" FROM p GROUP BY p."trackId" HAVING count(*) > ${count}`;
}

/** The ids of this listener's most played songs among those `song` lets through, most played first, counting every Play row. */
export async function mostPlayedTrackIds(
    userId: string,
    args: { song: Prisma.TrackWhereInput; take: number },
): Promise<string[]> {
    const counted = await prisma.play.groupBy({
        by: ["trackId"],
        where: { userId, track: args.song },
        _count: { trackId: true },
        orderBy: { _count: { trackId: "desc" } },
        take: args.take,
    });
    return counted.map((c) => c.trackId);
}

/**
 * This listener's play rows per song among those `song` lets through, most played first and, among equal counts, the song
 * played last first. Every Play row counts, as in `mostPlayedTrackIds`; only songs played at least once appear.
 */
export async function playedCounts(
    userId: string,
    args: { song: Prisma.TrackWhereInput },
): Promise<Array<{ trackId: string; count: number }>> {
    const counted = await prisma.play.groupBy({
        by: ["trackId"],
        where: { userId, track: args.song },
        _count: { trackId: true },
        orderBy: [{ _count: { trackId: "desc" } }, { _max: { playedAt: "desc" } }, { trackId: "asc" }],
    });
    return counted.map((c) => ({ trackId: c.trackId, count: c._count.trackId }));
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
    return plays.map((p) => p.track.album.artist);
}
