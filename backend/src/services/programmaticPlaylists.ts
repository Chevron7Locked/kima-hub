import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { lastFmService } from "./lastfm";
import { moodBucketService } from "./moodBucketService";
import {
    getDecadeWhereClause,
    getEffectiveYear,
    getDecadeFromYear,
} from "../utils/dateFilters";

export interface ProgrammaticMix {
    id: string;
    type: string;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[]; // For mosaic cover art
    trackCount: number;
    color: string; // Tailwind gradient classes for mood-reflective hero
}

// Research-based color psychology for mix vibes
// Using actual CSS rgba values for inline styles (Tailwind classes get purged at build time)
const MIX_COLORS: Record<string, string> = {
    // Night/Introspection - Deep blues and purples for calm, night sky, solitude
    "late-night":
        "linear-gradient(to bottom, rgba(30, 27, 75, 0.7), rgba(30, 58, 138, 0.5), rgba(15, 23, 42, 0.4))",
    "3am-thoughts":
        "linear-gradient(to bottom, rgba(46, 16, 101, 0.7), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "night-drive":
        "linear-gradient(to bottom, rgba(15, 23, 42, 0.7), rgba(49, 46, 129, 0.5), rgba(88, 28, 135, 0.4))",

    // Calm/Relaxation - Teal and seafoam for spa-like tranquility
    chill: "linear-gradient(to bottom, rgba(17, 94, 89, 0.6), rgba(22, 78, 99, 0.5), rgba(15, 23, 42, 0.4))",
    "coffee-shop":
        "linear-gradient(to bottom, rgba(120, 53, 15, 0.6), rgba(68, 64, 60, 0.5), rgba(38, 38, 38, 0.4))",
    "rainy-day":
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(31, 41, 55, 0.5), rgba(39, 39, 42, 0.4))",
    "sunday-morning":
        "linear-gradient(to bottom, rgba(253, 186, 116, 0.4), rgba(252, 211, 77, 0.3), rgba(68, 64, 60, 0.4))",

    // Energy/Workout - Red and orange to increase heart rate
    workout:
        "linear-gradient(to bottom, rgba(153, 27, 27, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    "confidence-boost":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(68, 64, 60, 0.4))",

    // Happy/Uplifting - Yellow and warm amber for optimism
    happy: "linear-gradient(to bottom, rgba(217, 119, 6, 0.5), rgba(161, 98, 7, 0.4), rgba(68, 64, 60, 0.4))",
    "summer-vibes":
        "linear-gradient(to bottom, rgba(8, 145, 178, 0.5), rgba(15, 118, 110, 0.4), rgba(30, 58, 138, 0.4))",
    "golden-hour":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(234, 88, 12, 0.4), rgba(136, 19, 55, 0.4))",

    // Sad/Melancholy - Cool blue-grays for "feeling blue"
    melancholy:
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(30, 58, 138, 0.5), rgba(17, 24, 39, 0.4))",
    "sad-girl-sundays":
        "linear-gradient(to bottom, rgba(136, 19, 55, 0.5), rgba(30, 41, 59, 0.5), rgba(59, 7, 100, 0.4))",
    "heartbreak-hotel":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",

    // Party/Dance - Hot pink and magenta for club energy
    "dance-floor":
        "linear-gradient(to bottom, rgba(162, 28, 175, 0.6), rgba(131, 24, 67, 0.5), rgba(59, 7, 100, 0.4))",

    // Acoustic/Organic - Warm browns like wood instruments
    acoustic:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    unplugged:
        "linear-gradient(to bottom, rgba(68, 64, 60, 0.6), rgba(120, 53, 15, 0.5), rgba(38, 38, 38, 0.4))",

    // Focus/Instrumental - Purple for creativity and concentration
    instrumental:
        "linear-gradient(to bottom, rgba(91, 33, 182, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "focus-flow":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(30, 41, 59, 0.5), rgba(17, 24, 39, 0.4))",

    // Adventure/Road Trip - Sunset oranges for freedom
    "road-trip":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(14, 165, 233, 0.4))",

    // Character/Mood Archetypes
    "main-character":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(202, 138, 4, 0.4), rgba(124, 45, 18, 0.4))",
    "villain-era":
        "linear-gradient(to bottom, rgba(69, 10, 10, 0.7), rgba(17, 24, 39, 0.6), rgba(0, 0, 0, 0.5))",

    // Nostalgia - Sepia and vintage tones
    throwback:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.5), rgba(124, 45, 18, 0.4), rgba(68, 64, 60, 0.4))",

    // Genre/Era based - More neutral but themed
    era: "linear-gradient(to bottom, rgba(68, 64, 60, 0.5), rgba(38, 38, 38, 0.4), rgba(39, 39, 42, 0.4))",
    genre: "linear-gradient(to bottom, rgba(63, 63, 70, 0.5), rgba(30, 41, 59, 0.4), rgba(17, 24, 39, 0.4))",
    "top-tracks":
        "linear-gradient(to bottom, rgba(6, 95, 70, 0.5), rgba(17, 94, 89, 0.4), rgba(15, 23, 42, 0.4))",
    rediscover:
        "linear-gradient(to bottom, rgba(55, 48, 163, 0.5), rgba(76, 29, 149, 0.4), rgba(15, 23, 42, 0.4))",
    "artist-similar":
        "linear-gradient(to bottom, rgba(107, 33, 168, 0.5), rgba(112, 26, 117, 0.4), rgba(15, 23, 42, 0.4))",
    discovery:
        "linear-gradient(to bottom, rgba(2, 132, 199, 0.5), rgba(30, 58, 138, 0.4), rgba(15, 23, 42, 0.4))",

    // Mood-on-demand default
    mood: "linear-gradient(to bottom, rgba(162, 28, 175, 0.5), rgba(107, 33, 168, 0.4), rgba(15, 23, 42, 0.4))",

    // Default fallback
    default:
        "linear-gradient(to bottom, rgba(88, 28, 135, 0.4), rgba(26, 26, 26, 1), transparent)",
};

// Helper to get color for a mix type
function getMixColor(type: string): string {
    return MIX_COLORS[type] || MIX_COLORS["default"];
}

// Helper to randomly sample from array using Fisher-Yates shuffle
function randomSample<T>(array: T[], count: number): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result.slice(0, count);
}

// Helper to get seeded random number for daily consistency
function getSeededRandom(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        const char = seed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

// Type for track with album cover
type TrackWithAlbumCover = {
    id: string;
    album: {
        coverUrl: string | null;
        genres?: unknown;
        userGenres?: string[] | null;
        artist?: {
            userGenres?: string[] | null;
        };
    };
    lastfmTags?: string[];
    essentiaGenres?: string[];
    [key: string]: unknown;
};

/**
 * Helper to find tracks matching genre patterns.
 * Uses lastfmTags and essentiaGenres on tracks (String[]) first,
 * then falls back to filtering album.genres (JSON array) in memory.
 */
async function findTracksByGenrePatterns(
    genrePatterns: string[],
    limit: number = 100
): Promise<TrackWithAlbumCover[]> {
    // Strategy 1: Use track's lastfmTags and essentiaGenres (native String[] fields)
    const tagPatterns = genrePatterns.map((g) => g.toLowerCase());

    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                { lastfmTags: { hasSome: tagPatterns } },
                { essentiaGenres: { hasSome: tagPatterns } },
            ],
        },
        include: {
            album: {
                select: {
                    coverUrl: true,
                    genres: true,
                    userGenres: true,
                    artist: {
                        select: {
                            userGenres: true,
                        },
                    },
                },
            },
        },
        take: limit,
    });

    if (tracks.length >= 15) {
        return tracks as TrackWithAlbumCover[];
    }

    // Strategy 2: Query albums with non-empty genres (canonical or user) and filter in memory
    const albumTracks = await prisma.track.findMany({
        where: {
            album: {
                OR: [
                    { genres: { not: { equals: null } } },
                    { userGenres: { not: { equals: null } } },
                ],
            },
        },
        include: {
            album: {
                select: {
                    coverUrl: true,
                    genres: true,
                    userGenres: true,
                    artist: {
                        select: {
                            userGenres: true,
                        },
                    },
                },
            },
        },
        take: limit * 3, // Get more to filter down
    });

    // Filter by genre patterns (case-insensitive partial match)
    // Merge canonical and user genres from both album and artist
    const genreMatched = albumTracks.filter((t) => {
        const albumGenres = t.album.genres as string[] | null;
        const albumUserGenres = (t.album.userGenres as string[] | null) || [];
        const artistUserGenres = (t.album.artist?.userGenres as string[] | null) || [];

        // Merge all genres
        const allGenres = [
            ...(albumGenres || []),
            ...albumUserGenres,
            ...artistUserGenres,
        ];

        if (allGenres.length === 0) return false;

        return allGenres.some((ag) =>
            genrePatterns.some((gp) =>
                ag.toLowerCase().includes(gp.toLowerCase())
            )
        );
    });

    // Merge unique tracks
    const existingIds = new Set(tracks.map((t) => t.id));
    const merged = [
        ...tracks,
        ...genreMatched.filter((t) => !existingIds.has(t.id)),
    ];

    return merged.slice(0, limit) as TrackWithAlbumCover[];
}

export class ProgrammaticPlaylistService {
    private readonly TRACK_LIMIT = 20;
    private readonly DAILY_MIX_COUNT = 5;

    // Track count thresholds for mix generation
    private readonly MIN_TRACKS_DAILY = 8; // Minimum to generate a daily mix
    private readonly MIN_TRACKS_WEEKLY = 15; // Minimum to generate a weekly mix
    private readonly DAILY_TRACK_LIMIT = 10; // Daily mix size
    private readonly WEEKLY_TRACK_LIMIT = 20; // Weekly mix size

    /**
     * Generate 4 daily rotating mixes
     */
    async generateAllMixes(
        userId: string,
        forceRandom = false
    ): Promise<ProgrammaticMix[]> {
        // Get today's date for daily rotation (or random seed if refreshing)
        const today = new Date().toISOString().split("T")[0];
        const seedString = forceRandom
            ? `${userId}-${Date.now()}-${Math.random()}`
            : `${today}-${userId}`;
        const dateSeed = getSeededRandom(seedString);

        logger.debug(
            `[MIXES] Generating mixes for user ${userId}, forceRandom: ${forceRandom}, seed: ${dateSeed}`
        );

        // Define all possible mix types
        const seedSuffix = forceRandom ? `-${Date.now()}` : "";
        const mixGenerators = [
            // Classic mixes (genre/era based)
            {
                fn: () => this.generateEraMix(userId, today + seedSuffix),
                weight: 2,
                name: "Era Mix",
            },
            {
                fn: () => this.generateGenreMix(userId, today + seedSuffix),
                weight: 2,
                name: "Genre Mix",
            },
            {
                fn: () => this.generateTopTracksMix(userId),
                weight: 1,
                name: "Top Tracks Mix",
            },
            {
                fn: () =>
                    this.generateRediscoverMix(userId, today + seedSuffix),
                weight: 1,
                name: "Rediscover Mix",
            },
            {
                fn: () => this.generateArtistSimilarMix(userId),
                weight: 1,
                name: "Artist Similar Mix",
            },
            {
                fn: () =>
                    this.generateRandomDiscoveryMix(userId, today + seedSuffix),
                weight: 1,
                name: "Random Discovery Mix",
            },
            {
                fn: () => this.generatePartyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Party Mix",
            },
            {
                fn: () => this.generateChillMix(userId, today + seedSuffix),
                weight: 2,
                name: "Chill Mix",
            },
            {
                fn: () => this.generateWorkoutMix(userId, today + seedSuffix),
                weight: 2,
                name: "Workout Mix",
            },
            {
                fn: () => this.generateFocusMix(userId, today + seedSuffix),
                weight: 2,
                name: "Focus Mix",
            },
            // Audio analysis-based mixes (using Essentia features)
            {
                fn: () =>
                    this.generateHighEnergyMix(userId, today + seedSuffix),
                weight: 2,
                name: "High Energy Mix",
            },
            {
                fn: () => this.generateLateNightMix(userId, today + seedSuffix),
                weight: 2,
                name: "Late Night Mix",
            },
            {
                fn: () => this.generateHappyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Happy Vibes Mix",
            },
            {
                fn: () =>
                    this.generateMelancholyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Melancholy Mix",
            },
            {
                fn: () =>
                    this.generateDanceFloorMix(userId, today + seedSuffix),
                weight: 2,
                name: "Dance Floor Mix",
            },
            {
                fn: () => this.generateAcousticMix(userId, today + seedSuffix),
                weight: 2,
                name: "Acoustic Mix",
            },
            {
                fn: () =>
                    this.generateInstrumentalMix(userId, today + seedSuffix),
                weight: 2,
                name: "Instrumental Mix",
            },
            {
                fn: () => this.generateRoadTripMix(userId, today + seedSuffix),
                weight: 2,
                name: "Road Trip Mix",
            },
            // Day-of-week mixes
            {
                fn: () => this.generateDayMix(userId),
                weight: 1,
                name: "Day Mix",
            },
            // Curated Vibe Mixes (Daily, 10 tracks)
            {
                fn: () =>
                    this.generateSadGirlSundays(userId, today + seedSuffix),
                weight: 2,
                name: "Sad Girl Sundays",
            },
            {
                fn: () =>
                    this.generateMainCharacterEnergy(
                        userId,
                        today + seedSuffix
                    ),
                weight: 2,
                name: "Main Character Energy",
            },
            {
                fn: () => this.generateVillainEra(userId, today + seedSuffix),
                weight: 2,
                name: "Villain Era",
            },
            {
                fn: () => this.generate3AMThoughts(userId, today + seedSuffix),
                weight: 2,
                name: "3AM Thoughts",
            },
            {
                fn: () => this.generateHotGirlWalk(userId, today + seedSuffix),
                weight: 2,
                name: "Hot Girl Walk",
            },
            {
                fn: () => this.generateRageCleaning(userId, today + seedSuffix),
                weight: 2,
                name: "Rage Cleaning",
            },
            {
                fn: () => this.generateGoldenHour(userId, today + seedSuffix),
                weight: 2,
                name: "Golden Hour",
            },
            {
                fn: () =>
                    this.generateShowerKaraoke(userId, today + seedSuffix),
                weight: 2,
                name: "Shower Karaoke",
            },
            {
                fn: () => this.generateInMyFeelings(userId, today + seedSuffix),
                weight: 2,
                name: "In My Feelings",
            },
            {
                fn: () =>
                    this.generateMidnightDrive(userId, today + seedSuffix),
                weight: 2,
                name: "Midnight Drive",
            },
            {
                fn: () =>
                    this.generateCoffeeShopVibes(userId, today + seedSuffix),
                weight: 2,
                name: "Coffee Shop Vibes",
            },
            {
                fn: () =>
                    this.generateRomanticizeYourLife(
                        userId,
                        today + seedSuffix
                    ),
                weight: 2,
                name: "Romanticize Your Life",
            },
            {
                fn: () => this.generateThatGirlEra(userId, today + seedSuffix),
                weight: 2,
                name: "That Girl Era",
            },
            {
                fn: () => this.generateUnhinged(userId, today + seedSuffix),
                weight: 2,
                name: "Unhinged",
            },
            // Weekly Curated Mixes (20 tracks)
            {
                fn: () => this.generateDeepCuts(userId, today + seedSuffix),
                weight: 1,
                name: "Deep Cuts",
            },
            {
                fn: () => this.generateKeyJourney(userId, today + seedSuffix),
                weight: 1,
                name: "Key Journey",
            },
            {
                fn: () => this.generateTempoFlow(userId, today + seedSuffix),
                weight: 1,
                name: "Tempo Flow",
            },
            {
                fn: () => this.generateVocalDetox(userId, today + seedSuffix),
                weight: 1,
                name: "Vocal Detox",
            },
            {
                fn: () => this.generateMinorKeyMix(userId, today + seedSuffix),
                weight: 1,
                name: "Minor Key Mondays",
            },
        ];

        // Select 5 mixes based on date seed
        const selectedIndices: number[] = [];
        let seed = dateSeed;

        logger.debug(
            `[MIXES] Selecting ${this.DAILY_MIX_COUNT} mixes from ${mixGenerators.length} types...`
        );

        while (selectedIndices.length < this.DAILY_MIX_COUNT) {
            seed = (seed * 9301 + 49297) % 233280;
            const index = seed % mixGenerators.length;
            if (!selectedIndices.includes(index)) {
                selectedIndices.push(index);
                logger.debug(
                    `[MIXES] Selected index ${index}: ${mixGenerators[index].name}`
                );
            }
        }

        logger.debug(
            `[MIXES] Final selected indices: [${selectedIndices.join(", ")}]`
        );

        // Generate selected mixes
        const mixPromises = selectedIndices.map((i) => {
            logger.debug(`[MIXES] Generating ${mixGenerators[i].name}...`);
            return mixGenerators[i].fn();
        });
        const mixes = await Promise.all(mixPromises);

        logger.debug(`[MIXES] Generated ${mixes.length} mixes before filtering`);
        mixes.forEach((mix, i) => {
            if (mix === null) {
                logger.debug(
                    `[MIXES] Mix ${i} (${
                        mixGenerators[selectedIndices[i]].name
                    }) returned NULL`
                );
            } else {
                logger.debug(
                    `[MIXES] Mix ${i}: ${mix.name} (${mix.trackCount} tracks)`
                );
            }
        });

        // Filter out null mixes
        let finalMixes = mixes.filter(
            (mix): mix is ProgrammaticMix => mix !== null
        );
        logger.debug(
            `[MIXES] Returning ${finalMixes.length} mixes after filtering nulls`
        );

        // If we don't have 5 mixes, try to fill gaps with successful generators
        if (finalMixes.length < this.DAILY_MIX_COUNT) {
            logger.debug(
                `[MIXES] Only got ${finalMixes.length} mixes, trying to fill gaps...`
            );

            // Try generating from all types that weren't selected or failed
            const successfulTypes = new Set(finalMixes.map((m) => m.type));
            const attemptedIndices = new Set(selectedIndices);

            for (
                let i = 0;
                i < mixGenerators.length &&
                finalMixes.length < this.DAILY_MIX_COUNT;
                i++
            ) {
                if (!attemptedIndices.has(i)) {
                    logger.debug(
                        `[MIXES] Attempting fallback: ${mixGenerators[i].name}`
                    );
                    const fallbackMix = await mixGenerators[i].fn();
                    if (fallbackMix && !successfulTypes.has(fallbackMix.type)) {
                        finalMixes.push(fallbackMix);
                        successfulTypes.add(fallbackMix.type);
                        logger.debug(
                            `[MIXES] Fallback succeeded: ${fallbackMix.name}`
                        );
                    }
                }
            }

            logger.debug(`[MIXES] After fallbacks: ${finalMixes.length} mixes`);
        }

        // Check if user has saved mood mix from the new bucket system (fast lookup)
        try {
            const savedMoodMix = await moodBucketService.getUserMoodMix(userId);
            if (savedMoodMix) {
                logger.debug(
                    `[MIXES] User has saved mood mix: "${savedMoodMix.name}" with ${savedMoodMix.trackCount} tracks`
                );
                finalMixes.push(savedMoodMix);
            }
        } catch (err) {
            logger.error("[MIXES] Error getting user's saved mood mix:", err);
        }

        return finalMixes;
    }

    /**
     * Generate ONE era-based mix (rotating decade daily)
     */
    async generateEraMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Get all decades
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

        // Pick one decade based on today's date
        const decadeArray = Array.from(decades).sort((a, b) => b - a);
        const decadeSeed = getSeededRandom(`era-${today}`);
        const selectedDecade = decadeArray[decadeSeed % decadeArray.length];

        // Get ALL tracks from this decade
        const tracks = await prisma.track.findMany({
            where: {
                album: getDecadeWhereClause(selectedDecade),
            },
            include: {
                album: { select: { coverUrl: true } },
            },
        });

        if (tracks.length < 15) return null;

        // Random sample 20 tracks
        const selectedTracks = randomSample(tracks, this.TRACK_LIMIT);
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

    /**
     * Generate ONE genre-based mix (rotating genre daily)
     */
    async generateGenreMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Get top genres
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

        // Pick one genre based on today's date
        const genreSeed = getSeededRandom(`genre-${today}`);
        const selectedGenre = validGenres[genreSeed % validGenres.length];

        // Get ALL tracks from this genre
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

        // Random sample 20 tracks
        const selectedTracks = randomSample(tracks, this.TRACK_LIMIT);
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

    /**
     * Generate "Your Top 20" mix
     */
    async generateTopTracksMix(
        userId: string
    ): Promise<ProgrammaticMix | null> {
        const playStats = await prisma.play.groupBy({
            by: ["trackId"],
            where: { userId },
            _count: { trackId: true },
            orderBy: { _count: { trackId: "desc" } },
            take: this.TRACK_LIMIT,
        });

        logger.debug(
            `[TOP TRACKS MIX] Found ${playStats.length} unique played tracks`
        );
        if (playStats.length < 5) {
            logger.debug(
                `[TOP TRACKS MIX] FAILED: Only ${playStats.length} tracks (need at least 5)`
            );
            return null;
        }

        const trackIds = playStats.map((p) => p.trackId);
        const tracks = await prisma.track.findMany({
            where: { id: { in: trackIds } },
            include: {
                album: { select: { coverUrl: true } },
            },
        });

        // Preserve play count order
        const orderedTracks = trackIds
            .map((id) => tracks.find((t) => t.id === id))
            .filter((t) => t !== undefined);

        const coverUrls = orderedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: "top-tracks",
            type: "top-tracks",
            name: "Your Top 20",
            description: "Your most played tracks",
            trackIds: orderedTracks.map((t) => t.id),
            coverUrls,
            trackCount: orderedTracks.length,
            color: getMixColor("top-tracks"),
        };
    }

    /**
     * Generate "Rediscover" mix with daily rotation
     */
    async generateRediscoverMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Get tracks with low play count (0-2 plays)
        const allTracks = await prisma.track.findMany({
            include: {
                _count: {
                    select: {
                        plays: { where: { userId } },
                    },
                },
                album: { select: { coverUrl: true } },
            },
        });

        const underplayedTracks = allTracks.filter((t) => t._count.plays <= 2);

        if (underplayedTracks.length < 5) return null;

        // Use date seed for consistent daily selection
        const seed = getSeededRandom(`rediscover-${today}`);
        let random = seed;
        const shuffled = underplayedTracks.sort(() => {
            random = (random * 9301 + 49297) % 233280;
            return random / 233280 - 0.5;
        });

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `rediscover-${today}`,
            type: "rediscover",
            name: "Rediscover",
            description: "Hidden gems you rarely play",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("rediscover"),
        };
    }

    /**
     * Generate "More Like X" mix
     */
    async generateArtistSimilarMix(
        userId: string
    ): Promise<ProgrammaticMix | null> {
        // Get most played artist from last 7 days
        const recentPlays = await prisma.play.findMany({
            where: {
                userId,
                playedAt: {
                    gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                },
            },
            include: {
                track: {
                    include: {
                        album: { select: { artistId: true } },
                    },
                },
            },
        });

        logger.debug(
            `[ARTIST SIMILAR MIX] Found ${recentPlays.length} plays in last 7 days`
        );
        if (recentPlays.length === 0) {
            logger.debug(`[ARTIST SIMILAR MIX] FAILED: No plays in last 7 days`);
            return null;
        }

        // Count plays by artist
        const artistPlayCounts = new Map<string, number>();
        recentPlays.forEach((play) => {
            const artistId = play.track.album.artistId;
            artistPlayCounts.set(
                artistId,
                (artistPlayCounts.get(artistId) || 0) + 1
            );
        });

        // Get top artist
        const topArtistId = Array.from(artistPlayCounts.entries()).sort(
            (a, b) => b[1] - a[1]
        )[0][0];

        const topArtist = await prisma.artist.findUnique({
            where: { id: topArtistId },
        });

        if (!topArtist || !topArtist.name) {
            logger.debug(
                `[ARTIST SIMILAR MIX] FAILED: Top artist not found or has no name`
            );
            return null;
        }

        logger.debug(`[ARTIST SIMILAR MIX] Top artist: ${topArtist.name}`);

        // Get similar artists from Last.fm
        try {
            const similarArtists = await lastFmService.getSimilarArtists(
                topArtist.name,
                "10"
            );

            logger.debug(
                `[ARTIST SIMILAR MIX] Last.fm returned ${similarArtists.length} similar artists`
            );

            const similarArtistNames = similarArtists.map((a) => a.name);
            const artistsInLibrary = await prisma.artist.findMany({
                where: { name: { in: similarArtistNames } },
                include: {
                    albums: {
                        include: {
                            tracks: {
                                include: {
                                    album: { select: { coverUrl: true } },
                                },
                            },
                        },
                    },
                },
            });

            logger.debug(
                `[ARTIST SIMILAR MIX] Found ${artistsInLibrary.length} similar artists in library`
            );

            const tracks = artistsInLibrary.flatMap((artist) =>
                artist.albums.flatMap((album) => album.tracks)
            );

            logger.debug(
                `[ARTIST SIMILAR MIX] Total tracks from similar artists: ${tracks.length}`
            );

            if (tracks.length < 5) {
                logger.debug(
                    `[ARTIST SIMILAR MIX] FAILED: Only ${tracks.length} tracks (need at least 5)`
                );
                return null;
            }

            const selectedTracks = randomSample(tracks, this.TRACK_LIMIT);
            const coverUrls = selectedTracks
                .filter((t) => t.album.coverUrl)
                .slice(0, 4)
                .map((t) => t.album.coverUrl!);

            return {
                id: `artist-similar-${topArtistId}`,
                type: "artist-similar",
                name: `More Like ${topArtist.name}`,
                description: `Similar artists you might enjoy`,
                trackIds: selectedTracks.map((t) => t.id),
                coverUrls,
                trackCount: selectedTracks.length,
                color: getMixColor("artist-similar"),
            };
        } catch (error) {
            logger.error("Failed to generate artist similar mix:", error);
            return null;
        }
    }

    /**
     * Generate random discovery mix with daily rotation
     */
    async generateRandomDiscoveryMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const totalAlbums = await prisma.album.count({
            where: { tracks: { some: {} } },
        });

        if (totalAlbums < 10) return null;

        // Use date as seed for consistent daily randomness
        const seed = getSeededRandom(`random-${today}`) % totalAlbums;

        const randomAlbums = await prisma.album.findMany({
            where: { tracks: { some: {} } },
            include: {
                tracks: {
                    include: {
                        album: { select: { coverUrl: true } },
                    },
                },
            },
            skip: seed,
            take: 5, // Just a few albums
        });

        const tracks = randomAlbums.flatMap((album) => album.tracks);
        if (tracks.length < 5) return null;

        const selectedTracks = randomSample(tracks, this.TRACK_LIMIT);
        const coverUrls = randomAlbums
            .filter((a) => a.coverUrl)
            .slice(0, 4)
            .map((a) => a.coverUrl!);

        return {
            id: `random-discovery-${today}`,
            type: "discovery",
            name: "Random Discovery",
            description: "Random albums to explore today",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("discovery"),
        };
    }

    /**
     * Generate "Party Playlist" mix - upbeat dance, electronic, pop tracks
     * Uses multiple strategies: Genre table, album.genre, audio analysis
     */
    async generatePartyMix(
        userId: string,
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

        // Strategy 1: Genre table
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

        // Strategy 2: Album genre field (using helper for proper JSON array handling)
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

        // Strategy 3: Audio analysis (high energy, high danceability)
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

        // Use date seed for consistent daily selection
        const seed = getSeededRandom(`party-${today}`);
        let random = seed;
        const shuffled = tracks.sort(() => {
            random = (random * 9301 + 49297) % 233280;
            return random / 233280 - 0.5;
        });

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Chill Mix" - relaxing, mellow tracks
     * Enhanced mode: Uses ML moodRelaxed prediction
     * Standard mode: Uses energy/arousal heuristics
     */
    async generateChillMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Strategy 1: Enhanced mode - ML moodRelaxed prediction
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

        // Strategy 2: Standard mode fallback
        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(`[CHILL MIX] Falling back to Standard mode`);
            tracks = await prisma.track.findMany({
                where: {
                    analysisStatus: "completed",
                    AND: [
                        // MUST be low-to-moderate energy
                        { energy: { lte: 0.55 } },
                        // MUST be slow-to-moderate tempo
                        { bpm: { lte: 115 } },
                        // Plus additional mellow indicator
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

        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(
                `[CHILL MIX] FAILED: Only ${tracks.length} tracks (need ${this.MIN_TRACKS_DAILY})`
            );
            return null;
        }

        const seed = getSeededRandom(`chill-${today}`);
        let random = seed;
        const shuffled = tracks.sort(() => {
            random = (random * 9301 + 49297) % 233280;
            return random / 233280 - 0.5;
        });

        // Determine if daily or weekly based on available tracks
        const isWeekly = tracks.length >= this.MIN_TRACKS_WEEKLY;
        const trackLimit = isWeekly
            ? this.WEEKLY_TRACK_LIMIT
            : this.DAILY_TRACK_LIMIT;
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

    /**
     * Generate "Workout Mix" - high energy, motivational tracks
     * Enhanced mode: Uses ML high arousal + moodAggressive
     * Standard mode: Uses energy/BPM heuristics + genres
     */
    async generateWorkoutMix(
        userId: string,
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

        // Strategy 1: Enhanced mode - high arousal and energy
        const enhancedTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                analysisMode: "enhanced",
                AND: [
                    { arousal: { gte: 0.6 } },
                    { energy: { gte: 0.6 } },
                    { bpm: { gte: 110 } },
                    // Not too relaxed
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

        // Strategy 2: Standard mode fallback - audio analysis
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

        // Strategy 2: Genre table
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

        // Strategy 3: Album genre field (using helper for proper JSON array handling)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Focus Mix" - instrumental, minimal vocals, concentration music
     * Uses multiple strategies: Genre table, album.genre, audio analysis
     */
    async generateFocusMix(
        userId: string,
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

        // Strategy 1: Genre table
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

        // Strategy 2: Album genre field (using helper for proper JSON array handling)
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

        // Strategy 3: Audio analysis (high instrumentalness, moderate energy)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    // ============================================================
    // AUDIO ANALYSIS-BASED MIXES (Using Essentia features)
    // ============================================================

    /**
     * Generate "High Energy" mix using audio analysis
     * Criteria: energy >= 0.7, BPM >= 120
     * Fallback: energetic genres if no audio analysis
     */
    async generateHighEnergyMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
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

        // Strategy 2: Fallback to energetic genres (using helper for proper JSON array handling)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Late Night" mix using audio analysis
     * Enhanced mode: Uses ML moodRelaxed and low moodAggressive
     * Standard mode: Uses energy, BPM, arousal heuristics
     */
    async generateLateNightMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // First try Enhanced mode (ML mood predictions)
        let tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                analysisMode: "enhanced",
                AND: [
                    // High relaxed mood (ML)
                    { moodRelaxed: { gte: 0.5 } },
                    // Low aggression (ML)
                    { moodAggressive: { lte: 0.4 } },
                    // Low-moderate energy
                    { energy: { lte: 0.5 } },
                    // Slow-moderate tempo
                    { bpm: { lte: 110 } },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });

        logger.debug(
            `[LATE NIGHT MIX] Enhanced mode: Found ${tracks.length} tracks`
        );

        // Fallback to Standard mode if not enough Enhanced tracks
        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(`[LATE NIGHT MIX] Falling back to Standard mode`);
            tracks = await prisma.track.findMany({
                where: {
                    analysisStatus: "completed",
                    AND: [
                        // MUST have low energy
                        { energy: { lte: 0.45 } },
                        // MUST have moderate-slow tempo
                        { bpm: { lte: 110 } },
                        // Plus at least one additional mellow indicator
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

        // No fallback padding - if not enough truly mellow tracks, don't generate
        if (tracks.length < this.MIN_TRACKS_DAILY) {
            logger.debug(
                `[LATE NIGHT MIX] FAILED: Only ${tracks.length} tracks (need ${this.MIN_TRACKS_DAILY})`
            );
            return null;
        }

        const seed = getSeededRandom(`late-night-${today}`);
        let random = seed;
        const shuffled = tracks.sort(() => {
            random = (random * 9301 + 49297) % 233280;
            return random / 233280 - 0.5;
        });

        // Determine if daily or weekly based on available tracks
        const isWeekly = tracks.length >= this.MIN_TRACKS_WEEKLY;
        const trackLimit = isWeekly
            ? this.WEEKLY_TRACK_LIMIT
            : this.DAILY_TRACK_LIMIT;
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

    /**
     * Generate "Happy Vibes" mix using audio analysis
     * Enhanced mode: Uses ML moodHappy prediction
     * Standard mode: Uses valence/energy heuristics
     */
    async generateHappyMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Enhanced mode - ML moodHappy prediction
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

        // Strategy 2: Standard mode fallback - valence/energy heuristics
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

        // Strategy 2: Fallback to upbeat/happy genres (using helper for proper JSON array handling)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Melancholy" mix using audio analysis
     * Enhanced mode: Uses ML moodSad prediction
     * Standard mode: Uses valence heuristics + minor key
     */
    async generateMelancholyMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Enhanced mode - ML moodSad prediction
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
            // Strategy 2: Standard mode fallback
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

            // Further filter: prefer minor key OR sad mood tags
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

        // Strategy 2: Fallback to sad/emotional genres (using helper for proper JSON array handling)
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

        // Require minimum 15 tracks for a meaningful playlist
        if (tracks.length < 15) {
            logger.debug(
                `[MELANCHOLY MIX] FAILED: Only ${tracks.length} tracks found`
            );
            return null;
        }

        // Score and sort by "melancholy-ness" (only for tracks with audio analysis)
        const sortedTracks = tracks.sort((a, b) => {
            // Lower valence = more melancholy (score should be lower = better)
            const aScore =
                (a.valence || 0.5) * 2 + // Valence is primary factor
                (a.energy || 0.5) + // Lower energy is better
                (a.keyScale === "minor" ? 0 : 0.3); // Minor key bonus
            const bScore =
                (b.valence || 0.5) * 2 +
                (b.energy || 0.5) +
                (b.keyScale === "minor" ? 0 : 0.3);
            return aScore - bScore;
        });

        const seed = getSeededRandom(`melancholy-${today}`);
        let random = seed;
        // Take top 50 most melancholy tracks, then shuffle
        const shuffled = sortedTracks.slice(0, 50).sort(() => {
            random = (random * 9301 + 49297) % 233280;
            return random / 233280 - 0.5;
        });

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Dance Floor" mix using audio analysis
     * Criteria: danceability >= 0.7, BPM 110-140
     * Fallback: dance/electronic genres if no audio analysis
     */
    async generateDanceFloorMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
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

        // Strategy 2: Fallback to dance genres (using helper for proper JSON array handling)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Acoustic Afternoon" mix using audio analysis
     * Criteria: acousticness >= 0.6, energy 0.3-0.6
     * Fallback: acoustic/folk/singer-songwriter genres
     */
    async generateAcousticMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
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

        // Strategy 2: Fallback to acoustic genres (using helper for proper JSON array handling)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Instrumental Focus" mix using audio analysis
     * Criteria: instrumentalness >= 0.7, energy 0.3-0.6
     * Fallback: instrumental/classical/soundtrack genres
     */
    async generateInstrumentalMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Audio analysis
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

        // Strategy 2: Fallback to instrumental genres (using helper for proper JSON array handling)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    // ============================================================
    // LAST.FM TAG-BASED MIXES
    // ============================================================

    /**
     * Generate mix based on Last.fm mood tags
     */
    async generateMoodTagMix(
        userId: string,
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    /**
     * Generate "Road Trip" mix - using tags
     */
    async generateRoadTripMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        let tracks: any[] = [];

        // Strategy 1: Last.fm/mood tags
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

        // Strategy 2: Audio analysis (medium-high energy, good tempo)
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

        // Strategy 3: Fallback to upbeat rock/pop genres (using helper for proper JSON array handling)
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

        const selectedTracks = shuffled.slice(0, this.TRACK_LIMIT);
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

    // ============================================================
    // DAY-OF-WEEK MIXES
    // ============================================================

    /**
     * Generate day-specific mix based on the current day
     */
    async generateDayMix(userId: string): Promise<ProgrammaticMix | null> {
        const dayOfWeek = new Date().getDay();
        const today = new Date().toISOString().split("T")[0];

        // Different vibes for different days
        switch (dayOfWeek) {
            case 0: // Sunday - Relaxed
                return this.generateSundayMix(userId, today);
            case 1: // Monday - Motivation
                return this.generateMondayMix(userId, today);
            case 5: // Friday - Party
                return this.generateFridayMix(userId, today);
            default:
                return null;
        }
    }

    async generateSundayMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: {
                OR: [
                    {
                        analysisStatus: "completed",
                        energy: { lte: 0.5 },
                        acousticness: { gte: 0.5 },
                    },
                    {
                        lastfmTags: {
                            hasSome: [
                                "relaxed",
                                "calm",
                                "peaceful",
                                "chill",
                                "sunday",
                            ],
                        },
                    },
                ],
            },
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = randomSample(tracks, this.TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `sunday-${today}`,
            type: "sunday-morning",
            name: "Sunday Morning",
            description: "Peaceful tunes for a lazy Sunday",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("sunday-morning"),
        };
    }

    async generateMondayMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: {
                OR: [
                    {
                        analysisStatus: "completed",
                        energy: { gte: 0.6 },
                        valence: { gte: 0.5 },
                    },
                    {
                        lastfmTags: {
                            hasSome: [
                                "motivation",
                                "uplifting",
                                "energetic",
                                "happy",
                            ],
                        },
                    },
                ],
            },
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = randomSample(tracks, this.TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `monday-${today}`,
            type: "confidence-boost",
            name: "Monday Motivation",
            description: "Start your week with energy",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("confidence-boost"),
        };
    }

    async generateFridayMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: {
                OR: [
                    {
                        analysisStatus: "completed",
                        danceability: { gte: 0.7 },
                        energy: { gte: 0.6 },
                    },
                    {
                        lastfmTags: {
                            hasSome: ["party", "dance", "fun", "groovy"],
                        },
                    },
                ],
            },
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = randomSample(tracks, this.TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `friday-${today}`,
            type: "dance-floor",
            name: "Friday Night",
            description: "Weekend vibes to kick off the party",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("dance-floor"),
        };
    }

    // ============================================================
    // CURATED VIBE MIXES (Daily, 10 tracks)
    // These are "mood" mixes based on audio analysis and vibes
    // ============================================================

    /**
     * "Sad Girl Sundays" - Melancholic introspection
     * valence < 0.3 + keyScale = 'minor' + arousal < 0.4
     * Only available on Sundays
     */
    async generateSadGirlSundays(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Only generate on Sundays (day 0)
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Main Character Energy" - Walking through life like a movie
     * valence > 0.6 + energy > 0.6 + danceability > 0.5
     */
    async generateMainCharacterEnergy(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Villain Era" - Dark, empowering, dramatic
     * keyScale = 'minor' + energy > 0.7 + moodTags includes 'aggressive'
     */
    async generateVillainEra(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "3AM Thoughts" - Late night overthinking
     * arousal < 0.3 + energy < 0.4 + valence < 0.4
     */
    async generate3AMThoughts(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // STRICT criteria: truly late-night introspective tracks only
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

        if (tracks.length < this.MIN_TRACKS_DAILY) return null;

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Hot Girl Walk" - Confident, upbeat cardio
     * danceability > 0.7 + bpm 100-130 + energy > 0.6
     */
    async generateHotGirlWalk(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Rage Cleaning" - Aggressive productivity
     * energy > 0.8 + arousal > 0.7 + bpm > 130
     */
    async generateRageCleaning(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Golden Hour" - Warm, hopeful, sunset vibes
     * valence > 0.5 + acousticness > 0.4 + energy 0.3-0.6
     */
    async generateGoldenHour(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Shower Karaoke" - Belters you can't help but sing
     * instrumentalness < 0.3 + energy > 0.6 + valence > 0.5
     */
    async generateShowerKaraoke(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "In My Feelings" - Deep emotional processing
     * valence < 0.35 + arousal < 0.5 + acousticness > 0.3
     */
    async generateInMyFeelings(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Midnight Drive" - Cruising at night, contemplative
     * energy 0.4-0.6 + arousal 0.3-0.5 + bpm 90-120
     */
    async generateMidnightDrive(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // STRICT criteria: contemplative driving music only
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    // MUST be moderate energy (not too mellow, not too intense)
                    { energy: { gte: 0.3, lte: 0.65 } },
                    // MUST have cruising tempo
                    { bpm: { gte: 80, lte: 130 } },
                    // Plus mellow mood indicator
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

        if (tracks.length < this.MIN_TRACKS_DAILY) return null;

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Coffee Shop Vibes" - Cozy background energy
     * acousticness > 0.5 + energy 0.2-0.5 + instrumentalness > 0.3
     */
    async generateCoffeeShopVibes(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // STRICT criteria: cozy, background-appropriate music only
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    // MUST be low-to-moderate energy
                    { energy: { lte: 0.55 } },
                    // MUST be moderate-slow tempo
                    { bpm: { lte: 120 } },
                    // Plus at least one cozy indicator
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

        if (tracks.length < this.MIN_TRACKS_DAILY) return null;

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Romanticize Your Life" - Dreamy, aesthetic moments
     * valence 0.4-0.7 + arousal 0.3-0.6 + acousticness > 0.3
     */
    async generateRomanticizeYourLife(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "That Girl Era" - Self-improvement anthem energy
     * valence > 0.6 + energy > 0.5 + danceability > 0.5
     */
    async generateThatGirlEra(
        userId: string,
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    /**
     * "Unhinged" - Chaotic, weird, fun
     * High variance in features, unexpected combinations
     */
    async generateUnhinged(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Get a variety of tracks with extreme features
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

        const shuffled = randomSample(tracks, this.DAILY_TRACK_LIMIT);
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

    // ============================================================
    // WEEKLY CURATED MIXES (20 tracks)
    // ============================================================

    /**
     * "Deep Cuts" - Hidden gems from your library
     * Tracks with playCount < 3 from artists you play often
     */
    async generateDeepCuts(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Get tracks that haven't been played much
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
            // Fallback: tracks with few plays
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

            const shuffled = randomSample(filtered, this.WEEKLY_TRACK_LIMIT);
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

        const shuffled = randomSample(tracks, this.WEEKLY_TRACK_LIMIT);
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

    /**
     * "Key Journey" - Harmonic progression
     * Tracks ordered by circle of fifths key progression
     */
    async generateKeyJourney(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Circle of fifths order
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

        // Group by key
        const byKey = new Map<string, typeof tracks>();
        for (const track of tracks) {
            const key = track.key || "C";
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key)!.push(track);
        }

        // Build a journey through keys
        const journey: typeof tracks = [];
        const seed = getSeededRandom(`key-journey-${today}`);
        let seedVal = seed;

        for (const key of keyOrder) {
            const keyTracks = byKey.get(key) || [];
            if (
                keyTracks.length > 0 &&
                journey.length < this.WEEKLY_TRACK_LIMIT
            ) {
                // Pick 1-2 tracks from each key
                const count = Math.min(
                    2,
                    keyTracks.length,
                    this.WEEKLY_TRACK_LIMIT - journey.length
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

    /**
     * "Tempo Flow" - Energy arc throughout
     * Start low BPM, build to peak, come down
     */
    async generateTempoFlow(
        userId: string,
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

        // Sort by BPM
        const sorted = [...tracks].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));

        // Build an arc: slow → fast → slow
        const slow = sorted.filter((t) => (t.bpm || 0) < 100);
        const medium = sorted.filter(
            (t) => (t.bpm || 0) >= 100 && (t.bpm || 0) < 130
        );
        const fast = sorted.filter((t) => (t.bpm || 0) >= 130);

        const flow: typeof tracks = [];

        // Intro: 4 slow tracks
        flow.push(...randomSample(slow, Math.min(4, slow.length)));
        // Build: 4 medium tracks
        flow.push(...randomSample(medium, Math.min(5, medium.length)));
        // Peak: 5 fast tracks
        flow.push(...randomSample(fast, Math.min(6, fast.length)));
        // Cool down: 3 medium tracks
        flow.push(
            ...randomSample(
                medium.filter((t) => !flow.includes(t)),
                Math.min(3, medium.length)
            )
        );
        // Outro: 3 slow tracks
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
            trackIds: flow.slice(0, this.WEEKLY_TRACK_LIMIT).map((t) => t.id),
            coverUrls,
            trackCount: Math.min(flow.length, this.WEEKLY_TRACK_LIMIT),
            color: getMixColor("workout"),
        };
    }

    /**
     * "Vocal Detox" - Pure instrumental escape
     * instrumentalness > 0.8 + variety of moods
     */
    async generateVocalDetox(
        userId: string,
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

        const shuffled = randomSample(tracks, this.WEEKLY_TRACK_LIMIT);
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

    /**
     * "Minor Key Mondays" - All minor key bangers
     * keyScale = 'minor' + energy > 0.5
     * Only available on Mondays
     */
    async generateMinorKeyMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Only generate on Mondays (day 1)
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

        const shuffled = randomSample(tracks, this.WEEKLY_TRACK_LIMIT);
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

    // ============================================================
    // MOOD ON DEMAND - Generate a mix based on specific criteria
    // ============================================================

    /**
     * Generate a custom mood mix based on audio feature parameters
     * Supports both basic audio features and ML mood predictions
     */
    async generateMoodOnDemand(
        userId: string,
        params: {
            // Basic audio features
            valence?: { min?: number; max?: number };
            energy?: { min?: number; max?: number };
            danceability?: { min?: number; max?: number };
            acousticness?: { min?: number; max?: number };
            instrumentalness?: { min?: number; max?: number };
            arousal?: { min?: number; max?: number };
            bpm?: { min?: number; max?: number };
            keyScale?: "major" | "minor";
            // ML mood predictions (require Enhanced mode analysis)
            moodHappy?: { min?: number; max?: number };
            moodSad?: { min?: number; max?: number };
            moodRelaxed?: { min?: number; max?: number };
            moodAggressive?: { min?: number; max?: number };
            moodParty?: { min?: number; max?: number };
            moodAcoustic?: { min?: number; max?: number };
            moodElectronic?: { min?: number; max?: number };
            limit?: number;
        }
    ): Promise<ProgrammaticMix | null> {
        const where: any = {
            analysisStatus: "completed",
        };

        // Check if any ML mood params are being used
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

        // First, check how many enhanced tracks we have
        let useEnhancedMode = false;
        if (usesMLMoods) {
            const enhancedCount = await prisma.track.count({
                where: {
                    analysisStatus: "completed",
                    analysisMode: "enhanced",
                },
            });

            // Only require enhanced mode if we have at least 15 enhanced tracks
            if (enhancedCount >= 15) {
                where.analysisMode = "enhanced";
                useEnhancedMode = true;
            } else {
                // Not enough enhanced tracks - convert ML mood params to basic audio feature equivalents
                logger.debug(
                    `[MoodMixer] Only ${enhancedCount} enhanced tracks, falling back to basic features`
                );

                // Map ML moods to basic audio features for fallback
                // This provides approximate matching when enhanced mode isn't available
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
                // Clear the ML mood params since we're falling back
                delete params.moodHappy;
                delete params.moodSad;
                delete params.moodRelaxed;
                delete params.moodAggressive;
                delete params.moodParty;
                delete params.moodAcoustic;
                delete params.moodElectronic;
            }
        }

        // Basic audio feature filters - merge with any existing from fallback
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

        // ML mood prediction filters
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
}

export const programmaticPlaylistService = new ProgrammaticPlaylistService();
