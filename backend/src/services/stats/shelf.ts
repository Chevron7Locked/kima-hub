/**
 * How much of the collection has been played: percentages that can reach 100.
 * "The shelf" is playable songs only; counting Discover candidates would make
 * coverage drop whenever the recommender ran, and a missing or corrupt file
 * could never be played to close the gap. The analysis bar is a status counter
 * and counts every library song.
 */

import { prisma } from "../../utils/db";
import { playableSongSql } from "../../utils/libraryEligibility";
import { playRowsSql } from "./listens";

const PLAYABLE_SQL = playableSongSql("t", "al");

export interface ShelfStats {
    tracks: { total: number; heard: number };
    albums: { total: number; heard: number };
    artists: { total: number; heard: number };
    /** Audio analysis progress — a health metric and a completion bar at once. */
    analysis: { done: number; pending: number; failed: number; total: number };
    /** Tracks on the shelf that have never once been played by this user. */
    neverPlayed: number;
    /** The oldest and newest release years present, for the decade strip. */
    decades: Array<{ decade: number; albums: number; heard: number }>;
}

export async function shelfStats(userId: string): Promise<ShelfStats> {
    const [totals, heard, analysis, decades] = await Promise.all([
        prisma.$queryRaw<Array<{ tracks: number; albums: number; artists: number }>>`
        SELECT count(t.id)::int                      AS tracks,
               count(DISTINCT al.id)::int            AS albums,
               count(DISTINCT al."artistId")::int    AS artists
        FROM "Album" al
        JOIN "Track" t ON t."albumId" = al.id
        WHERE ${PLAYABLE_SQL}`,

        prisma.$queryRaw<Array<{ tracks: number; albums: number; artists: number }>>`
        SELECT count(DISTINCT t.id)::int             AS tracks,
               count(DISTINCT al.id)::int            AS albums,
               count(DISTINCT al."artistId")::int    AS artists
        FROM (${playRowsSql(userId)}) p
        JOIN "Track" t  ON t.id  = p."trackId"
        JOIN "Album" al ON al.id = t."albumId"
        WHERE ${PLAYABLE_SQL}`,

        prisma.$queryRaw<Array<{ status: string; n: number }>>`
        SELECT t."analysisStatus" AS status, count(*)::int AS n
        FROM "Track" t
        JOIN "Album" al ON al.id = t."albumId"
        WHERE al.location = 'LIBRARY'
        GROUP BY 1`,

        prisma.$queryRaw<Array<{ decade: number; albums: number; heard: number }>>`
        SELECT (coalesce(al."displayYear", al.year) / 10 * 10)::int AS decade,
               count(DISTINCT al.id)::int                            AS albums,
               count(DISTINCT al.id) FILTER (WHERE pl.id IS NOT NULL)::int AS heard
        FROM "Album" al
        JOIN "Track" t ON t."albumId" = al.id
        LEFT JOIN (${playRowsSql(userId)}) pl ON pl."trackId" = t.id
        WHERE ${PLAYABLE_SQL} AND coalesce(al."displayYear", al.year) IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    ]);

    const byStatus = Object.fromEntries(analysis.map((a) => [a.status, a.n]));
    // The analyser's statuses: pending, queued, processing, completed, failed,
    // permanently_failed.
    const done = byStatus["completed"] ?? 0;
    const failed = (byStatus["failed"] ?? 0) + (byStatus["permanently_failed"] ?? 0);
    const total = analysis.reduce((sum, a) => sum + a.n, 0);

    return {
        tracks: { total: totals[0]?.tracks ?? 0, heard: heard[0]?.tracks ?? 0 },
        albums: { total: totals[0]?.albums ?? 0, heard: heard[0]?.albums ?? 0 },
        artists: { total: totals[0]?.artists ?? 0, heard: heard[0]?.artists ?? 0 },
        analysis: { done, failed, pending: Math.max(0, total - done - failed), total },
        neverPlayed: Math.max(0, (totals[0]?.tracks ?? 0) - (heard[0]?.tracks ?? 0)),
        decades: decades.filter((d) => d.decade > 1900),
    };
}
