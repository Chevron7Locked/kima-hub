/**
 * Deterministic SQL resolution of a NormalizedVibeQuery into library tracks.
 *
 * No AI in this module: the query is an explicit parameter set
 * (vibeQuery.ts). It is turned into one SQL query over the matching
 * embeddings — same eligibility as the vibe map (current probe, current model,
 * present file) — the feel targets are applied as a distance filter in
 * standardized feel space (z = (x − mean) / sd, mirroring standardisedFeel()
 * in services/matching/rank.ts), and the same per-album / per-artist
 * diversity caps as everywhere else in the app are enforced.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { UserFacingError } from "../../utils/errors";
import { MAX_PER_ALBUM, MAX_PER_ARTIST } from "../matching/formula";
import { loadMatchingState, MATCHING_MODEL, PROBE_ID, type MatchingState } from "../matching/state";
import type { NormalizedVibeQuery } from "./vibeQuery";

export interface ResolvedAiTrack {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    year: number | null;
    feel: { valence: number; arousal: number };
    /**
     * 1.0 at the feel target, decaying gaussian with distance (std-devs);
     * 1.0 for every row when no feel anchor is given.
     */
    score: number;
}

interface RawRow {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    year: number | null;
    valence: number;
    arousal: number;
    score: number;
}

/**
 * Resolve a normalized query into capped, ordered tracks.
 *
 * `state` is accepted so the route (which loads and validates it once) and
 * the tests can share one load; the standalone load happens only when omitted.
 */
export async function resolveVibeQuery(
    query: NormalizedVibeQuery,
    opts: { state?: MatchingState | null; excludeArtistNames?: string[] } = {},
): Promise<ResolvedAiTrack[]> {
    const state = opts.state !== undefined ? opts.state : await loadMatchingState();
    if (!state) {
        throw new UserFacingError(
            "The similarity step has not built the matching state yet; AI playlist generation needs it. Run the similarity step once and retry.",
            400,
            "AI_STATE_MISSING",
        );
    }

    const excludeArtistIds =
        (opts.excludeArtistNames?.length ?? 0) > 0
            ? (
                  await prisma.artist.findMany({
                      where: {
                          OR: (opts.excludeArtistNames ?? []).map((name) => ({
                              name: { equals: name, mode: "insensitive" as const },
                          })),
                      },
                      select: { id: true },
                  })
              ).map((a) => a.id)
            : [];

    const { mean, sd } = state.feel;
    const hasV = query.valenceTarget !== undefined;
    const hasA = query.arousalTarget !== undefined;
    const hasFeel = hasV || hasA;

    // Standardized feel, mirroring rank.ts standardisedFeel(): z = 0 when the
    // axis has no variance, and an unrequested axis contributes nothing.
    const vAxis =
        hasV && sd[0] > 0
            ? Prisma.sql`(((f.valence::float8 - ${mean[0]}::float8) / ${sd[0]}::float8) - ${(query.valenceTarget as number - mean[0]) / sd[0]}::float8)`
            : Prisma.sql`0::float8`;
    const aAxis =
        hasA && sd[1] > 0
            ? Prisma.sql`(((f.arousal::float8 - ${mean[1]}::float8) / ${sd[1]}::float8) - ${(query.arousalTarget as number - mean[1]) / sd[1]}::float8)`
            : Prisma.sql`0::float8`;

    const d2 = hasFeel
        ? Prisma.sql`(${vAxis} * ${vAxis}) + (${aAxis} * ${aAxis})`
        : null;
    const d2Column = d2 ? Prisma.sql`, ${d2} AS d2` : Prisma.sql``;
    const feelFilter = d2
        ? Prisma.sql`AND ${d2} <= ${query.feelTolerance * query.feelTolerance}::float8`
        : Prisma.sql``;
    const scoreExpr = hasFeel ? Prisma.sql`EXP(-c.d2 / 2.0)` : Prisma.sql`1.0::float8`;
    // Order by the score expression itself: `score` is only an alias of the
    // outer SELECT and cannot be referenced through the CTE alias (`c`).
    const orderExpr = hasFeel
        ? Prisma.sql`${scoreExpr} DESC, c.id ASC`
        : Prisma.sql`c."year" DESC NULLS LAST, c.id ASC`;

    // Era bounds. Note: tracks without a release year are excluded whenever an
    // era bound is set (a year is required to compare against one).
    let eraFilter = Prisma.sql``;
    if (query.eraFrom !== undefined && query.eraTo !== undefined) {
        eraFilter = Prisma.sql`AND a."year" >= ${query.eraFrom} AND a."year" <= ${query.eraTo}`;
    } else if (query.eraFrom !== undefined) {
        eraFilter = Prisma.sql`AND a."year" >= ${query.eraFrom}`;
    } else if (query.eraTo !== undefined) {
        eraFilter = Prisma.sql`AND a."year" <= ${query.eraTo}`;
    }

    let includeFilter = Prisma.sql``;
    if (query.genreIncludes.length > 0) {
        includeFilter = Prisma.sql`
            AND EXISTS (
                SELECT 1 FROM "TrackGenre" tg
                JOIN "Genre" g ON g.id = tg."genreId"
                WHERE tg."trackId" = t.id AND lower(g.name) = ANY(${query.genreIncludes}::text[])
            )`;
    }
    let excludeFilter = Prisma.sql``;
    if (query.genreExcludes.length > 0) {
        excludeFilter = Prisma.sql`
            AND NOT EXISTS (
                SELECT 1 FROM "TrackGenre" tg
                JOIN "Genre" g ON g.id = tg."genreId"
                WHERE tg."trackId" = t.id AND lower(g.name) = ANY(${query.genreExcludes}::text[])
            )`;
    }

    const artistFilter =
        excludeArtistIds.length > 0 ? Prisma.sql`AND ar.id <> ALL(${excludeArtistIds})` : Prisma.sql``;

    // Headroom: the diversity caps below skip rows, so ask for more than
    // `length` (capped, so a pathological query cannot pull the whole library).
    const limit = Math.min(query.length * 8, 2000);

    const rows = await prisma.$queryRaw<RawRow[]>`
        WITH cand AS (
            SELECT
                t.id,
                t.title,
                t."duration" AS duration,
                a.id AS "albumId",
                a.title AS "albumTitle",
                a."coverUrl" AS "albumCoverUrl",
                ar.id AS "artistId",
                ar.name AS "artistName",
                a."year" AS "year",
                f.valence::float8 AS valence,
                f.arousal::float8 AS arousal
                ${d2Column}
            FROM track_embeddings te
            JOIN matching_feel f
                ON f.track_id = te.track_id
                AND f.embedded_at = te.analyzed_at
                AND f.probe = ${PROBE_ID}
            JOIN "Track" t ON t.id = te.track_id
            JOIN "Album" a ON a.id = t."albumId"
            JOIN "Artist" ar ON ar.id = a."artistId"
            WHERE te.model_version = ${MATCHING_MODEL}
              AND t."missingSince" IS NULL
              ${eraFilter}
              ${includeFilter}
              ${excludeFilter}
              ${artistFilter}
              ${feelFilter}
        )
        SELECT
            c.id,
            c.title,
            c.duration,
            c."albumId",
            c."albumTitle",
            c."albumCoverUrl",
            c."artistId",
            c."artistName",
            c."year",
            c.valence,
            c.arousal,
            ${scoreExpr} AS score
        FROM cand c
        ORDER BY ${orderExpr}
        LIMIT ${limit}
    `;

    // Per-album / per-artist caps, deterministic: rows are walked in score
    // order (the SQL's order) and a row is taken only when both caps have room.
    const perAlbum = new Map<string, number>();
    const perArtist = new Map<string, number>();
    const result: ResolvedAiTrack[] = [];
    for (const row of rows) {
        if (result.length >= query.length) break;
        const albumCount = perAlbum.get(row.albumId) ?? 0;
        if (albumCount >= MAX_PER_ALBUM) continue;
        const artistCount = perArtist.get(row.artistId) ?? 0;
        if (artistCount >= MAX_PER_ARTIST) continue;
        perAlbum.set(row.albumId, albumCount + 1);
        perArtist.set(row.artistId, artistCount + 1);
        result.push({
            id: row.id,
            title: row.title,
            duration: row.duration,
            albumId: row.albumId,
            albumTitle: row.albumTitle,
            albumCoverUrl: row.albumCoverUrl,
            artistId: row.artistId,
            artistName: row.artistName,
            year: row.year,
            feel: { valence: row.valence, arousal: row.arousal },
            score: row.score,
        });
    }
    return result;
}
