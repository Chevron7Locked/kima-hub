import { prisma } from "../../utils/db";

export interface ProgrammaticMix {
    id: string;
    type: string;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
}

// Research-based color psychology for mix vibes
// Using actual CSS rgba values for inline styles (Tailwind classes get purged at build time)
export const MIX_COLORS: Record<string, string> = {
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

export function getMixColor(type: string): string {
    return MIX_COLORS[type] || MIX_COLORS["default"];
}

export function randomSample<T>(array: T[], count: number): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result.slice(0, count);
}

export function getSeededRandom(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        const char = seed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

export type TrackWithAlbumCover = {
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
export async function findTracksByGenrePatterns(
    genrePatterns: string[],
    limit: number = 100
): Promise<TrackWithAlbumCover[]> {
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
        take: limit * 3,
    });

    const genreMatched = albumTracks.filter((t) => {
        const albumGenres = t.album.genres as string[] | null;
        const albumUserGenres = (t.album.userGenres as string[] | null) || [];
        const artistUserGenres =
            (t.album.artist?.userGenres as string[] | null) || [];

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

    const existingIds = new Set(tracks.map((t) => t.id));
    const merged = [
        ...tracks,
        ...genreMatched.filter((t) => !existingIds.has(t.id)),
    ];

    return merged.slice(0, limit) as TrackWithAlbumCover[];
}
