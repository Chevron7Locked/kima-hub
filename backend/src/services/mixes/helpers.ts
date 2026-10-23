import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import { shuffleArray } from "../../utils/shuffle";

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

export function getMixColor(type: string): string {
    return MIX_COLORS[type] || MIX_COLORS["default"];
}

export function randomSample<T>(array: T[], count: number): T[] {
    return shuffleArray(array).slice(0, count);
}

/** Tracks in a finished generated mix. */
export const TRACK_LIMIT = 20;

/** `current` plus those of `more` whose ids it lacks. */
export function mergeNewById<T extends { id: string }>(current: T[], more: T[]): T[] {
    const ids = new Set(current.map((t) => t.id));
    return [...current, ...more.filter((t) => !ids.has(t.id))];
}

/** Up to four album covers, in track order, for a mix's cover mosaic. */
export function albumCoverUrls(
    tracks: { album: { coverUrl: string | null } }[]
): string[] {
    return tracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);
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


/**
 * Deterministic Fisher-Yates shuffle using getSeededRandom's LCG; unbiased,
 * unlike sorting with a random comparator.
 */
export function seededShuffle<T>(array: T[], seed: number): T[] {
    const result = [...array];
    let random = seed;
    for (let i = result.length - 1; i > 0; i--) {
        random = (random * 9301 + 49297) % 233280;
        const j = Math.floor((random / 233280) * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
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
    essentiaGenres?: string[];
    [key: string]: unknown;
};

interface MixSpec {
    id: string;
    type: string;
    name: string;
    description: string;
    /** Key into the mix colour table. */
    colorType: string;
    /** Makes the draw repeatable: the same seed gives the same tracks. */
    seed?: number;
}

/** A mix of `limit` randomly sampled tracks. */
export function sampleMix(
    spec: MixSpec,
    tracks: { id: string; album: { coverUrl: string | null } }[],
    limit: number
): ProgrammaticMix {
    const sample =
        spec.seed === undefined
            ? randomSample(tracks, limit)
            : seededShuffle(tracks, spec.seed).slice(0, limit);

    return {
        id: spec.id,
        type: spec.type,
        name: spec.name,
        description: spec.description,
        trackIds: sample.map((t) => t.id),
        coverUrls: albumCoverUrls(sample),
        trackCount: sample.length,
        color: getMixColor(spec.colorType),
    };
}

/** A draw of zero or a negative count would slice from the end and hand back most of the set. */
function assertTake(take: number): void {
    if (!Number.isInteger(take) || take < 1) throw new RangeError(`take must be a positive integer, got ${take}`);
}

/**
 * Up to `take` of `ids`, drawn uniformly at random. With a `seed` the draw is
 * repeatable for the same `ids` in the same order.
 */
export function drawIds(ids: string[], take: number, seed?: number): string[] {
    assertTake(take);
    const shuffled = seed === undefined ? shuffleArray(ids) : seededShuffle(ids, seed);
    return shuffled.slice(0, take);
}

/**
 * Up to `take` items drawn at random without replacement, each more likely the
 * larger its weight: every item gets the key -ln(U) / weight with U uniform in
 * (0, 1], and the smallest keys win (Efraimidis and Spirakis 2006, "Weighted
 * random sampling with a reservoir"). An item whose weight is zero, negative
 * or not a finite number is never drawn, so fewer than `take` come back when
 * fewer than `take` items have a positive weight.
 */
export function drawWeighted<T>(items: T[], weightOf: (item: T) => number, take: number): T[] {
    assertTake(take);
    const keyed: { item: T; key: number }[] = [];
    for (const item of items) {
        const weight = weightOf(item);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        keyed.push({ item, key: -Math.log(1 - Math.random()) / weight });
    }
    keyed.sort((a, b) => a.key - b.key);
    return keyed.slice(0, take).map((k) => k.item);
}

/** The tracks with these ids, in the order of `ids`. */
export async function tracksByIds<I extends Prisma.TrackInclude>(
    ids: string[],
    include: I
): Promise<Prisma.TrackGetPayload<{ include: I }>[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.track.findMany({ where: { id: { in: ids } }, include });
    const byId = new Map(rows.map((t) => [t.id, t]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Ids of up to `take` tracks drawn uniformly at random from every track
 * matching `where`, not from the first rows the database returns. Ids are read
 * in id order so a `seed` gives the same draw each time.
 */
export async function sampleTrackIds(args: {
    where: Prisma.TrackWhereInput;
    take: number;
    seed?: number;
}): Promise<string[]> {
    assertTake(args.take);
    const rows = await prisma.track.findMany({
        where: args.where,
        select: { id: true },
        orderBy: { id: "asc" },
    });
    return drawIds(
        rows.map((r) => r.id),
        args.take,
        args.seed
    );
}

/**
 * Ids of every track no user has played, in id order. Written as an anti-join
 * because Prisma's `plays: { none: {} }` becomes `id NOT IN (SELECT trackId
 * FROM Play)`, which Postgres runs as a rescan of Play for every track once
 * Play is too large to hash (about a minute and a half at 50,000 tracks and
 * 105,000 plays). `excludeMissing` leaves out tracks whose file is missing and
 * `excludeCorrupt` tracks marked corrupt; both together are the PLAYABLE rule.
 */
export async function unplayedTrackIds(
    args: { excludeMissing?: boolean; excludeCorrupt?: boolean } = {}
): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id
        FROM "Track" t
        WHERE NOT EXISTS (SELECT 1 FROM "Play" p WHERE p."trackId" = t.id)
          AND (${!args.excludeMissing} OR t."missingSince" IS NULL)
          AND (${!args.excludeCorrupt} OR t.corrupt = false)
        ORDER BY t.id
    `;
    return rows.map((r) => r.id);
}

/**
 * Up to `take` tracks drawn uniformly at random from every track matching
 * `where`. Only ids are read for the whole match; full rows are read for the
 * draw.
 */
export async function sampleTracks<I extends Prisma.TrackInclude>(args: {
    where: Prisma.TrackWhereInput;
    include: I;
    take: number;
    seed?: number;
}): Promise<Prisma.TrackGetPayload<{ include: I }>[]> {
    return tracksByIds(await sampleTrackIds(args), args.include);
}

/** A sampled mix of the tracks that match a filter, or null when too few do. */
export async function sampledMix(
    spec: MixSpec & {
        where: Prisma.TrackWhereInput;
        /** How many matching tracks to draw before sampling. */
        take: number;
        /** Fewest drawn tracks that still make a mix. */
        minTracks: number;
        /** Tracks in the finished mix. */
        limit: number;
    }
): Promise<ProgrammaticMix | null> {
    const tracks = await sampleTracks({
        where: spec.where,
        include: { album: { select: { coverUrl: true } } },
        take: spec.take,
        seed: spec.seed,
    });

    if (tracks.length < spec.minTracks) return null;

    return sampleMix(spec, tracks, spec.limit);
}

const WITH_ALBUM_GENRES = {
    album: {
        select: {
            coverUrl: true,
            genres: true,
            userGenres: true,
            artist: { select: { userGenres: true } },
        },
    },
} satisfies Prisma.TrackInclude;

/**
 * Tracks matching genre patterns: the Genre/TrackGenre tables first, then
 * album.genres and user genres in memory for tracks the tables lack.
 */
export async function findTracksByGenrePatterns(
    genrePatterns: string[],
    limit: number = 100,
    seed?: number
): Promise<TrackWithAlbumCover[]> {
    const genreRows = await prisma.genre.findMany({
        where: {
            name: { in: genrePatterns, mode: "insensitive" },
        },
        select: { id: true },
    });

    const tracks =
        genreRows.length === 0
            ? []
            : await sampleTracks({
                  where: {
                      ...NOT_MISSING,
                      trackGenres: {
                          some: {
                              genreId: { in: genreRows.map((g) => g.id) },
                          },
                      },
                  },
                  include: WITH_ALBUM_GENRES,
                  take: limit,
                  seed,
              });

    if (tracks.length >= 15) {
        return tracks as TrackWithAlbumCover[];
    }

    const genreMatchedIds = (
        await prisma.$queryRaw<{ id: string }[]>`
            SELECT t.id
            FROM "Track" t
            JOIN "Album" a ON a.id = t."albumId"
            LEFT JOIN "Artist" ar ON ar.id = a."artistId"
            WHERE t."missingSince" IS NULL
              AND (a.genres IS NOT NULL OR a."userGenres" IS NOT NULL)
              AND EXISTS (
                SELECT 1
                FROM unnest(${genrePatterns}::text[]) AS p(pattern)
                CROSS JOIN LATERAL (
                  SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.genres) = 'array' THEN a.genres ELSE '[]'::jsonb END)
                  UNION ALL
                  SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(a."userGenres") = 'array' THEN a."userGenres" ELSE '[]'::jsonb END)
                  UNION ALL
                  SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(ar."userGenres") = 'array' THEN ar."userGenres" ELSE '[]'::jsonb END)
                ) AS g(genre)
                WHERE strpos(lower(g.genre), lower(p.pattern)) > 0
              )
            ORDER BY t.id
        `
    ).map((r) => r.id);

    const genreMatched = await tracksByIds(
        drawIds(genreMatchedIds, limit * 3, seed),
        WITH_ALBUM_GENRES
    );

    const merged = mergeNewById(tracks, genreMatched);

    return merged.slice(0, limit) as TrackWithAlbumCover[];
}
