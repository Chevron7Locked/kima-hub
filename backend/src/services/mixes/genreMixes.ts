import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { getEffectiveYear, getDecadeFromYear } from "../../utils/dateFilters";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import { ProgrammaticMix, sampledMix, getSeededRandom, seededOrder, TRACK_LIMIT } from "./helpers";
import { recipeMixGenerator } from "./recipeMix";

export async function generateEraMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const albumYears = await prisma.album.groupBy({
        by: ["year", "originalYear", "displayYear"],
        where: { tracks: { some: NOT_MISSING } },
    });

    const decades = new Set<number>();
    albumYears.forEach((album) => {
        const effectiveYear = getEffectiveYear(album);
        if (effectiveYear) {
            const decade = getDecadeFromYear(effectiveYear);
            decades.add(decade);
        }
    });

    if (decades.size === 0) return null;

    // Ranked by the day's seed, so a decade appearing or leaving changes the pick only if it is the one picked.
    const selectedDecade = seededOrder([...decades], getSeededRandom(`era-${today}`), String)[0];

    return sampledMix({
        id: `era-${selectedDecade}-${today}`,
        type: "era",
        name: `Your ${selectedDecade}s Mix`,
        description: `Random picks from the ${selectedDecade}s`,
        colorType: "era",
        take: 100,
        minTracks: 15,
        limit: TRACK_LIMIT,
        seed: getSeededRandom(`era-${selectedDecade}-${today}`),
        // The album's year as getEffectiveYear reads it: the display year, then the original year, then the year.
        where: Prisma.sql`COALESCE(a."displayYear", a."originalYear", a.year) >= ${selectedDecade}
                          AND COALESCE(a."displayYear", a."originalYear", a.year) < ${selectedDecade + 10}`,
    });
}

export async function generateGenreMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const genres = await prisma.genre.findMany({
        include: {
            _count: { select: { trackGenres: true } },
        },
        orderBy: {
            trackGenres: { _count: "desc" },
        },
        take: 20,
    });

    logger.debug(`[GENRE MIX] Found ${genres.length} genres total`);
    const validGenres = genres.filter((g) => g._count.trackGenres >= 5);
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
        take: 100,
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
