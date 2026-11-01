import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { shuffleArray } from "../../utils/shuffle";
import { LIBRARY_PLAYABLE } from "../../utils/libraryEligibility";
import { ARTIST_CAPS, MIN_MIX_TRACKS, artistSql, capByArtist, songArtistKey } from "./artistCap";

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

/** Each mix type's background, as inline CSS. */
const MIX_COLORS: Record<string, string> = {
    // Night
    "late-night":
        "linear-gradient(to bottom, rgba(30, 27, 75, 0.7), rgba(30, 58, 138, 0.5), rgba(15, 23, 42, 0.4))",
    "3am-thoughts":
        "linear-gradient(to bottom, rgba(46, 16, 101, 0.7), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "night-drive":
        "linear-gradient(to bottom, rgba(15, 23, 42, 0.7), rgba(49, 46, 129, 0.5), rgba(88, 28, 135, 0.4))",

    // Calm
    chill: "linear-gradient(to bottom, rgba(17, 94, 89, 0.6), rgba(22, 78, 99, 0.5), rgba(15, 23, 42, 0.4))",
    "coffee-shop":
        "linear-gradient(to bottom, rgba(120, 53, 15, 0.6), rgba(68, 64, 60, 0.5), rgba(38, 38, 38, 0.4))",
    "sunday-morning":
        "linear-gradient(to bottom, rgba(253, 186, 116, 0.4), rgba(252, 211, 77, 0.3), rgba(68, 64, 60, 0.4))",

    // Energy
    workout:
        "linear-gradient(to bottom, rgba(153, 27, 27, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    "confidence-boost":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(68, 64, 60, 0.4))",

    // Happy
    happy: "linear-gradient(to bottom, rgba(217, 119, 6, 0.5), rgba(161, 98, 7, 0.4), rgba(68, 64, 60, 0.4))",
    "summer-vibes":
        "linear-gradient(to bottom, rgba(8, 145, 178, 0.5), rgba(15, 118, 110, 0.4), rgba(30, 58, 138, 0.4))",
    "golden-hour":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(234, 88, 12, 0.4), rgba(136, 19, 55, 0.4))",

    // Sad
    melancholy:
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(30, 58, 138, 0.5), rgba(17, 24, 39, 0.4))",
    "sad-girl-sundays":
        "linear-gradient(to bottom, rgba(136, 19, 55, 0.5), rgba(30, 41, 59, 0.5), rgba(59, 7, 100, 0.4))",
    "heartbreak-hotel":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",

    // Dance
    "dance-floor":
        "linear-gradient(to bottom, rgba(162, 28, 175, 0.6), rgba(131, 24, 67, 0.5), rgba(59, 7, 100, 0.4))",

    // Acoustic
    acoustic:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",

    // Focus
    instrumental:
        "linear-gradient(to bottom, rgba(91, 33, 182, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    "focus-flow":
        "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(30, 41, 59, 0.5), rgba(17, 24, 39, 0.4))",

    // Road trip
    "road-trip":
        "linear-gradient(to bottom, rgba(194, 65, 12, 0.6), rgba(146, 64, 14, 0.5), rgba(14, 165, 233, 0.4))",

    // Character
    "main-character":
        "linear-gradient(to bottom, rgba(245, 158, 11, 0.5), rgba(202, 138, 4, 0.4), rgba(124, 45, 18, 0.4))",
    "villain-era":
        "linear-gradient(to bottom, rgba(69, 10, 10, 0.7), rgba(17, 24, 39, 0.6), rgba(0, 0, 0, 0.5))",

    // Nostalgia
    throwback:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.5), rgba(124, 45, 18, 0.4), rgba(68, 64, 60, 0.4))",

    // Genre, era and the listener's own plays
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

    // The mood pages' mixes (moodBucketService MOODS ids); happy and chill share the colours above.
    sad: "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    party: "linear-gradient(to bottom, rgba(162, 28, 175, 0.6), rgba(131, 24, 67, 0.5), rgba(59, 7, 100, 0.4))",
    aggressive: "linear-gradient(to bottom, rgba(69, 10, 10, 0.7), rgba(17, 24, 39, 0.6), rgba(0, 0, 0, 0.5))",

    // Any other type
    default:
        "linear-gradient(to bottom, rgba(88, 28, 135, 0.4), rgba(26, 26, 26, 1), transparent)",
};

export function getMixColor(type: string): string {
    return MIX_COLORS[type] || MIX_COLORS["default"];
}

/** Tracks in a finished generated mix. */
export const TRACK_LIMIT = 20;

/** Up to four different album covers, in track order, for a mix's cover mosaic. */
export function albumCoverUrls(
    tracks: { album: { coverUrl: string | null } }[]
): string[] {
    return [...new Set(tracks.map((t) => t.album.coverUrl).filter((url): url is string => !!url))].slice(0, 4);
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
    return crypto.createHash("md5").update(`${seed}:${id}`).digest("hex");
}

/** seededKey in SQL for an id column, compared byte by byte as JavaScript compares the hex strings. */
export function seededKeySql(seed: number | string, id: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`md5(${String(seed)} || ':' || ${id}) COLLATE "C"`;
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** `items` in the order of their seededKey. For short lists; a draw of the first few is seededTake. */
export function seededOrder<T>(items: T[], seed: number | string, idOf: (item: T) => string): T[] {
    return items
        .map((item) => ({ item, key: seededKey(seed, idOf(item)) }))
        .sort(byKey)
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
    return heap.sort(byKey).map((ranked) => ranked.item);
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

/** A song as a drawn mix reads it: its album's cover and the artist the per-artist cap counts. */
export const MIX_SONG_ALBUM = { select: { coverUrl: true, artistId: true, artist: { select: { identityKey: true } } } } as const;

type MixSong = { id: string; album: { coverUrl: string | null; artistId: string; artist: { identityKey: string } } };

/** Up to `limit` of `ordered`, in that order, at most 2 per artist (capByArtist). */
function cappedByArtist<T extends MixSong>(ordered: T[], limit: number): T[] {
    const byId = new Map(ordered.map((t) => [t.id, t]));
    const keyed = ordered.map((t) => ({ id: t.id, artistId: songArtistKey(t.id, t.album.artistId, t.album.artist.identityKey) }));
    return capByArtist(keyed, limit).map((id) => byId.get(id)!);
}

/** A mix of up to `limit` randomly drawn tracks, at most 2 per artist. */
export function sampleMix(spec: MixSpec, tracks: MixSong[], limit: number): ProgrammaticMix {
    const ordered = spec.seed === undefined ? shuffleArray(tracks) : seededOrder(tracks, spec.seed, (t) => t.id);
    return mixOf(spec, cappedByArtist(ordered, limit));
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
 * Every item with a positive, finite weight, in a random order where an item's chance of coming early grows with its
 * weight: each gets the key ln(u) / weight, u in (0, 1), and the highest keys come first (Efraimidis and Spirakis 2006,
 * "Weighted random sampling with a reservoir"); an item with twice the weight comes first about twice as often. With
 * `seeded`, u is a hash of the seed and the item's id, so the order is fixed for the seed; without, u is drawn afresh.
 */
export function weightedOrder<T>(
    items: T[],
    weightOf: (item: T) => number,
    seeded?: { seed: string; idOf: (item: T) => string },
): T[] {
    const keyed: { item: T; id: string; key: number }[] = [];
    for (const item of items) {
        const weight = weightOf(item);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const id = seeded ? seeded.idOf(item) : "";
        const u = seeded
            ? (parseInt(crypto.createHash("sha256").update(`${seeded.seed}\0${id}`).digest("hex").slice(0, 13), 16) + 0.5) / 2 ** 52
            : 1 - Math.random();
        keyed.push({ item, id, key: Math.log(u) / weight });
    }
    return keyed.sort((a, b) => b.key - a.key || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((k) => k.item);
}

/** Up to `take` items of a fresh weightedOrder: a weighted draw without replacement. */
export function drawWeighted<T>(items: T[], weightOf: (item: T) => number, take: number): T[] {
    assertTake(take);
    return weightedOrder(items, weightOf).slice(0, take);
}

/**
 * The playable library songs with these ids, in the order of `ids`: a song whose file is missing, that a scan marked
 * corrupt or whose album is a Discover suggestion is left out (Discover songs play only in Discover, whose own
 * playlist reads its albums directly, not through here).
 */
export async function tracksByIds<I extends Prisma.TrackInclude>(
    ids: string[],
    include: I
): Promise<Prisma.TrackGetPayload<{ include: I }>[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.track.findMany({ where: { id: { in: ids }, ...LIBRARY_PLAYABLE }, include });
    const byId = new Map(rows.map((t) => [t.id, t]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Ids of up to `take` library songs drawn uniformly at random from every one
 * matching `where`, not from the first rows the database returns. A draw that
 * must repeat for a day is seededTrackIds.
 */
export async function sampleTrackIds(args: {
    where: Prisma.TrackWhereInput;
    take: number;
}): Promise<string[]> {
    assertTake(args.take);
    const rows = await prisma.track.findMany({
        where: { AND: [args.where, LIBRARY_PLAYABLE] },
        select: { id: true },
        orderBy: { id: "asc" },
    });
    return drawIds(
        rows.map((r) => r.id),
        args.take
    );
}

/**
 * Ids of up to `take` library songs whose file is there and that match `where`, a condition on "Track" t and its "Album" a,
 * ranked by seededKeySql: the draw drawIds(every matching id, take, seed) makes, picked in the database, so neither the
 * matching ids nor their hashing reach the server's event loop however large the library.
 */
export async function seededTrackIds(where: Prisma.Sql, take: number, seed: number): Promise<string[]> {
    assertTake(take);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id
        FROM "Track" t
        JOIN "Album" a ON a.id = t."albumId"
        WHERE t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY' AND ${where}
        ORDER BY ${seededKeySql(seed, Prisma.sql`t.id`)}
        LIMIT ${take}
    `;
    return rows.map((r) => r.id);
}

/**
 * seededTrackIds over every match, at most 2 per artist (capByArtist's ladder: 3 when 2 leaves fewer than
 * MIN_MIX_TRACKS, or than `limit` if smaller, then no cap). Each artist's songs are numbered in the database in the
 * day's order, so only the first three of each artist reach the server, however large the match.
 */
async function seededCappedTrackIds(where: Prisma.Sql, limit: number, seed: number): Promise<string[]> {
    assertTake(limit);
    const key = seededKeySql(seed, Prisma.sql`t.id`);
    const rows = await prisma.$queryRaw<{ id: string; n: number }[]>`
        SELECT id, n FROM (
            SELECT t.id, ${key} AS k, row_number() OVER (PARTITION BY ${artistSql()} ORDER BY ${key})::int AS n
            FROM "Track" t
            JOIN "Album" a ON a.id = t."albumId"
            JOIN "Artist" ar ON ar.id = a."artistId"
            WHERE t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY' AND ${where}
        ) ranked
        WHERE n <= 3
        ORDER BY k
    `;
    for (const cap of ARTIST_CAPS) {
        if (cap === Infinity) break;
        const picked = rows.filter((r) => r.n <= cap).slice(0, limit).map((r) => r.id);
        if (picked.length >= Math.min(limit, MIN_MIX_TRACKS)) return picked;
    }
    return seededTrackIds(where, limit, seed);
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
 * Ids of every library song no user has played, in id order, as an anti-join: Prisma's `plays: { none: {} }` becomes
 * `NOT IN (SELECT ...)`, which Postgres rescans per track once Play is too large to hash (1.5 minutes at 105,000 plays).
 * `excludeMissing` and `excludeCorrupt` together are the PLAYABLE rule.
 */
export async function unplayedTrackIds(
    args: { excludeMissing?: boolean; excludeCorrupt?: boolean } = {}
): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id
        FROM "Track" t
        WHERE NOT EXISTS (SELECT 1 FROM "Play" p WHERE p."trackId" = t.id)
          AND EXISTS (SELECT 1 FROM "Album" a WHERE a.id = t."albumId" AND a.location = 'LIBRARY')
          AND (${!args.excludeMissing} OR t."missingSince" IS NULL)
          AND (${!args.excludeCorrupt} OR t.corrupt = false)
        ORDER BY t.id
    `;
    return rows.map((r) => r.id);
}

/**
 * A mix drawn for the day from the tracks that match a filter, at most 2 per artist (seededCappedTrackIds), or null when
 * fewer than `minTracks` match.
 */
export async function sampledMix(
    spec: MixSpec & {
        seed: number;
        where: Prisma.Sql;
        /** Fewest matching tracks that still make a mix. */
        minTracks: number;
        /** Tracks in the finished mix. */
        limit: number;
    }
): Promise<ProgrammaticMix | null> {
    const [{ matching }] = await prisma.$queryRaw<{ matching: number }[]>`
        SELECT count(*)::int AS matching FROM (
            SELECT 1 FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
            WHERE t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY' AND ${spec.where}
            LIMIT ${spec.minTracks}
        ) enough`;
    if (matching < spec.minTracks) return null;
    return mixOf(spec, await tracksByIds(await seededCappedTrackIds(spec.where, spec.limit, spec.seed), { album: MIX_SONG_ALBUM }));
}

/** A mix of `tracks`, in that order. */
export function mixOf(spec: MixSpec, tracks: { id: string; album: { coverUrl: string | null } }[]): ProgrammaticMix {
    return {
        id: spec.id,
        type: spec.type,
        name: spec.name,
        description: spec.description,
        trackIds: tracks.map((t) => t.id),
        coverUrls: albumCoverUrls(tracks),
        trackCount: tracks.length,
        color: getMixColor(spec.colorType),
    };
}
