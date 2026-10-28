import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { IN_LIBRARY, NOT_MISSING } from "../../utils/libraryEligibility";
import { ProgrammaticMix, sampledMix, getSeededRandom, seededOrder, TRACK_LIMIT } from "./helpers";
import { recipeMixGenerator } from "./recipeMix";
import { MIN_MIX_TRACKS, artistSql } from "./artistCap";

const ERA_MIN_TRACKS = 15;

/**
 * The decades with enough library songs (ERA_MIN_TRACKS) for a mix, whose artists can fill MIN_MIX_TRACKS at 2 songs
 * each: picking one with too few gave no mix that day, or one artist's songs. A decade is the album's display year, then
 * original year, then year (getEffectiveYear), and artists are counted as the cap counts them (artistSql).
 */
export async function mixableDecades(): Promise<number[]> {
    const reach = await prisma.$queryRaw<{ decade: number; songs: number; capped: number }[]>`
        SELECT decade, sum(n)::int AS songs, sum(least(n, 2))::int AS capped
        FROM (
            SELECT (floor(COALESCE(a."displayYear", a."originalYear", a.year) / 10.0) * 10)::int AS decade,
                   ${artistSql()} AS artist, count(*) AS n
            FROM "Track" t
            JOIN "Album" a ON a.id = t."albumId"
            JOIN "Artist" ar ON ar.id = a."artistId"
            WHERE t."missingSince" IS NULL AND a.location = 'LIBRARY'
              AND COALESCE(a."displayYear", a."originalYear", a.year) IS NOT NULL
              AND COALESCE(a."displayYear", a."originalYear", a.year) <> 0
            GROUP BY 1, 2
        ) per_artist
        GROUP BY decade`;
    return reach
        .filter((d) => d.songs >= ERA_MIN_TRACKS && d.capped >= MIN_MIX_TRACKS)
        .map((d) => d.decade);
}

export async function generateEraMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const decades = await mixableDecades();
    if (decades.length === 0) return null;

    // Ranked by the day's seed, so a decade appearing or leaving changes the pick only if it is the one picked.
    const selectedDecade = seededOrder(decades, getSeededRandom(`era-${today}`), String)[0];

    return sampledMix({
        id: `era-${selectedDecade}-${today}`,
        type: "era",
        name: `Your ${selectedDecade}s Mix`,
        description: `Random picks from the ${selectedDecade}s`,
        colorType: "era",
        minTracks: ERA_MIN_TRACKS,
        limit: TRACK_LIMIT,
        seed: getSeededRandom(`era-${selectedDecade}-${today}`),
        // The album's year as getEffectiveYear reads it: the display year, then the original year, then the year.
        where: Prisma.sql`COALESCE(a."displayYear", a."originalYear", a.year) >= ${selectedDecade}
                          AND COALESCE(a."displayYear", a."originalYear", a.year) < ${selectedDecade + 10}`,
    });
}

/**
 * Of the 20 genres with the most library songs, those with at least 5, whose artists can fill MIN_MIX_TRACKS at 2 songs
 * each (counted as the cap counts them, artistSql), so a genre's mix is not one artist's songs.
 */
export async function mixableGenres(): Promise<{ id: string; name: string }[]> {
    const genres = await prisma.genre.findMany({
        include: {
            _count: { select: { trackGenres: { where: { track: { ...NOT_MISSING, ...IN_LIBRARY } } } } },
        },
        orderBy: {
            trackGenres: { _count: "desc" },
        },
        take: 20,
    });

    logger.debug(`[GENRE MIX] Found ${genres.length} genres total`);
    const reach = genres.length
        ? await prisma.$queryRaw<{ genreId: string; capped: number }[]>`
              SELECT "genreId", sum(least(n, 2))::int AS capped
              FROM (
                  SELECT tg."genreId", ${artistSql()} AS artist, count(*) AS n
                  FROM "TrackGenre" tg
                  JOIN "Track" t ON t.id = tg."trackId"
                  JOIN "Album" a ON a.id = t."albumId"
                  JOIN "Artist" ar ON ar.id = a."artistId"
                  WHERE tg."genreId" IN (${Prisma.join(genres.map((g) => g.id))})
                    AND a.location = 'LIBRARY' AND t."missingSince" IS NULL
                  GROUP BY 1, 2
              ) per_artist
              GROUP BY "genreId"`
        : [];
    const cappedIn = new Map(reach.map((r) => [r.genreId, r.capped]));
    return genres.filter((g) => g._count.trackGenres >= 5 && (cappedIn.get(g.id) ?? 0) >= MIN_MIX_TRACKS);
}

export async function generateGenreMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const validGenres = await mixableGenres();
    logger.debug(
        `[GENRE MIX] ${validGenres.length} genres have >= 5 tracks`
    );
    if (validGenres.length === 0) {
        logger.debug(`[GENRE MIX] FAILED: No genres with enough tracks`);
        return null;
    }

    const selectedGenre = seededOrder(validGenres, getSeededRandom(`genre-${today}`), (g) => g.id)[0];

    return sampledMix({
        id: `genre-${selectedGenre.id}-${today}`,
        type: "genre",
        name: `Your ${selectedGenre.name} Mix`,
        description: `Random ${selectedGenre.name} picks`,
        colorType: "genre",
        minTracks: 5,
        limit: TRACK_LIMIT,
        seed: getSeededRandom(`genre-${selectedGenre.id}-${today}`),
        where: Prisma.sql`EXISTS (SELECT 1 FROM "TrackGenre" tg WHERE tg."trackId" = t.id AND tg."genreId" = ${selectedGenre.id})`,
    });
}

export const generatePartyMix = recipeMixGenerator({
    recipe: "party", id: "party", type: "dance-floor", name: "Party Playlist",
    description: "High energy dance, EDM, and pop hits", colorType: "dance-floor",
});

export const generateWorkoutMix = recipeMixGenerator({
    recipe: "workout", id: "workout", type: "workout", name: "Workout Mix",
    description: "High energy tracks to power your workout", colorType: "workout",
});

export const generateFocusMix = recipeMixGenerator({
    recipe: "focus", id: "focus", type: "focus-flow", name: "Focus Mix",
    description: "Concentration music for deep work", colorType: "focus-flow",
});
