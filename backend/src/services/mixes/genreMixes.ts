import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    getDecadeWhereClause,
    getEffectiveYear,
    getDecadeFromYear,
} from "../../utils/dateFilters";
import {
    ProgrammaticMix,
    getMixColor,
    randomSample,
    getSeededRandom,
    findTracksByGenrePatterns,
} from "./helpers";

const TRACK_LIMIT = 20;

export async function generateEraMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const albums = await prisma.album.findMany({
        where: { tracks: { some: {} } },
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
            album: getDecadeWhereClause(selectedDecade),
        },
        include: {
            album: { select: { coverUrl: true } },
        },
    });

    if (tracks.length < 15) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `era-${selectedDecade}-${today}`,
        type: "era",
        name: `Your ${selectedDecade}s Mix`,
        description: `Random picks from the ${selectedDecade}s`,
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("era"),
    };
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
        where: { genreId: selectedGenre.id },
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

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `genre-${selectedGenre.id}-${today}`,
        type: "genre",
        name: `Your ${selectedGenre.name} Mix`,
        description: `Random ${selectedGenre.name} picks`,
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("genre"),
    };
}

export async function generatePartyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
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

    const genres = await prisma.genre.findMany({
        where: { name: { in: partyGenres, mode: "insensitive" } },
        include: {
            trackGenres: {
                include: {
                    track: {
                        include: { album: { select: { coverUrl: true } } },
                    },
                },
                take: 50,
            },
        },
    });
    tracks = genres.flatMap((g) => g.trackGenres.map((tg) => tg.track));
    logger.debug(
        `[PARTY MIX] Found ${tracks.length} tracks from Genre table`
    );

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            partyGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[PARTY MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const audioTracks = await prisma.track.findMany({
            where: {
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
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...audioTracks.filter((t) => !existingIds.has(t.id)),
        ];
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

    const seed = getSeededRandom(`party-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

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

    const enhancedTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            AND: [
                { arousal: { gte: 0.6 } },
                { energy: { gte: 0.6 } },
                { bpm: { gte: 110 } },
                { moodRelaxed: { lte: 0.4 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = enhancedTracks;
    logger.debug(
        `[WORKOUT MIX] Enhanced mode: Found ${tracks.length} tracks`
    );

    if (tracks.length < 15) {
        logger.debug(`[WORKOUT MIX] Falling back to Standard mode`);
        const audioTracks = await prisma.track.findMany({
            where: {
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
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...audioTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[WORKOUT MIX] Standard mode: Total ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const genres = await prisma.genre.findMany({
            where: { name: { in: workoutGenres, mode: "insensitive" } },
            include: {
                trackGenres: {
                    include: {
                        track: {
                            include: {
                                album: { select: { coverUrl: true } },
                            },
                        },
                    },
                    take: 50,
                },
            },
        });
        const genreTracks = genres.flatMap((g) =>
            g.trackGenres.map((tg) => tg.track)
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...genreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[WORKOUT MIX] After Genre table: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            workoutGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
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

    const seed = getSeededRandom(`workout-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

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

    const genres = await prisma.genre.findMany({
        where: { name: { in: focusGenres, mode: "insensitive" } },
        include: {
            trackGenres: {
                include: {
                    track: {
                        include: { album: { select: { coverUrl: true } } },
                    },
                },
                take: 50,
            },
        },
    });
    tracks = genres.flatMap((g) => g.trackGenres.map((tg) => tg.track));
    logger.debug(
        `[FOCUS MIX] Found ${tracks.length} tracks from Genre table`
    );

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            focusGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[FOCUS MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                instrumentalness: { gte: 0.5 },
                energy: { gte: 0.2, lte: 0.7 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 50,
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...audioTracks.filter((t) => !existingIds.has(t.id)),
        ];
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

    const seed = getSeededRandom(`focus-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

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
