// The mood and radio cut-offs in this file are the launch values; the record of each is
// services/audio-analyzer-clap/eval/music-switch-2026-10-17/cutoffs.json.
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    ProgrammaticMix,
    albumCoverUrls,
    getMixColor,
    randomSample,
    sampledMix,
    sampleTracks,
    drawIds,
    tracksByIds,
    unplayedTrackIds,
    sampleMix,
    getSeededRandom,
    seededShuffle,
    findTracksByGenrePatterns,
    mergeNewById,
} from "./helpers";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import { spellingsOf } from "../stats/playable";
import type { MoodType } from "../moodBucketService";

const MIN_TRACKS_DAILY = 8;
const MIN_TRACKS_WEEKLY = 15;
const DAILY_TRACK_LIMIT = 10;
const WEEKLY_TRACK_LIMIT = 20;

/**
 * The mood path of a mix: the bucket pool, the same rule the mood page uses
 * (the head's verdict plus the library-rank share, no fixed score cutoffs).
 * `extraWhere` carries the non-mood flavour a generator adds (tempo, energy);
 * it never re-introduces a mood threshold.
 */
async function poolTracksForMood(
    mood: MoodType,
    extraWhere: Record<string, unknown>,
    take: number,
    seed?: number
) {
    // The bucket is matched in the database: a bucket can hold more tracks than
    // one query can send as ids (Postgres allows 65,535 bound values).
    return sampleTracks({
        where: {
            moodBuckets: { some: { mood } },
            ...NOT_MISSING,
            ...extraWhere,
        },
        include: { album: { select: { coverUrl: true } } },
        take,
        seed,
    });
}

export async function generateChillMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const seed = getSeededRandom(`chill-${today}`);
    // Mood path: the bucket pool, flavoured by low energy.
    let tracks = await poolTracksForMood("chill", { energy: { lte: 0.55 } }, 100, seed);

    logger.debug(`[CHILL MIX] Bucket mode: Found ${tracks.length} tracks`);

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(`[CHILL MIX] Falling back to Standard mode`);
        tracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
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
            seed,
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

    const shuffled = seededShuffle(tracks, seed);

    const isWeekly = tracks.length >= MIN_TRACKS_WEEKLY;
    const trackLimit = isWeekly ? WEEKLY_TRACK_LIMIT : DAILY_TRACK_LIMIT;
    const selectedTracks = shuffled.slice(0, trackLimit);

    const coverUrls = albumCoverUrls(selectedTracks);

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
    const seed = getSeededRandom(`high-energy-${today}`);
    let tracks: any[] = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            energy: { gte: 0.7 },
            bpm: { gte: 120 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
        seed,
    });
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
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
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

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, WEEKLY_TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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
    const seed = getSeededRandom(`late-night-${today}`);
    // Mood path: the bucket pool, flavoured by late-night tempo.
    let tracks = await poolTracksForMood(
        "chill",
        { energy: { lte: 0.5 }, bpm: { lte: 110 } },
        100,
        seed
    );

    logger.debug(
        `[LATE NIGHT MIX] Enhanced mode: Found ${tracks.length} tracks`
    );

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(`[LATE NIGHT MIX] Falling back to Standard mode`);
        tracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
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
            seed,
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

    const shuffled = seededShuffle(tracks, seed);

    const isWeekly = tracks.length >= MIN_TRACKS_WEEKLY;
    const trackLimit = isWeekly ? WEEKLY_TRACK_LIMIT : DAILY_TRACK_LIMIT;
    const selectedTracks = shuffled.slice(0, trackLimit);

    const coverUrls = albumCoverUrls(selectedTracks);

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
    const seed = getSeededRandom(`happy-${today}`);
    // Mood path: the bucket pool — head verdict and library rank,
    // no fixed cutoffs.
    let tracks: any[] = await poolTracksForMood("happy", {}, 100, seed);
    logger.debug(`[HAPPY MIX] Bucket mode: Found ${tracks.length} tracks`);

    if (tracks.length < 15) {
        const standardTracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
                analysisStatus: "completed",
                valence: { gte: 0.6 },
                energy: { gte: 0.5 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
            seed,
        });
        tracks = mergeNewById(tracks, standardTracks);
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
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
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

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, WEEKLY_TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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

// The stored valence (0.7 mood analyzer + 0.3 sound model) spreads a library 2.48x narrower than when this sort was
// written, measured as the mean difference between two of 8,971 library tracks
// (services/audio-analyzer-clap/eval/music-switch-2026-10-17/followup.json). Scaling it by that keeps valence's share
// of the sort.
export const MELANCHOLY_VALENCE_SCALE = 2.48;

/** Lower sorts first: low valence, low energy, minor key. */
export function melancholyScore(t: { valence?: number | null; energy?: number | null; keyScale?: string | null }): number {
    return (t.valence || 0.5) * 2 * MELANCHOLY_VALENCE_SCALE + (t.energy || 0.5) + (t.keyScale === "minor" ? 0 : 0.3);
}

export async function generateMelancholyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const seed = getSeededRandom(`melancholy-${today}`);
    let tracks: any[] = [];

    // Mood path: the bucket pool.
    const enhancedTracks = await poolTracksForMood("sad", {}, 150, seed);
    logger.debug(
        `[MELANCHOLY MIX] Bucket mode: Found ${enhancedTracks.length} tracks`
    );

    if (enhancedTracks.length >= 15) {
        tracks = enhancedTracks;
    } else {
        logger.debug(`[MELANCHOLY MIX] Falling back to Standard mode`);
        const audioTracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
                analysisStatus: "completed",
                valence: { lte: 0.35 },
                energy: { lte: 0.6 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 150,
            seed,
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
            return hasMinorKey || hasSadTags;
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
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
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

    const sortedTracks = tracks.sort((a, b) => melancholyScore(a) - melancholyScore(b));

    const shuffled = seededShuffle(sortedTracks.slice(0, 50), seed);

    const selectedTracks = shuffled.slice(0, WEEKLY_TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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
    const seed = getSeededRandom(`dance-floor-${today}`);
    let tracks: any[] = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            danceability: { gte: 0.7 },
            bpm: { gte: 110, lte: 140 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
        seed,
    });
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
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
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

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, WEEKLY_TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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
    const seed = getSeededRandom(`acoustic-${today}`);
    let tracks: any[] = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            acousticness: { gte: 0.6 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
        seed,
    });
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
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
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

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, WEEKLY_TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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
    const seed = getSeededRandom(`instrumental-${today}`);
    let tracks: any[] = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            instrumentalness: { gte: 0.7 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
        seed,
    });
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
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
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

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, WEEKLY_TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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

export async function generateRoadTripMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const seed = getSeededRandom(`road-trip-${today}`);
    let tracks: any[] = await sampleTracks({
        where: {
            ...NOT_MISSING,
            // Moods come from audio analysis only. With nothing in the energetic or
            // upbeat moods, the genre and audio fallbacks below answer.
            moodTags: { hasSome: ["energetic", "upbeat", "happy"] },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
        seed,
    });
    logger.debug(`[ROAD TRIP MIX] Found ${tracks.length} tracks from tags`);

    if (tracks.length < 15) {
        const audioTracks = await sampleTracks({
                where: {
                ...NOT_MISSING,
                analysisStatus: "completed",
                energy: { gte: 0.5, lte: 0.8 },
                bpm: { gte: 100, lte: 130 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
            seed,
        });
        tracks = mergeNewById(tracks, audioTracks);
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
            100,
            seed
        );
        tracks = mergeNewById(tracks, albumGenreTracks);
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

    const shuffled = seededShuffle(tracks, seed);

    const selectedTracks = shuffled.slice(0, WEEKLY_TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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

    return sampledMix({
        id: `sad-girl-sundays-${today}`,
        type: "sad-girl-sundays",
        name: "Sad Girl Sundays",
        description: "Melancholic introspection and feelings",
        colorType: "sad-girl-sundays",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`sad-girl-sundays-${today}`),
        where: {
            ...NOT_MISSING,
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
            ],
        },
    });
}

export async function generateMainCharacterEnergy(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `main-character-${today}`,
        type: "main-character",
        name: "Main Character Energy",
        description: "You're the protagonist today",
        colorType: "main-character",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`main-character-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            AND: [
                { valence: { gte: 0.55 } },
                { energy: { gte: 0.55 } },
                { danceability: { gte: 0.5 } },
            ],
        },
    });
}

export async function generateVillainEra(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `villain-era-${today}`,
        type: "villain-era",
        name: "Villain Era",
        description: "Embrace your dark side",
        colorType: "villain-era",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`villain-era-${today}`),
        where: {
            ...NOT_MISSING,
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
            ],
        },
    });
}

export async function generate3AMThoughts(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `3am-thoughts-${today}`,
        type: "3am-thoughts",
        name: "3AM Thoughts",
        description: "Late night overthinking companion",
        colorType: "3am-thoughts",
        take: 50,
        minTracks: MIN_TRACKS_DAILY,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`3am-thoughts-${today}`),
        where: {
            ...NOT_MISSING,
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
    });
}

export async function generateHotGirlWalk(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `hot-girl-walk-${today}`,
        type: "hot-girl-walk",
        name: "Hot Girl Walk",
        description: "Confidence boost for your walk",
        colorType: "confidence-boost",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`hot-girl-walk-${today}`),
        where: {
            ...NOT_MISSING,
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
    });
}

export async function generateRageCleaning(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `rage-cleaning-${today}`,
        type: "rage-cleaning",
        name: "Rage Cleaning",
        description: "Aggressive productivity fuel",
        colorType: "workout",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`rage-cleaning-${today}`),
        where: {
            ...NOT_MISSING,
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
    });
}

export async function generateGoldenHour(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `golden-hour-${today}`,
        type: "golden-hour",
        name: "Golden Hour",
        description: "Warm sunset vibes",
        colorType: "golden-hour",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`golden-hour-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.45 } },
                        { acousticness: { gte: 0.35 } },
                        { energy: { gte: 0.25, lte: 0.65 } },
                    ],
                },
            ],
        },
    });
}

export async function generateShowerKaraoke(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `shower-karaoke-${today}`,
        type: "shower-karaoke",
        name: "Shower Karaoke",
        description: "Belters you can't help but sing",
        colorType: "happy",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`shower-karaoke-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            AND: [
                { instrumentalness: { lte: 0.35 } },
                { energy: { gte: 0.55 } },
                { valence: { gte: 0.45 } },
            ],
        },
    });
}

export async function generateInMyFeelings(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `in-my-feelings-${today}`,
        type: "in-my-feelings",
        name: "In My Feelings",
        description: "Let it all out",
        colorType: "heartbreak-hotel",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`in-my-feelings-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { lte: 0.4 } },
                        { arousal: { lte: 0.55 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
            ],
        },
    });
}

export async function generateMidnightDrive(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `midnight-drive-${today}`,
        type: "midnight-drive",
        name: "Midnight Drive",
        description: "Perfect for late night cruising",
        colorType: "night-drive",
        take: 50,
        minTracks: MIN_TRACKS_DAILY,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`midnight-drive-${today}`),
        where: {
            ...NOT_MISSING,
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
    });
}

export async function generateCoffeeShopVibes(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `coffee-shop-${today}`,
        type: "coffee-shop",
        name: "Coffee Shop Vibes",
        description: "Cozy background music",
        colorType: "coffee-shop",
        take: 50,
        minTracks: MIN_TRACKS_DAILY,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`coffee-shop-${today}`),
        where: {
            ...NOT_MISSING,
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
    });
}

export async function generateRomanticizeYourLife(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `romanticize-${today}`,
        type: "romanticize",
        name: "Romanticize Your Life",
        description: "Make every moment aesthetic",
        colorType: "golden-hour",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`romanticize-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.35, lte: 0.75 } },
                        { arousal: { gte: 0.25, lte: 0.65 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
            ],
        },
    });
}

export async function generateThatGirlEra(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `that-girl-era-${today}`,
        type: "that-girl-era",
        name: "That Girl Era",
        description: "Self-improvement mode activated",
        colorType: "confidence-boost",
        take: 50,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`that-girl-era-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            AND: [
                { valence: { gte: 0.55 } },
                { energy: { gte: 0.45 } },
                { danceability: { gte: 0.45 } },
            ],
        },
    });
}

export async function generateUnhinged(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `unhinged-${today}`,
        type: "unhinged",
        name: "Unhinged",
        description: "Embrace the chaos",
        colorType: "dance-floor",
        take: 100,
        minTracks: 8,
        limit: DAILY_TRACK_LIMIT,
        seed: getSeededRandom(`unhinged-${today}`),
        where: {
            ...NOT_MISSING,
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
    });
}

// WEEKLY CURATED MIXES (20 tracks)

export async function generateDeepCuts(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await tracksByIds(
        drawIds(await unplayedTrackIds({ excludeMissing: true }), 200),
        {
            album: {
                select: {
                    coverUrl: true,
                    artist: { select: { id: true } },
                },
            },
        }
    );

    if (tracks.length < 15) {
        const playCounts = await prisma.track.findMany({
            where: NOT_MISSING,
            select: { id: true, _count: { select: { plays: true } } },
            orderBy: { id: "asc" },
        });
        const lowPlayIds = playCounts
            .filter((t) => t._count.plays <= 3)
            .map((t) => t.id);

        const filtered = await tracksByIds(drawIds(lowPlayIds, 200), {
            album: { select: { coverUrl: true } },
        });

        if (filtered.length < 15) return null;

        return sampleMix(
            {
                id: `deep-cuts-${today}`,
                type: "deep-cuts",
                name: "Deep Cuts",
                description: "Hidden gems waiting to be discovered",
                colorType: "rediscover",
            },
            filtered,
            WEEKLY_TRACK_LIMIT
        );
    }

    return sampleMix(
        {
            id: `deep-cuts-${today}`,
            type: "deep-cuts",
            name: "Deep Cuts",
            description: "Hidden gems waiting to be discovered",
            colorType: "rediscover",
        },
        tracks,
        WEEKLY_TRACK_LIMIT
    );
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

    const tracks = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            key: { not: null },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 200,
        seed: getSeededRandom(`key-journey-${today}`),
    });

    if (tracks.length < 15) return null;

    const byKey = new Map<string, typeof tracks>();
    for (const track of tracks) {
        // Essentia writes C# where keyOrder says Db; group by the table's spelling.
        const key = spellingsOf(track.key || "C").find((s) => keyOrder.includes(s)) ?? track.key ?? "C";
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(track);
    }

    const journey: typeof tracks = [];

    for (const key of keyOrder) {
        const keyTracks = byKey.get(key) || [];
        if (keyTracks.length > 0 && journey.length < WEEKLY_TRACK_LIMIT) {
            const count = Math.min(
                2,
                keyTracks.length,
                WEEKLY_TRACK_LIMIT - journey.length
            );
            const keySeed = getSeededRandom(`key-journey-${today}-${key}`);
            const shuffled = seededShuffle(keyTracks, keySeed);
            journey.push(...shuffled.slice(0, count));
        }
    }

    if (journey.length < 15) return null;

    const coverUrls = albumCoverUrls(journey);

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
    const tracks = await sampleTracks({
        where: {
            ...NOT_MISSING,
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

    const coverUrls = albumCoverUrls(flow);

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
    return sampledMix({
        id: `vocal-detox-${today}`,
        type: "vocal-detox",
        name: "Vocal Detox",
        description: "Pure instrumental escape",
        colorType: "instrumental",
        take: 100,
        minTracks: 15,
        limit: WEEKLY_TRACK_LIMIT,
        seed: getSeededRandom(`vocal-detox-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            instrumentalness: { gte: 0.75 },
        },
    });
}

export async function generateMinorKeyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 1) return null;

    return sampledMix({
        id: `minor-key-${today}`,
        type: "melancholy",
        name: "Minor Key Mondays",
        description: "All minor key bangers",
        colorType: "melancholy",
        take: 100,
        minTracks: 15,
        limit: WEEKLY_TRACK_LIMIT,
        seed: getSeededRandom(`minor-key-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            keyScale: "minor",
            energy: { gte: 0.45 },
        },
    });
}

export type MoodOnDemandParams = {
    mood?: MoodType;
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
    limit?: number;
};

export async function generateMoodOnDemand(
    _userId: string,
    params: MoodOnDemandParams
): Promise<ProgrammaticMix | null> {
    const where: any = {
        analysisStatus: "completed",
        ...NOT_MISSING,
    };

    // Mood path: the named mood selects the bucket pool — the
    // head verdict is the membership, no score cutoffs. Legacy callers pass
    // the head columns (moodHappy: { min: … }); they name the same mood and
    // their thresholds are ignored.
    const LEGACY_MOOD_PARAMS: [string, MoodType][] = [
        ["moodHappy", "happy"],
        ["moodSad", "sad"],
        ["moodRelaxed", "chill"],
        ["moodAggressive", "aggressive"],
        ["moodParty", "party"],
    ];
    const mood =
        params.mood ??
        LEGACY_MOOD_PARAMS.find(([key]) => (params as any)[key] !== undefined)
            ?.[1];
    for (const [key] of LEGACY_MOOD_PARAMS) delete (params as any)[key];
    if (mood) {
        const bucketSize = await prisma.moodBucket.count({ where: { mood } });
        if (bucketSize < MIN_TRACKS_DAILY) {
            logger.debug(
                `[MoodMixer] Bucket "${mood}" has ${bucketSize} tracks (need ${MIN_TRACKS_DAILY})`
            );
            return null;
        }
        where.moodBuckets = { some: { mood } };
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

    const tracks = await sampleTracks({
        where,
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    const limit = params.limit || 15;
    if (tracks.length < Math.min(limit, 8)) return null;

    const shuffled = randomSample(tracks, limit);
    const coverUrls = albumCoverUrls(shuffled);

    const timestamp = Date.now();
    return {
        id: `mood-on-demand-${timestamp}`,
        type: "mood-on-demand",
        name: "Custom Mood Mix",
        description: "Generated just for you",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("mood"),
    };
}
