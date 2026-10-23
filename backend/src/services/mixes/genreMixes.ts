// The mood and radio cut-offs in this file are the launch values; the record of each is
// services/audio-analyzer-clap/eval/music-switch-2026-10-17/cutoffs.json.
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    getDecadeWhereClause,
    getEffectiveYear,
    getDecadeFromYear,
} from "../../utils/dateFilters";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import {
    ProgrammaticMix,
    albumCoverUrls,
    sampleMix,
    getMixColor,
    getSeededRandom,
    seededShuffle,
    sampleTracks,
    findTracksByGenrePatterns,
    mergeNewById,
    TRACK_LIMIT,
} from "./helpers";

/**
 * Up to 50 tracks per genre, drawn at random from every track with a file in
 * the named genres' Genre table entries.
 */
async function tracksInGenres(genreNames: string[], seed: number) {
    const genres = await prisma.genre.findMany({
        where: { name: { in: genreNames, mode: "insensitive" } },
        select: { id: true },
    });
    if (genres.length === 0) return [];
    return sampleTracks({
        where: {
            ...NOT_MISSING,
            trackGenres: { some: { genreId: { in: genres.map((g) => g.id) } } },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50 * genres.length,
        seed,
    });
}

export async function generateEraMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const albums = await prisma.album.findMany({
        where: { tracks: { some: NOT_MISSING } },
        select: { year: true, originalYear: true, displayYear: true },
    });

    const decades = new Set<number>();
    albums.forEach((album) => {
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

    const tracks = await prisma.track.findMany({
        where: {
            ...NOT_MISSING,
            album: getDecadeWhereClause(selectedDecade),
        },
        include: {
            album: { select: { coverUrl: true } },
        },
    });

    if (tracks.length < 15) return null;

    return sampleMix(
        {
            id: `era-${selectedDecade}-${today}`,
            type: "era",
            name: `Your ${selectedDecade}s Mix`,
            description: `Random picks from the ${selectedDecade}s`,
            colorType: "era",
        },
        tracks,
        TRACK_LIMIT
    );
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

    const trackGenres = await prisma.trackGenre.findMany({
        where: { genreId: selectedGenre.id, track: NOT_MISSING },
        include: {
            track: {
                include: {
                    album: { select: { coverUrl: true } },
                },
            },
        },
    });

    const tracks = trackGenres.map((tg) => tg.track);
    if (tracks.length < 5) return null;

    return sampleMix(
        {
            id: `genre-${selectedGenre.id}-${today}`,
            type: "genre",
            name: `Your ${selectedGenre.name} Mix`,
            description: `Random ${selectedGenre.name} picks`,
            colorType: "genre",
        },
        tracks,
        TRACK_LIMIT
    );
}

export async function generatePartyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const seed = getSeededRandom(`party-${today}`);
    const partyGenres = [
        "dance",
        "electronic",
        "pop",
        "disco",
        "house",
        "techno",
        "edm",
        "funk",
        "electro",
        "dance pop",
        "club",
        "eurodance",
        "trance",
        "dubstep",
        "drum and bass",
        "hip hop",
    ];

    let tracks: any[] = [];

    tracks = await tracksInGenres(partyGenres, seed);
    logger.debug(
        `[PARTY MIX] Found ${tracks.length} tracks from Genre table`
    );

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            partyGenres,
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
        logger.debug(
            `[PARTY MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const audioTracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
                analysisStatus: "completed",
                OR: [
                    { danceability: { gte: 0.7 } },
                    {
                        AND: [
                            { energy: { gte: 0.7 } },
                            { bpm: { gte: 110 } },
                        ],
                    },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 50,
            seed,
        });
        tracks = mergeNewById(tracks, audioTracks);
        logger.debug(
            `[PARTY MIX] After audio analysis fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[PARTY MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

    return {
        id: `party-${today}`,
        type: "dance-floor",
        name: "Party Playlist",
        description: "High energy dance, EDM, and pop hits",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("dance-floor"),
    };
}

export async function generateWorkoutMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const seed = getSeededRandom(`workout-${today}`);
    const workoutGenres = [
        "rock",
        "metal",
        "hard rock",
        "alternative rock",
        "punk",
        "hip hop",
        "rap",
        "trap",
        "hardcore",
        "metalcore",
        "industrial",
        "drum and bass",
        "hardstyle",
        "nu metal",
        "electronic",
        "edm",
        "house",
        "techno",
        "pop punk",
    ];

    let tracks: any[] = [];

    const enhancedTracks = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            analysisMode: "enhanced",
            AND: [
                { arousal: { gte: 0.6 } },
                { energy: { gte: 0.6 } },
                { bpm: { gte: 110 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
        seed,
    });
    tracks = enhancedTracks;
    logger.debug(
        `[WORKOUT MIX] Enhanced mode: Found ${tracks.length} tracks`
    );

    if (tracks.length < 15) {
        logger.debug(`[WORKOUT MIX] Falling back to Standard mode`);
        const audioTracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
                analysisStatus: "completed",
                OR: [
                    {
                        AND: [
                            { energy: { gte: 0.65 } },
                            { bpm: { gte: 115 } },
                        ],
                    },
                    {
                        moodTags: {
                            hasSome: [
                                "workout",
                                "energetic",
                                "upbeat",
                                "powerful",
                            ],
                        },
                    },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
            seed,
        });
        tracks = mergeNewById(tracks, audioTracks);
        logger.debug(
            `[WORKOUT MIX] Standard mode: Total ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const genreTracks = await tracksInGenres(workoutGenres, seed);
        tracks = mergeNewById(tracks, genreTracks);
        logger.debug(
            `[WORKOUT MIX] After Genre table: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            workoutGenres,
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
        logger.debug(
            `[WORKOUT MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[WORKOUT MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

    return {
        id: `workout-${today}`,
        type: "workout",
        name: "Workout Mix",
        description: "High energy tracks to power your workout",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("workout"),
    };
}

export async function generateFocusMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const seed = getSeededRandom(`focus-${today}`);
    const focusGenres = [
        "classical",
        "instrumental",
        "jazz",
        "piano",
        "ambient",
        "post-rock",
        "math rock",
        "soundtrack",
        "score",
        "contemporary classical",
        "minimal",
        "modern classical",
        "neoclassical",
    ];

    let tracks: any[] = [];

    tracks = await tracksInGenres(focusGenres, seed);
    logger.debug(
        `[FOCUS MIX] Found ${tracks.length} tracks from Genre table`
    );

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            focusGenres,
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
        logger.debug(
            `[FOCUS MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const audioTracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
                analysisStatus: "completed",
                instrumentalness: { gte: 0.5 },
                energy: { gte: 0.2, lte: 0.7 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 50,
            seed,
        });
        tracks = mergeNewById(tracks, audioTracks);
        logger.debug(
            `[FOCUS MIX] After audio analysis fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[FOCUS MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

    return {
        id: `focus-${today}`,
        type: "focus-flow",
        name: "Focus Mix",
        description: "Concentration music for deep work",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("focus-flow"),
    };
}
