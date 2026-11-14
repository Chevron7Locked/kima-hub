/**
 * Metrics that need both the audio analysis of every file and the fact that
 * the user owns the files, which no streaming service has together.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { playableSongSql } from "../../utils/playableSong";
import { withListens, type Period } from "./listens";
import { spellingsOf } from "./playable";
import { safeZone } from "./listening";

/** Two plays closer together than this belong to the same sitting. */
const SESSION_GAP_SECONDS = 900;

export interface Signature {
    /** How few tracks account for how much listening. */
    concentration: { forHalf: number; forEighty: number; distinct: number } | null;
    /** Whether you play records or shuffle. */
    albumHabit: { moves: number; sameAlbumPct: number; inOrderPct: number } | null;
    /** How old the music you play is. */
    era: {
        medianYear: number;
        buckets: Array<{ label: string; plays: number; percent: number }>;
    } | null;
    /** Major or minor, which key most often, and every key's share. */
    key: {
        minorPct: number;
        top: Array<{ key: string; plays: number }>;
        /** Every key played, for the wheel. `key` is the pitch, e.g. "F#". */
        all: Array<{ key: string; scale: "major" | "minor"; plays: number }>;
    } | null;
    /** What sits on the shelf against what actually gets played. */
    ownedVsPlayed: Array<{ label: string; owned: number; played: number; unit: "ratio" | "bpm" }>;
    /** The same, hour by hour, for a curve rather than four bars. */
    hourly: Array<{ hour: number; plays: number; energy: number }>;
}


export async function signature(
    userId: string,
    timezone = "UTC",
    period: Period = "all",
): Promise<Signature> {
    const tz = await safeZone(timezone);

    // The listens are folded once for the six figures that read them; the shelf figures read no plays.
    const [[conc, habit, era, keys, played, hourly], owned] = await Promise.all([
        withListens(userId, period, (fold, db) => Promise.all([
        db.$queryRaw<Array<{ for_half: number; for_eighty: number; distinct: number }>>(Prisma.sql`
            ${fold},
            c AS (SELECT "trackId", count(*)::int n FROM p GROUP BY 1),
            r AS (SELECT n, sum(n) OVER (ORDER BY n DESC, "trackId") running,
                         sum(n) OVER () total,
                         row_number() OVER (ORDER BY n DESC, "trackId") rank FROM c)
            SELECT (SELECT min(rank)::int FROM r WHERE running >= total / 2.0)      AS for_half,
                   (SELECT min(rank)::int FROM r WHERE running >= total * 0.8)      AS for_eighty,
                   (SELECT max(rank)::int FROM r)                                   AS distinct`),

        db.$queryRaw<Array<{ moves: number; same_album: number; in_order: number }>>(Prisma.sql`
            ${fold},
            seq AS (
                SELECT "albumId", "trackNo",
                       LAG("albumId") OVER (ORDER BY "playedAt", id) prev_album,
                       LAG("trackNo")  OVER (ORDER BY "playedAt", id) prev_no,
                       EXTRACT(EPOCH FROM ("playedAt" - LAG("playedAt") OVER (ORDER BY "playedAt", id))) gap
                FROM p)
            SELECT count(*) FILTER (WHERE gap < ${SESSION_GAP_SECONDS})::int AS moves,
                   coalesce(round(100.0 * count(*) FILTER (WHERE gap < ${SESSION_GAP_SECONDS} AND "albumId" = prev_album)
                       / nullif(count(*) FILTER (WHERE gap < ${SESSION_GAP_SECONDS}), 0), 1), 0)::float8 AS same_album,
                   coalesce(round(100.0 * count(*) FILTER (WHERE gap < ${SESSION_GAP_SECONDS} AND "albumId" = prev_album AND "trackNo" = prev_no + 1)
                       / nullif(count(*) FILTER (WHERE gap < ${SESSION_GAP_SECONDS}), 0), 1), 0)::float8 AS in_order
            FROM seq`),

        db.$queryRaw<Array<{ label: string; plays: number; median: number }>>(Prisma.sql`
            ${fold},
            y AS (SELECT coalesce(a."displayYear", a.year) yr FROM p JOIN "Album" a ON a.id = p."albumId"
                  WHERE coalesce(a."displayYear", a.year) IS NOT NULL)
            SELECT CASE WHEN yr >= date_part('year', now()) - 1 THEN 'the last two years'
                        WHEN yr >= 2015 THEN '2015 to ' || (date_part('year', now()) - 2)::int
                        WHEN yr >= 2000 THEN '2000 to 2014'
                        ELSE 'before 2000' END AS label,
                   count(*)::int AS plays,
                   (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY yr) FROM y)::int AS median
            FROM y GROUP BY 1 ORDER BY min(yr) DESC`),

        db.$queryRaw<Array<{ musical_key: string; scale: string; plays: number }>>(Prisma.sql`
            ${fold}
            SELECT key AS musical_key, "keyScale" AS scale, count(*)::int AS plays
            FROM p WHERE key IS NOT NULL AND "keyScale" IS NOT NULL
            GROUP BY 1, 2 ORDER BY plays DESC`),

        db.$queryRaw<Array<{ energy: number; valence: number; bpm: number; inst: number }>>(Prisma.sql`
            ${fold}
            SELECT avg(energy)::float8 AS energy, avg(valence)::float8 AS valence,
                   avg(bpm)::float8 AS bpm, avg(instrumentalness)::float8 AS inst
            FROM p WHERE energy IS NOT NULL`),

        db.$queryRaw<Array<{ hour: number; plays: number; energy: number }>>(Prisma.sql`
            ${fold}
            SELECT EXTRACT(HOUR FROM "playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::int AS hour,
                   count(*)::int AS plays, avg(energy)::float8 AS energy
            FROM p WHERE energy IS NOT NULL GROUP BY 1 ORDER BY 1`),
        ])),
        prisma.$queryRaw<Array<{ energy: number; valence: number; bpm: number; inst: number }>>`
            SELECT avg(t.energy)::float8 AS energy, avg(t.valence)::float8 AS valence,
                   avg(t.bpm)::float8 AS bpm, avg(t.instrumentalness)::float8 AS inst
            FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
            WHERE ${playableSongSql("t", "a")} AND t.energy IS NOT NULL`,
    ]);

    // Fold the two spellings of a pitch together before ranking. Ungrouped,
    // 379 listens written "C#" and any written "Db" are two separate rows, so
    // the most-played key can be reported as neither of them. `minorPct` is a
    // sum and is unaffected either way.
    const folded = new Map<string, { musical_key: string; scale: string; plays: number }>();
    for (const k of keys) {
        const canonical = spellingsOf(k.musical_key)[0];
        const id = `${canonical}|${k.scale}`;
        const row = folded.get(id);
        if (row) row.plays += k.plays;
        else folded.set(id, { musical_key: canonical, scale: k.scale, plays: k.plays });
    }
    const rankedKeys = [...folded.values()].sort((a, b) => b.plays - a.plays);

    const totalKeys = keys.reduce((n, k) => n + k.plays, 0);
    const minor = keys.filter((k) => k.scale === "minor").reduce((n, k) => n + k.plays, 0);
    const eraTotal = era.reduce((n, e) => n + e.plays, 0);
    const lib = owned[0];
    const mine = played[0];

    return {
        concentration: conc[0]?.distinct ? conc[0] && {
            forHalf: conc[0].for_half,
            forEighty: conc[0].for_eighty,
            distinct: conc[0].distinct,
        } : null,
        albumHabit: habit[0]?.moves ? {
            moves: habit[0].moves,
            sameAlbumPct: habit[0].same_album,
            inOrderPct: habit[0].in_order,
        } : null,
        era: eraTotal > 0 ? {
            medianYear: era[0].median,
            buckets: era.map((e) => ({
                label: e.label, plays: e.plays,
                percent: Math.round((e.plays / eraTotal) * 1000) / 10,
            })),
        } : null,
        key: totalKeys > 0 ? {
            minorPct: Math.round((minor / totalKeys) * 1000) / 10,
            top: rankedKeys.slice(0, 5).map((k) => ({ key: `${k.musical_key} ${k.scale}`, plays: k.plays })),
            all: keys.map((k) => ({
                key: k.musical_key,
                scale: k.scale === "minor" ? ("minor" as const) : ("major" as const),
                plays: k.plays,
            })),
        } : null,
        // Aggregates with no GROUP BY return one row even when empty, with every
        // avg() NULL, so check the values, not the rows.
        ownedVsPlayed: [lib?.energy, lib?.valence, lib?.inst, lib?.bpm,
                        mine?.energy, mine?.valence, mine?.inst, mine?.bpm]
            .every((v) => typeof v === "number" && Number.isFinite(v)) ? [
            { label: "energy", owned: lib.energy, played: mine.energy, unit: "ratio" },
            { label: "brightness", owned: lib.valence, played: mine.valence, unit: "ratio" },
            { label: "instrumental", owned: lib.inst, played: mine.inst, unit: "ratio" },
            { label: "bpm", owned: lib.bpm, played: mine.bpm, unit: "bpm" },
        ] : [],
        hourly: hourly.map((h) => ({ hour: h.hour, plays: h.plays, energy: h.energy })),
    };
}
