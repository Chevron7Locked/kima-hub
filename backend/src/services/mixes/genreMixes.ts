import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    getEffectiveDecadeWhereClause,
    getEffectiveYear,
    getDecadeFromYear,
} from "../../utils/dateFilters";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import { ProgrammaticMix, sampledMix, getSeededRandom, TRACK_LIMIT } from "./helpers";
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

    const decadeArray = Array.from(decades).sort((a, b) => b - a);
    const decadeSeed = getSeededRandom(`era-${today}`);
    const selectedDecade = decadeArray[decadeSeed % decadeArray.length];

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
        where: {
            ...NOT_MISSING,
            album: getEffectiveDecadeWhereClause(selectedDecade),
        },
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

    const genreSeed = getSeededRandom(`genre-${today}`);
    const selectedGenre = validGenres[genreSeed % validGenres.length];

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
        where: {
            ...NOT_MISSING,
            trackGenres: { some: { genreId: selectedGenre.id } },
        },
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
