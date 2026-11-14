/**
 * Listening in numbers. Time is estimated: each play credits its track's
 * length, capped at PLAY_CREDIT_CAP_SECONDS so a long mix counted after a few
 * minutes cannot dominate; the UI labels it "about". `playedAt` is UTC, bucketed
 * into the caller's IANA zone.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { listenRows, withListens, type FoldedListens, type Period } from "./listens";

/** No single play counts for more than ten minutes. See the note above. */
export const PLAY_CREDIT_CAP_SECONDS = 600;

/** The resolution of the taste plot, per axis. 24 x 24 cells. */
const SHAPE_BUCKETS = 24;


export interface ListeningStats {
    plays: number;
    /** Derived, not measured. Always presented as "about". */
    estimatedSeconds: number;
    distinctTracks: number;
    distinctArtists: number;
    distinctAlbums: number;
    firstPlay: string | null;
    lastPlay: string | null;
    /** Where the plays came from: Kima's own player, a Subsonic client, or a song still in Discover (the album's location says so). */
    bySource: Record<string, number>;
    /** [weekday 0=Sunday][hour 0-23] -> play count, in the user's own timezone. */
    clock: number[][];
    /** The loudest single cell of that grid, for labelling. */
    peak: { weekday: number; hour: number; plays: number } | null;
    /** The taste plot: valence on x, energy on y, both bucketed 1..24. */
    shape: Array<{ x: number; y: number; plays: number }>;
    /** How that plot has moved, one point per month. */
    drift: Array<{
        month: string;
        energy: number | null;
        valence: number | null;
        bpm: number | null;
        plays: number;
    }>;
    topArtists: Array<{ id: string; name: string; plays: number; estimatedSeconds: number }>;
    topTracks: Array<{ id: string; title: string; artist: string; plays: number }>;
}

let postgresZones: Promise<Set<string>> | null = null;

/** A time zone Postgres accepts, or UTC: an unknown zone would make the query throw. Postgres's
 * own list decides, not the JavaScript runtime's; the two disagree on a few names. */
export async function safeZone(tz: string | undefined): Promise<string> {
    if (!tz || tz.length > 64) return "UTC";
    postgresZones ??= prisma
        .$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`
        .then((rows) => new Set(rows.map((r) => r.name)))
        .catch((err) => {
            postgresZones = null;
            throw err;
        });
    return (await postgresZones).has(tz) ? tz : "UTC";
}

/** The listening section, read from listens the caller has already folded (see `withListens`). */
export async function listeningStats(
    { fold, db }: FoldedListens,
    timezone?: string,
): Promise<ListeningStats> {
    const tz = await safeZone(timezone);

    const [totals, sources, clockRows, shapeRows, driftRows, artistRows, trackRows] =
        await Promise.all([
            db.$queryRaw<
                Array<{
                    plays: number;
                    est: number;
                    tracks: number;
                    artists: number;
                    albums: number;
                    first_play: Date | null;
                    last_play: Date | null;
                }>
            >(Prisma.sql`${fold}
            SELECT count(*)::int                                    AS plays,
                   coalesce(sum(LEAST(p.duration, ${PLAY_CREDIT_CAP_SECONDS}::int)), 0)::int AS est,
                   count(DISTINCT p."trackId")::int                 AS tracks,
                   count(DISTINCT al."artistId")::int               AS artists,
                   count(DISTINCT p."albumId")::int                 AS albums,
                   min(p."playedAt")                                AS first_play,
                   max(p."playedAt")                                AS last_play
            FROM p
            JOIN "Album" al ON al.id = p."albumId"`),

            db.$queryRaw<Array<{ source: string; n: number }>>(Prisma.sql`${fold}
            SELECT CASE WHEN al.location = 'DISCOVER' THEN 'DISCOVER' ELSE p.source::text END AS source, count(*)::int AS n
            FROM p
            JOIN "Album" al ON al.id = p."albumId"
            GROUP BY 1`),

            db.$queryRaw<Array<{ dow: number; hour: number; n: number }>>(Prisma.sql`${fold}
            SELECT EXTRACT(DOW  FROM p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::int AS dow,
                   EXTRACT(HOUR FROM p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::int AS hour,
                   count(*)::int AS n
            FROM p GROUP BY 1, 2`),

            db.$queryRaw<Array<{ x: number; y: number; n: number }>>(Prisma.sql`${fold}
            -- Clamped, because width_bucket treats the top of the range as
            -- exclusive: a track scoring exactly 1.0 comes back as bucket 25,
            -- outside the grid, and gets drawn past the frame it belongs in.
            -- 158 plays were landing there, which pinned the cloud to the top
            -- edge while the bottom row sat empty.
            SELECT LEAST(${SHAPE_BUCKETS}::int, GREATEST(1,
                     width_bucket(p.valence, 0, 1, ${SHAPE_BUCKETS}::int)))::int AS x,
                   LEAST(${SHAPE_BUCKETS}::int, GREATEST(1,
                     width_bucket(p.energy,  0, 1, ${SHAPE_BUCKETS}::int)))::int AS y,
                   count(*)::int AS n
            FROM p
            WHERE p.valence IS NOT NULL AND p.energy IS NOT NULL
            GROUP BY 1, 2`),

            db.$queryRaw<
                Array<{ month: Date; energy: number | null; valence: number | null; bpm: number | null; n: number }>
            >(Prisma.sql`${fold}
            SELECT date_trunc('month', p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) AS month,
                   avg(p.energy)::float8  AS energy,
                   avg(p.valence)::float8 AS valence,
                   avg(p.bpm)::float8     AS bpm,
                   count(*)::int          AS n
            FROM p GROUP BY 1 ORDER BY 1`),

            db.$queryRaw<Array<{ id: string; name: string; n: number; est: number }>>(Prisma.sql`${fold}
            SELECT ar.id AS id, coalesce(ar."displayName", ar.name) AS name,
                   count(*)::int AS n,
                   coalesce(sum(LEAST(p.duration, ${PLAY_CREDIT_CAP_SECONDS}::int)), 0)::int AS est
            FROM p
            JOIN "Album"  al ON al.id = p."albumId"
            JOIN "Artist" ar ON ar.id = al."artistId"
            GROUP BY 1, 2 ORDER BY n DESC LIMIT 8`),

            db.$queryRaw<Array<{ id: string; title: string; artist: string; n: number }>>(Prisma.sql`${fold}
            SELECT t.id AS id, coalesce(t."displayTitle", t.title)   AS title,
                   coalesce(ar."displayName", ar.name)   AS artist,
                   count(*)::int AS n
            FROM p
            JOIN "Track"  t  ON t.id  = p."trackId"
            JOIN "Album"  al ON al.id = p."albumId"
            JOIN "Artist" ar ON ar.id = al."artistId"
            GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 8`),
        ]);

    const t = totals[0];

    // Seven rows of twenty-four, zero-filled, so the grid always renders whole.
    const clock: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let peak: ListeningStats["peak"] = null;
    for (const row of clockRows) {
        clock[row.dow][row.hour] = row.n;
        if (!peak || row.n > peak.plays) peak = { weekday: row.dow, hour: row.hour, plays: row.n };
    }

    return {
        plays: t?.plays ?? 0,
        estimatedSeconds: t?.est ?? 0,
        distinctTracks: t?.tracks ?? 0,
        distinctArtists: t?.artists ?? 0,
        distinctAlbums: t?.albums ?? 0,
        firstPlay: t?.first_play?.toISOString() ?? null,
        lastPlay: t?.last_play?.toISOString() ?? null,
        bySource: Object.fromEntries(sources.map((s) => [s.source, s.n])),
        clock,
        peak,
        shape: shapeRows.map((r) => ({ x: r.x, y: r.y, plays: r.n })),
        drift: driftRows.map((r) => ({
            month: r.month.toISOString().slice(0, 7),
            energy: r.energy,
            valence: r.valence,
            bpm: r.bpm,
            plays: r.n,
        })),
        topArtists: artistRows.map((r) => ({ id: r.id, name: r.name, plays: r.n, estimatedSeconds: r.est })),
        topTracks: trackRows.map((r) => ({ id: r.id, title: r.title, artist: r.artist, plays: r.n })),
    };
}

/** Listens of one track, counted like the stats page so the player bar agrees with it. */
export async function trackPlayCount(userId: string, trackId: string): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        ${listenRows(userId, "all", trackId)}
        SELECT count(*)::int AS n FROM p`);
    return rows[0]?.n ?? 0;
}

export interface HourDetail {
    weekday: number;
    hour: number;
    listens: number;
    tracks: Array<{ title: string; artist: string; listens: number }>;
    artists: Array<{ name: string; listens: number }>;
    /** The most recent time this hour came round and something played. */
    lastAt: string | null;
}

/** The tracks behind one cell of the week grid, loaded on demand, counted like the grid. */
export async function hourDetail(
    userId: string,
    weekday: number,
    hour: number,
    timezone?: string,
    // Clicking a cell of a filtered grid has to answer for the same window the
    // grid was drawn from, or the cell says 109 and the panel lists twelve.
    period: Period = "all",
): Promise<HourDetail> {
    const tz = await safeZone(timezone);
    const local = Prisma.sql`p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}`;

    const [tracks, artists, total] = await withListens(userId, period, ({ fold, db }) => Promise.all([
        db.$queryRaw<Array<{ title: string; artist: string; n: number }>>(Prisma.sql`
            ${fold}
            SELECT coalesce(t."displayTitle", t.title) AS title,
                   coalesce(ar."displayName", ar.name) AS artist,
                   count(*)::int AS n
            FROM p
            JOIN "Track"  t  ON t.id  = p."trackId"
            JOIN "Album"  al ON al.id = p."albumId"
            JOIN "Artist" ar ON ar.id = al."artistId"
            WHERE EXTRACT(DOW  FROM ${local})::int = ${weekday}
              AND EXTRACT(HOUR FROM ${local})::int = ${hour}
            GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT 6`),

        db.$queryRaw<Array<{ name: string; n: number }>>(Prisma.sql`
            ${fold}
            SELECT coalesce(ar."displayName", ar.name) AS name, count(*)::int AS n
            FROM p
            JOIN "Album"  al ON al.id = p."albumId"
            JOIN "Artist" ar ON ar.id = al."artistId"
            WHERE EXTRACT(DOW  FROM ${local})::int = ${weekday}
              AND EXTRACT(HOUR FROM ${local})::int = ${hour}
            GROUP BY 1 ORDER BY n DESC, 1 LIMIT 4`),

        db.$queryRaw<Array<{ n: number; last_at: Date | null }>>(Prisma.sql`
            ${fold}
            SELECT count(*)::int AS n, max(p."playedAt") AS last_at
            FROM p
            WHERE EXTRACT(DOW  FROM ${local})::int = ${weekday}
              AND EXTRACT(HOUR FROM ${local})::int = ${hour}`),
    ]));

    return {
        weekday,
        hour,
        listens: total[0]?.n ?? 0,
        tracks: tracks.map((t) => ({ title: t.title, artist: t.artist, listens: t.n })),
        artists: artists.map((a) => ({ name: a.name, listens: a.n })),
        lastAt: total[0]?.last_at?.toISOString() ?? null,
    };
}

export interface RegionDetail {
    x: number;
    y: number;
    listens: number;
    tracks: Array<{ title: string; artist: string; listens: number }>;
    /** What the corner of the map actually sounds like, in numbers. */
    energy: number | null;
    valence: number | null;
    bpm: number | null;
}

/** What sits at one point of the taste plot: a small neighbourhood, not just the cell under the pointer. */
export async function regionDetail(
    userId: string,
    x: number,
    y: number,
    radius = 1,
    // Same reason as `hourDetail`: the readout has to describe the same
    // listens the cloud was drawn from.
    period: Period = "all",
): Promise<RegionDetail> {
    const bucket = (v: string) =>
        Prisma.sql`LEAST(${SHAPE_BUCKETS}::int, GREATEST(1, width_bucket(${Prisma.raw(v)}, 0, 1, ${SHAPE_BUCKETS}::int)))`;

    const [tracks, summary] = await withListens(userId, period, ({ fold, db }) => Promise.all([
        db.$queryRaw<Array<{ title: string; artist: string; n: number }>>(Prisma.sql`
            ${fold}
            SELECT coalesce(t."displayTitle", t.title) AS title,
                   coalesce(ar."displayName", ar.name) AS artist,
                   count(*)::int AS n
            FROM p
            JOIN "Track"  t  ON t.id  = p."trackId"
            JOIN "Album"  al ON al.id = p."albumId"
            JOIN "Artist" ar ON ar.id = al."artistId"
            WHERE p.valence IS NOT NULL AND p.energy IS NOT NULL
              AND abs(${bucket("p.valence")} - ${x}) <= ${radius}
              AND abs(${bucket("p.energy")}  - ${y}) <= ${radius}
            GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT 5`),

        db.$queryRaw<Array<{ n: number; energy: number; valence: number; bpm: number }>>(Prisma.sql`
            ${fold}
            SELECT count(*)::int AS n, avg(p.energy)::float8 AS energy,
                   avg(p.valence)::float8 AS valence, avg(p.bpm)::float8 AS bpm
            FROM p
            WHERE p.valence IS NOT NULL AND p.energy IS NOT NULL
              AND abs(${bucket("p.valence")} - ${x}) <= ${radius}
              AND abs(${bucket("p.energy")}  - ${y}) <= ${radius}`),
    ]));

    return {
        x, y,
        listens: summary[0]?.n ?? 0,
        tracks: tracks.map((t) => ({ title: t.title, artist: t.artist, listens: t.n })),
        energy: summary[0]?.energy ?? null,
        valence: summary[0]?.valence ?? null,
        bpm: summary[0]?.bpm ?? null,
    };
}
