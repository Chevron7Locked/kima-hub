import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
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
 * The key a seeded draw ranks an id by: the MD5 of the seed and the id, as hex. Uniform is all a draw needs, and MD5 is
 * the cheapest hash Postgres and Node both have, so seededKeySql ranks rows in the database exactly as this ranks them
 * here. One seed gives one order whatever order the ids come in, and an id joining or leaving moves no other, so a draw
 * that takes the first n changes by at most one song when one song joins or leaves the candidates.
 */
export function seededKey(seed: number | string, id: string): string {
    // createHash, not the one-shot crypto.hash, which Node 20 lacks before 20.12; the split stack builds on node:20-slim.
    return crypto.createHash("md5").update(`${seed}:${id}`).digest("hex");
}

/** seededKey in SQL for an id column, compared byte by byte as JavaScript compares the hex strings. */
export function seededKeySql(seed: number | string, id: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`md5(${String(seed)} || ':' || ${id}) COLLATE "C"`;
}

/** `items` in the order of their seededKey. For short lists; a draw of the first few is seededTake. */
export function seededOrder<T>(items: T[], seed: number | string, idOf: (item: T) => string): T[] {
    return items
        .map((item) => ({ item, key: seededKey(seed, idOf(item)) }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((ranked) => ranked.item);
}

/**
 * The first `take` of seededOrder(items, seed, idOf), kept in a heap of `take` instead of sorting the whole list. It
 * still hashes every item on the event loop, so a list as long as the library is drawn in the database instead
 * (seededTrackIds).
 */
export function seededTake<T>(items: T[], seed: number | string, idOf: (item: T) => string, take: number): T[] {
    // A max-heap on the key: the root is the largest of the smallest `take` seen so far.
    const heap: { item: T; key: string }[] = [];
    const swap = (i: number, j: number) => ([heap[i], heap[j]] = [heap[j], heap[i]]);
    for (const item of items) {
        const key = seededKey(seed, idOf(item));
        if (heap.length < take) {
            heap.push({ item, key });
            for (let i = heap.length - 1; i > 0 && heap[(i - 1) >> 1].key < heap[i].key; i = (i - 1) >> 1) swap(i, (i - 1) >> 1);
        } else if (key < heap[0].key) {
            heap[0] = { item, key };
            for (let i = 0; ; ) {
                const l = 2 * i + 1;
                const r = l + 1;
                let top = i;
                if (l < heap.length && heap[l].key > heap[top].key) top = l;
                if (r < heap.length && heap[r].key > heap[top].key) top = r;
                if (top === i) break;
                swap(i, top);
                i = top;
            }
        }
    }
    return heap.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((ranked) => ranked.item);
}

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
            : seededTake(tracks, spec.seed, (t) => t.id, limit);

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
 * repeatable whatever order `ids` come in, and an id joining or leaving changes
 * at most one pick (seededTake).
 */
export function drawIds(ids: string[], take: number, seed?: number): string[] {
    assertTake(take);
    return seed === undefined ? shuffleArray(ids).slice(0, take) : seededTake(ids, seed, (id) => id, take);
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
 * matching `where`, not from the first rows the database returns. A draw that
 * must repeat for a day is seededTrackIds.
 */
export async function sampleTrackIds(args: {
    where: Prisma.TrackWhereInput;
    take: number;
}): Promise<string[]> {
    assertTake(args.take);
    const rows = await prisma.track.findMany({
        where: args.where,
        select: { id: true },
        orderBy: { id: "asc" },
    });
    return drawIds(
        rows.map((r) => r.id),
        args.take
    );
}

/**
 * Ids of up to `take` tracks whose file is there and that match `where`, a condition on "Track" t and its "Album" a,
 * ranked by seededKeySql: the draw drawIds(every matching id, take, seed) makes, picked in the database, so neither the
 * matching ids nor their hashing reach the server's event loop however large the library.
 */
export async function seededTrackIds(where: Prisma.Sql, take: number, seed: number): Promise<string[]> {
    assertTake(take);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id
        FROM "Track" t
        JOIN "Album" a ON a.id = t."albumId"
        WHERE t."missingSince" IS NULL AND ${where}
        ORDER BY ${seededKeySql(seed, Prisma.sql`t.id`)}
        LIMIT ${take}
    `;
    return rows.map((r) => r.id);
}

/** The tracks of seededTrackIds, in the order drawn. */
export async function seededTracks<I extends Prisma.TrackInclude>(args: {
    where: Prisma.Sql;
    include: I;
    take: number;
    seed: number;
}): Promise<Prisma.TrackGetPayload<{ include: I }>[]> {
    return tracksByIds(await seededTrackIds(args.where, args.take, args.seed), args.include);
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
}): Promise<Prisma.TrackGetPayload<{ include: I }>[]> {
    return tracksByIds(await sampleTrackIds(args), args.include);
}

/** A mix drawn for the day from the tracks that match a filter (seededTrackIds), or null when too few do. */
export async function sampledMix(
    spec: MixSpec & {
        seed: number;
        where: Prisma.Sql;
        /** How many matching tracks to draw before sampling. */
        take: number;
        /** Fewest drawn tracks that still make a mix. */
        minTracks: number;
        /** Tracks in the finished mix. */
        limit: number;
    }
): Promise<ProgrammaticMix | null> {
    const tracks = await seededTracks({
        where: spec.where,
        include: { album: { select: { coverUrl: true } } },
        take: spec.take,
        seed: spec.seed,
    });

    if (tracks.length < spec.minTracks) return null;

    return sampleMix(spec, tracks, spec.limit);
}
