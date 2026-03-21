import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    ProgrammaticMix,
    getMixColor,
    randomSample,
    getSeededRandom,
    findTracksByGenrePatterns,
} from "./helpers";

const TRACK_LIMIT = 20;
const MIN_TRACKS_DAILY = 8;
const MIN_TRACKS_WEEKLY = 15;
const DAILY_TRACK_LIMIT = 10;
const WEEKLY_TRACK_LIMIT = 20;

export async function generateChillMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            AND: [
                { moodRelaxed: { gte: 0.5 } },
                { moodAggressive: { lte: 0.3 } },
                { energy: { lte: 0.55 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    logger.debug(`[CHILL MIX] Enhanced mode: Found ${tracks.length} tracks`);

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(`[CHILL MIX] Falling back to Standard mode`);
        tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    { energy: { lte: 0.55 } },
                    { bpm: { lte: 115 } },
                    {
                        OR: [
                            { arousal: { lte: 0.55 } },
                            { acousticness: { gte: 0.3 } },
                            { valence: { lte: 0.65 } },
                        ],
                    },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        logger.debug(
            `[CHILL MIX] Standard mode: Found ${tracks.length} tracks`
        );
    }

    logger.debug(
        `[CHILL MIX] Total: ${tracks.length} tracks matching criteria`
    );

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(
            `[CHILL MIX] FAILED: Only ${tracks.length} tracks (need ${MIN_TRACKS_DAILY})`
        );
        return null;
    }

    const seed = getSeededRandom(`chill-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const isWeekly = tracks.length >= MIN_TRACKS_WEEKLY;
    const trackLimit = isWeekly ? WEEKLY_TRACK_LIMIT : DAILY_TRACK_LIMIT;
    const selectedTracks = shuffled.slice(0, trackLimit);

    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `chill-${today}`,
        type: "chill",
        name: "Chill Mix",
        description: "Relax and unwind with mellow vibes",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("chill"),
    };
}

export async function generateHighEnergyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            energy: { gte: 0.7 },
            bpm: { gte: 120 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[HIGH ENERGY MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const energyGenres = [
            "rock",
            "metal",
            "punk",
            "electronic",
            "edm",
            "dance",
            "hip hop",
            "trap",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            energyGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[HIGH ENERGY MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[HIGH ENERGY MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`high-energy-${today}`);
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
        id: `high-energy-${today}`,
        type: "workout",
        name: "High Energy",
        description: "Fast-paced tracks to get you moving",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("workout"),
    };
}

export async function generateLateNightMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            AND: [
                { moodRelaxed: { gte: 0.5 } },
                { moodAggressive: { lte: 0.4 } },
                { energy: { lte: 0.5 } },
                { bpm: { lte: 110 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    logger.debug(
        `[LATE NIGHT MIX] Enhanced mode: Found ${tracks.length} tracks`
    );

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(`[LATE NIGHT MIX] Falling back to Standard mode`);
        tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    { energy: { lte: 0.45 } },
                    { bpm: { lte: 110 } },
                    {
                        OR: [
                            { arousal: { lte: 0.5 } },
                            { valence: { lte: 0.6 } },
                            { acousticness: { gte: 0.3 } },
                        ],
                    },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        logger.debug(
            `[LATE NIGHT MIX] Standard mode: Found ${tracks.length} tracks`
        );
    }

    logger.debug(
        `[LATE NIGHT MIX] Total: ${tracks.length} tracks matching criteria`
    );

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(
            `[LATE NIGHT MIX] FAILED: Only ${tracks.length} tracks (need ${MIN_TRACKS_DAILY})`
        );
        return null;
    }

    const seed = getSeededRandom(`late-night-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const isWeekly = tracks.length >= MIN_TRACKS_WEEKLY;
    const trackLimit = isWeekly ? WEEKLY_TRACK_LIMIT : DAILY_TRACK_LIMIT;
    const selectedTracks = shuffled.slice(0, trackLimit);

    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `late-night-${today}`,
        type: "late-night",
        name: "Late Night",
        description: "Mellow vibes for the quiet hours",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("late-night"),
    };
}

export async function generateHappyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const enhancedTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            moodHappy: { gte: 0.6 },
            moodSad: { lte: 0.3 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = enhancedTracks;
    logger.debug(`[HAPPY MIX] Enhanced mode: Found ${tracks.length} tracks`);

    if (tracks.length < 15) {
        const standardTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                valence: { gte: 0.6 },
                energy: { gte: 0.5 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...standardTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[HAPPY MIX] After Standard fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const happyGenres = [
            "pop",
            "funk",
            "disco",
            "soul",
            "reggae",
            "ska",
            "motown",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            happyGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[HAPPY MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[HAPPY MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`happy-${today}`);
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
        id: `happy-${today}`,
        type: "happy",
        name: "Happy Vibes",
        description: "Feel-good tracks to brighten your day",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("happy"),
    };
}

export async function generateMelancholyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const enhancedTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            moodSad: { gte: 0.5 },
            moodHappy: { lte: 0.4 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 150,
    });
    logger.debug(
        `[MELANCHOLY MIX] Enhanced mode: Found ${enhancedTracks.length} tracks`
    );

    if (enhancedTracks.length >= 15) {
        tracks = enhancedTracks;
    } else {
        logger.debug(`[MELANCHOLY MIX] Falling back to Standard mode`);
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                valence: { lte: 0.35 },
                energy: { lte: 0.6 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 150,
        });
        logger.debug(
            `[MELANCHOLY MIX] Standard mode: Found ${audioTracks.length} low-valence tracks`
        );

        tracks = audioTracks.filter((t) => {
            const hasMinorKey = t.keyScale === "minor";
            const hasSadTags = t.moodTags?.some((tag: string) =>
                [
                    "sad",
                    "melancholic",
                    "melancholy",
                    "moody",
                    "atmospheric",
                ].includes(tag.toLowerCase())
            );
            const hasLastfmSadTags = t.lastfmTags?.some((tag: string) =>
                [
                    "sad",
                    "melancholic",
                    "melancholy",
                    "depressing",
                    "emotional",
                    "heartbreak",
                ].includes(tag.toLowerCase())
            );
            return hasMinorKey || hasSadTags || hasLastfmSadTags;
        });
        logger.debug(
            `[MELANCHOLY MIX] After tag filter: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const sadGenres = [
            "blues",
            "soul",
            "ballad",
            "singer-songwriter",
            "slowcore",
            "sadcore",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            sadGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[MELANCHOLY MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[MELANCHOLY MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const sortedTracks = tracks.sort((a, b) => {
        const aScore =
            (a.valence || 0.5) * 2 +
            (a.energy || 0.5) +
            (a.keyScale === "minor" ? 0 : 0.3);
        const bScore =
            (b.valence || 0.5) * 2 +
            (b.energy || 0.5) +
            (b.keyScale === "minor" ? 0 : 0.3);
        return aScore - bScore;
    });

    const seed = getSeededRandom(`melancholy-${today}`);
    let random = seed;
    const shuffled = sortedTracks.slice(0, 50).sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `melancholy-${today}`,
        type: "melancholy",
        name: "Melancholy",
        description: "Introspective tracks for reflective moments",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("melancholy"),
    };
}

export async function generateDanceFloorMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            danceability: { gte: 0.7 },
            bpm: { gte: 110, lte: 140 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[DANCE FLOOR MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const danceGenres = [
            "dance",
            "electronic",
            "edm",
            "house",
            "disco",
            "techno",
            "pop",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            danceGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[DANCE FLOOR MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[DANCE FLOOR MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`dance-floor-${today}`);
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
        id: `dance-floor-${today}`,
        type: "dance-floor",
        name: "Dance Floor",
        description: "High danceability tracks with perfect tempo",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("dance-floor"),
    };
}

export async function generateAcousticMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            acousticness: { gte: 0.6 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[ACOUSTIC MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const acousticGenres = [
            "acoustic",
            "folk",
            "singer-songwriter",
            "unplugged",
            "indie folk",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            acousticGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[ACOUSTIC MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[ACOUSTIC MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`acoustic-${today}`);
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
        id: `acoustic-${today}`,
        type: "acoustic",
        name: "Acoustic Afternoon",
        description: "Stripped-down, organic sounds",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("acoustic"),
    };
}

export async function generateInstrumentalMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            instrumentalness: { gte: 0.7 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[INSTRUMENTAL MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const instrumentalGenres = [
            "instrumental",
            "classical",
            "soundtrack",
            "score",
            "ambient",
            "post-rock",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            instrumentalGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[INSTRUMENTAL MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[INSTRUMENTAL MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`instrumental-${today}`);
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
        id: `instrumental-${today}`,
        type: "instrumental",
        name: "Instrumental Focus",
        description: "No vocals, pure concentration",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("instrumental"),
    };
}

export async function generateMoodTagMix(
    _userId: string,
    today: string,
    moodTag: string,
    mixName: string,
    mixDescription: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            lastfmTags: {
                has: moodTag,
            },
        },
        include: {
            album: { select: { coverUrl: true } },
        },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const seed = getSeededRandom(`mood-${moodTag}-${today}`);
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
        id: `mood-${moodTag}-${today}`,
        type: `mood-${moodTag}`,
        name: mixName,
        description: mixDescription,
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("mood"),
    };
}

export async function generateRoadTripMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const taggedTracks = await prisma.track.findMany({
        where: {
            OR: [
                {
                    lastfmTags: {
                        hasSome: [
                            "driving",
                            "road trip",
                            "travel",
                            "summer",
                        ],
                    },
                },
                { moodTags: { hasSome: ["energetic", "upbeat", "happy"] } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = taggedTracks;
    logger.debug(`[ROAD TRIP MIX] Found ${tracks.length} tracks from tags`);

    if (tracks.length < 15) {
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                energy: { gte: 0.5, lte: 0.8 },
                bpm: { gte: 100, lte: 130 },
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
            `[ROAD TRIP MIX] After audio fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const roadTripGenres = [
            "rock",
            "pop",
            "indie",
            "alternative",
            "classic rock",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            roadTripGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[ROAD TRIP MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[ROAD TRIP MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`road-trip-${today}`);
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
        id: `road-trip-${today}`,
        type: "road-trip",
        name: "Road Trip",
        description: "Perfect soundtrack for the open road",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("road-trip"),
    };
}

// CURATED VIBE MIXES (Daily, 10 tracks)

export async function generateSadGirlSundays(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 0) return null;

    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { lte: 0.35 } },
                        { keyScale: "minor" },
                    ],
                },
                {
                    AND: [
                        { valence: { lte: 0.3 } },
                        { arousal: { lte: 0.4 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "sad",
                            "melancholic",
                            "heartbreak",
                            "emotional",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `sad-girl-sundays-${today}`,
        type: "sad-girl-sundays",
        name: "Sad Girl Sundays",
        description: "Melancholic introspection and feelings",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("sad-girl-sundays"),
    };
}

export async function generateMainCharacterEnergy(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.55 } },
                        { energy: { gte: 0.55 } },
                        { danceability: { gte: 0.5 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "empowering",
                            "confident",
                            "uplifting",
                            "anthemic",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `main-character-${today}`,
        type: "main-character",
        name: "Main Character Energy",
        description: "You're the protagonist today",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("main-character"),
    };
}

export async function generateVillainEra(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [{ keyScale: "minor" }, { energy: { gte: 0.65 } }],
                },
                {
                    moodTags: {
                        hasSome: ["aggressive", "dark", "intense"],
                    },
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "dark",
                            "aggressive",
                            "intense",
                            "powerful",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `villain-era-${today}`,
        type: "villain-era",
        name: "Villain Era",
        description: "Embrace your dark side",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("villain-era"),
    };
}

export async function generate3AMThoughts(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { arousal: { lte: 0.4 } },
                { energy: { lte: 0.5 } },
                { bpm: { lte: 110 } },
                {
                    OR: [
                        { valence: { lte: 0.5 } },
                        { acousticness: { gte: 0.3 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < MIN_TRACKS_DAILY) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `3am-thoughts-${today}`,
        type: "3am-thoughts",
        name: "3AM Thoughts",
        description: "Late night overthinking companion",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("3am-thoughts"),
    };
}

export async function generateHotGirlWalk(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { danceability: { gte: 0.65 } },
                        { bpm: { gte: 95, lte: 135 } },
                        { energy: { gte: 0.55 } },
                    ],
                },
                {
                    AND: [
                        { valence: { gte: 0.6 } },
                        { energy: { gte: 0.6 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `hot-girl-walk-${today}`,
        type: "hot-girl-walk",
        name: "Hot Girl Walk",
        description: "Confidence boost for your walk",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("confidence-boost"),
    };
}

export async function generateRageCleaning(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { energy: { gte: 0.75 } },
                        { arousal: { gte: 0.65 } },
                        { bpm: { gte: 125 } },
                    ],
                },
                {
                    AND: [
                        { energy: { gte: 0.8 } },
                        { danceability: { gte: 0.6 } },
                    ],
                },
                {
                    moodTags: { hasSome: ["aggressive", "energetic"] },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `rage-cleaning-${today}`,
        type: "rage-cleaning",
        name: "Rage Cleaning",
        description: "Aggressive productivity fuel",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("workout"),
    };
}

export async function generateGoldenHour(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.45 } },
                        { acousticness: { gte: 0.35 } },
                        { energy: { gte: 0.25, lte: 0.65 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: ["warm", "sunset", "dreamy", "peaceful"],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `golden-hour-${today}`,
        type: "golden-hour",
        name: "Golden Hour",
        description: "Warm sunset vibes",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("golden-hour"),
    };
}

export async function generateShowerKaraoke(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { instrumentalness: { lte: 0.35 } },
                { energy: { gte: 0.55 } },
                { valence: { gte: 0.45 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `shower-karaoke-${today}`,
        type: "shower-karaoke",
        name: "Shower Karaoke",
        description: "Belters you can't help but sing",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("happy"),
    };
}

export async function generateInMyFeelings(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { lte: 0.4 } },
                        { arousal: { lte: 0.55 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "emotional",
                            "heartbreak",
                            "feelings",
                            "vulnerable",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `in-my-feelings-${today}`,
        type: "in-my-feelings",
        name: "In My Feelings",
        description: "Let it all out",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("heartbreak-hotel"),
    };
}

export async function generateMidnightDrive(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { energy: { gte: 0.3, lte: 0.65 } },
                { bpm: { gte: 80, lte: 130 } },
                {
                    OR: [
                        { arousal: { lte: 0.6 } },
                        { valence: { gte: 0.3, lte: 0.7 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < MIN_TRACKS_DAILY) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `midnight-drive-${today}`,
        type: "midnight-drive",
        name: "Midnight Drive",
        description: "Perfect for late night cruising",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("night-drive"),
    };
}

export async function generateCoffeeShopVibes(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { energy: { lte: 0.55 } },
                { bpm: { lte: 120 } },
                {
                    OR: [
                        { acousticness: { gte: 0.35 } },
                        { instrumentalness: { gte: 0.25 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < MIN_TRACKS_DAILY) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `coffee-shop-${today}`,
        type: "coffee-shop",
        name: "Coffee Shop Vibes",
        description: "Cozy background music",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("coffee-shop"),
    };
}

export async function generateRomanticizeYourLife(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.35, lte: 0.75 } },
                        { arousal: { gte: 0.25, lte: 0.65 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "dreamy",
                            "aesthetic",
                            "cinematic",
                            "romantic",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `romanticize-${today}`,
        type: "romanticize",
        name: "Romanticize Your Life",
        description: "Make every moment aesthetic",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("golden-hour"),
    };
}

export async function generateThatGirlEra(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { valence: { gte: 0.55 } },
                { energy: { gte: 0.45 } },
                { danceability: { gte: 0.45 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `that-girl-era-${today}`,
        type: "that-girl-era",
        name: "That Girl Era",
        description: "Self-improvement mode activated",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("confidence-boost"),
    };
}

export async function generateUnhinged(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                { energy: { gte: 0.85 } },
                { energy: { lte: 0.15 } },
                { valence: { gte: 0.9 } },
                { valence: { lte: 0.1 } },
                { bpm: { gte: 160 } },
                { bpm: { lte: 70 } },
                { danceability: { gte: 0.9 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `unhinged-${today}`,
        type: "unhinged",
        name: "Unhinged",
        description: "Embrace the chaos",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("dance-floor"),
    };
}

// WEEKLY CURATED MIXES (20 tracks)

export async function generateDeepCuts(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            plays: {
                none: {},
            },
        },
        include: {
            album: {
                select: {
                    coverUrl: true,
                    artist: { select: { id: true } },
                },
            },
        },
        take: 200,
    });

    if (tracks.length < 15) {
        const lowPlayTracks = await prisma.track.findMany({
            include: {
                album: { select: { coverUrl: true } },
                _count: { select: { plays: true } },
            },
            take: 200,
        });

        const filtered = lowPlayTracks
            .filter((t) => t._count.plays <= 3)
            .map((t) => ({ ...t, album: t.album }));

        if (filtered.length < 15) return null;

        const shuffled = randomSample(filtered, WEEKLY_TRACK_LIMIT);
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `deep-cuts-${today}`,
            type: "deep-cuts",
            name: "Deep Cuts",
            description: "Hidden gems waiting to be discovered",
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("rediscover"),
        };
    }

    const shuffled = randomSample(tracks, WEEKLY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `deep-cuts-${today}`,
        type: "deep-cuts",
        name: "Deep Cuts",
        description: "Hidden gems waiting to be discovered",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("rediscover"),
    };
}

export async function generateKeyJourney(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const keyOrder = [
        "C",
        "G",
        "D",
        "A",
        "E",
        "B",
        "F#",
        "Db",
        "Ab",
        "Eb",
        "Bb",
        "F",
    ];

    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            key: { not: null },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 200,
    });

    if (tracks.length < 15) return null;

    const byKey = new Map<string, typeof tracks>();
    for (const track of tracks) {
        const key = track.key || "C";
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(track);
    }

    const journey: typeof tracks = [];
    const seed = getSeededRandom(`key-journey-${today}`);
    let seedVal = seed;

    for (const key of keyOrder) {
        const keyTracks = byKey.get(key) || [];
        if (keyTracks.length > 0 && journey.length < WEEKLY_TRACK_LIMIT) {
            const count = Math.min(
                2,
                keyTracks.length,
                WEEKLY_TRACK_LIMIT - journey.length
            );
            seedVal = (seedVal * 9301 + 49297) % 233280;
            const shuffled = keyTracks.sort(() => {
                seedVal = (seedVal * 9301 + 49297) % 233280;
                return seedVal / 233280 - 0.5;
            });
            journey.push(...shuffled.slice(0, count));
        }
    }

    if (journey.length < 15) return null;

    const coverUrls = journey
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `key-journey-${today}`,
        type: "key-journey",
        name: "Key Journey",
        description: "Harmonic progression through your library",
        trackIds: journey.map((t) => t.id),
        coverUrls,
        trackCount: journey.length,
        color: getMixColor("instrumental"),
    };
}

export async function generateTempoFlow(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            bpm: { not: null },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 200,
    });

    if (tracks.length < 15) return null;

    const sorted = [...tracks].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));

    const slow = sorted.filter((t) => (t.bpm || 0) < 100);
    const medium = sorted.filter(
        (t) => (t.bpm || 0) >= 100 && (t.bpm || 0) < 130
    );
    const fast = sorted.filter((t) => (t.bpm || 0) >= 130);

    const flow: typeof tracks = [];

    flow.push(...randomSample(slow, Math.min(4, slow.length)));
    flow.push(...randomSample(medium, Math.min(5, medium.length)));
    flow.push(...randomSample(fast, Math.min(6, fast.length)));
    flow.push(
        ...randomSample(
            medium.filter((t) => !flow.includes(t)),
            Math.min(3, medium.length)
        )
    );
    flow.push(
        ...randomSample(
            slow.filter((t) => !flow.includes(t)),
            Math.min(2, slow.length)
        )
    );

    if (flow.length < 15) return null;

    const coverUrls = flow
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `tempo-flow-${today}`,
        type: "tempo-flow",
        name: "Tempo Flow",
        description: "An energy journey through BPM",
        trackIds: flow.slice(0, WEEKLY_TRACK_LIMIT).map((t) => t.id),
        coverUrls,
        trackCount: Math.min(flow.length, WEEKLY_TRACK_LIMIT),
        color: getMixColor("workout"),
    };
}

export async function generateVocalDetox(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            instrumentalness: { gte: 0.75 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const shuffled = randomSample(tracks, WEEKLY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `vocal-detox-${today}`,
        type: "vocal-detox",
        name: "Vocal Detox",
        description: "Pure instrumental escape",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("instrumental"),
    };
}

export async function generateMinorKeyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 1) return null;

    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            keyScale: "minor",
            energy: { gte: 0.45 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const shuffled = randomSample(tracks, WEEKLY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `minor-key-${today}`,
        type: "melancholy",
        name: "Minor Key Mondays",
        description: "All minor key bangers",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("melancholy"),
    };
}

export type MoodOnDemandParams = {
    valence?: { min?: number; max?: number };
    energy?: { min?: number; max?: number };
    danceability?: { min?: number; max?: number };
    acousticness?: { min?: number; max?: number };
    instrumentalness?: { min?: number; max?: number };
    arousal?: { min?: number; max?: number };
    bpm?: { min?: number; max?: number };
    keyScale?: "major" | "minor";
    moodHappy?: { min?: number; max?: number };
    moodSad?: { min?: number; max?: number };
    moodRelaxed?: { min?: number; max?: number };
    moodAggressive?: { min?: number; max?: number };
    moodParty?: { min?: number; max?: number };
    moodAcoustic?: { min?: number; max?: number };
    moodElectronic?: { min?: number; max?: number };
    limit?: number;
};

export async function generateMoodOnDemand(
    _userId: string,
    params: MoodOnDemandParams
): Promise<ProgrammaticMix | null> {
    const where: any = {
        analysisStatus: "completed",
    };

    const mlMoodParams = [
        "moodHappy",
        "moodSad",
        "moodRelaxed",
        "moodAggressive",
        "moodParty",
        "moodAcoustic",
        "moodElectronic",
    ];
    const usesMLMoods = mlMoodParams.some(
        (key) => params[key as keyof typeof params] !== undefined
    );

    let useEnhancedMode = false;
    if (usesMLMoods) {
        const enhancedCount = await prisma.track.count({
            where: {
                analysisStatus: "completed",
                analysisMode: "enhanced",
            },
        });

        if (enhancedCount >= 15) {
            where.analysisMode = "enhanced";
            useEnhancedMode = true;
        } else {
            logger.debug(
                `[MoodMixer] Only ${enhancedCount} enhanced tracks, falling back to basic features`
            );

            if (params.moodHappy) {
                where.valence = where.valence || {};
                if (params.moodHappy.min !== undefined)
                    where.valence.gte = Math.max(
                        where.valence.gte || 0,
                        params.moodHappy.min
                    );
            }
            if (params.moodSad) {
                where.valence = where.valence || {};
                if (params.moodSad.min !== undefined)
                    where.valence.lte = Math.min(
                        where.valence.lte || 1,
                        1 - params.moodSad.min
                    );
            }
            if (params.moodRelaxed) {
                where.energy = where.energy || {};
                if (params.moodRelaxed.min !== undefined)
                    where.energy.lte = Math.min(
                        where.energy.lte || 1,
                        1 - params.moodRelaxed.min * 0.5
                    );
            }
            if (params.moodAggressive) {
                where.energy = where.energy || {};
                if (params.moodAggressive.min !== undefined)
                    where.energy.gte = Math.max(
                        where.energy.gte || 0,
                        params.moodAggressive.min
                    );
            }
            if (params.moodParty) {
                where.danceability = where.danceability || {};
                if (params.moodParty.min !== undefined)
                    where.danceability.gte = Math.max(
                        where.danceability.gte || 0,
                        params.moodParty.min
                    );
            }
            delete params.moodHappy;
            delete params.moodSad;
            delete params.moodRelaxed;
            delete params.moodAggressive;
            delete params.moodParty;
            delete params.moodAcoustic;
            delete params.moodElectronic;
        }
    }

    if (params.valence) {
        where.valence = where.valence || {};
        if (params.valence.min !== undefined)
            where.valence.gte = Math.max(
                where.valence.gte || 0,
                params.valence.min
            );
        if (params.valence.max !== undefined)
            where.valence.lte = Math.min(
                where.valence.lte ?? 1,
                params.valence.max
            );
    }
    if (params.energy) {
        where.energy = where.energy || {};
        if (params.energy.min !== undefined)
            where.energy.gte = Math.max(
                where.energy.gte || 0,
                params.energy.min
            );
        if (params.energy.max !== undefined)
            where.energy.lte = Math.min(
                where.energy.lte ?? 1,
                params.energy.max
            );
    }
    if (params.danceability) {
        where.danceability = where.danceability || {};
        if (params.danceability.min !== undefined)
            where.danceability.gte = Math.max(
                where.danceability.gte || 0,
                params.danceability.min
            );
        if (params.danceability.max !== undefined)
            where.danceability.lte = Math.min(
                where.danceability.lte ?? 1,
                params.danceability.max
            );
    }
    if (params.acousticness) {
        where.acousticness = {};
        if (params.acousticness.min !== undefined)
            where.acousticness.gte = params.acousticness.min;
        if (params.acousticness.max !== undefined)
            where.acousticness.lte = params.acousticness.max;
    }
    if (params.instrumentalness) {
        where.instrumentalness = {};
        if (params.instrumentalness.min !== undefined)
            where.instrumentalness.gte = params.instrumentalness.min;
        if (params.instrumentalness.max !== undefined)
            where.instrumentalness.lte = params.instrumentalness.max;
    }
    if (params.arousal) {
        where.arousal = {};
        if (params.arousal.min !== undefined)
            where.arousal.gte = params.arousal.min;
        if (params.arousal.max !== undefined)
            where.arousal.lte = params.arousal.max;
    }
    if (params.bpm) {
        where.bpm = {};
        if (params.bpm.min !== undefined) where.bpm.gte = params.bpm.min;
        if (params.bpm.max !== undefined) where.bpm.lte = params.bpm.max;
    }
    if (params.keyScale) {
        where.keyScale = params.keyScale;
    }

    if (params.moodHappy) {
        where.moodHappy = {};
        if (params.moodHappy.min !== undefined)
            where.moodHappy.gte = params.moodHappy.min;
        if (params.moodHappy.max !== undefined)
            where.moodHappy.lte = params.moodHappy.max;
    }
    if (params.moodSad) {
        where.moodSad = {};
        if (params.moodSad.min !== undefined)
            where.moodSad.gte = params.moodSad.min;
        if (params.moodSad.max !== undefined)
            where.moodSad.lte = params.moodSad.max;
    }
    if (params.moodRelaxed) {
        where.moodRelaxed = {};
        if (params.moodRelaxed.min !== undefined)
            where.moodRelaxed.gte = params.moodRelaxed.min;
        if (params.moodRelaxed.max !== undefined)
            where.moodRelaxed.lte = params.moodRelaxed.max;
    }
    if (params.moodAggressive) {
        where.moodAggressive = {};
        if (params.moodAggressive.min !== undefined)
            where.moodAggressive.gte = params.moodAggressive.min;
        if (params.moodAggressive.max !== undefined)
            where.moodAggressive.lte = params.moodAggressive.max;
    }
    if (params.moodParty) {
        where.moodParty = {};
        if (params.moodParty.min !== undefined)
            where.moodParty.gte = params.moodParty.min;
        if (params.moodParty.max !== undefined)
            where.moodParty.lte = params.moodParty.max;
    }
    if (params.moodAcoustic) {
        where.moodAcoustic = {};
        if (params.moodAcoustic.min !== undefined)
            where.moodAcoustic.gte = params.moodAcoustic.min;
        if (params.moodAcoustic.max !== undefined)
            where.moodAcoustic.lte = params.moodAcoustic.max;
    }
    if (params.moodElectronic) {
        where.moodElectronic = {};
        if (params.moodElectronic.min !== undefined)
            where.moodElectronic.gte = params.moodElectronic.min;
        if (params.moodElectronic.max !== undefined)
            where.moodElectronic.lte = params.moodElectronic.max;
    }

    // useEnhancedMode is referenced above; suppress unused variable warning
    void useEnhancedMode;

    const tracks = await prisma.track.findMany({
        where,
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    const limit = params.limit || 15;
    if (tracks.length < Math.min(limit, 8)) return null;

    const shuffled = randomSample(tracks, limit);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    const timestamp = Date.now();
    return {
        id: `mood-on-demand-${timestamp}`,
        type: "mood-on-demand",
        name: "Custom Mood Mix",
        description: `Generated just for you`,
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("mood"),
    };
}
