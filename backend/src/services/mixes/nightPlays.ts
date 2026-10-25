/**
 * Night is a person's own habit, not a sound the mood heads can learn, so the Late Night station and mix and the
 * Midnight Drive mix play from what this listener actually plays after dark: their finished listens (`Play.heard`)
 * between NIGHT_START_HOUR and NIGHT_END_HOUR in their own time zone, whatever the songs' moods. Only that user's plays
 * count. The mood scores still carry a `night` column (the stored scores and statistics are unchanged, so nothing is
 * retrained) but no tag, recipe or definition uses it (moods/heads.ts RETIRED_MOODS).
 *
 * A listener with few night plays is a cold start. Under COLD_START_SONGS distinct night songs the list is filled with
 * songs that sound like their own night plays (the vibe similarity every similar-song feature uses, weighted by how
 * often each was played), and with no night plays at all, or no similarity data, with the recipe the station and mix
 * have always had, now without the night part (calm, low energy, groovy, sexy; for Midnight Drive its driving recipe).
 * A library with no mood statistics yet falls back to its playable songs, so the station never answers empty while the
 * library has songs.
 */
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { matchingContext, rankMatches } from "../matching/rank";
import { safeZone } from "../stats/listening";
import type { ProgrammaticMix } from "./helpers";
import { mixFromTracks, type RecipeMixSpec } from "./recipeMix";
import {
    MIN_MIX_TRACKS,
    PACE_SQL,
    UnrankableLibraryError,
    artistSql,
    capByArtist,
    drawMembers,
    getRecipe,
    recipeMembers,
    seededOrder,
} from "./recipes";
import { TRACK_LIMIT } from "./helpers";
import { FAMILIAR_SEEDS } from "./familiarity";
import { stationPage, type StationPage, type StationRequest, type StationSong } from "./stationOrder";

/** A play counts as night from this local hour (inclusive) ... */
export const NIGHT_START_HOUR = 22;
/** ... until this local hour (exclusive), so 22:00 to 03:59. */
export const NIGHT_END_HOUR = 4;
/** Fewer distinct night songs than this is a cold start: the list is filled with similar songs. */
export const COLD_START_SONGS = 30;
/**
 * How many songs a cold-start station holds: one page of the radio route (100), so a listener with five night plays
 * does not hear the same five come round. Songs that are the listener's own come first and are never dropped.
 */
export const STATION_FILL = 100;
/**
 * Only plays this recent count as night plays. A habit is read from the recent past, and the bound lets the database
 * use the (user, play time) index instead of reading every play the user has ever made (years of them, for some).
 */
export const NIGHT_LOOKBACK_DAYS = 365;

/** A song the listener played at night, with how often. */
export interface NightSong extends StationSong {
    plays: number;
    /** 1 if the song's tempo (double or half counts) is inside the pace band on a steady beat, 0 if outside, else 0.5. */
    pace: number;
    /** 1 if its energy is in the middle half of the library, 0 outside, 0.5 when it has no energy reading. */
    energy: number;
}

/**
 * The time zone night is read in: the one the app sent when it is a real zone; otherwise the server's own, because
 * Kima keeps no time zone per user (mixDay.ts does the same for the day of a mix). A request that names no zone is
 * judged on the server's clock, which is right for a server in its owner's zone and wrong for a listener elsewhere.
 */
export async function nightZone(requested?: string): Promise<string> {
    if (requested && (await safeZone(requested)) === requested) return requested;
    return safeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** Where the library's energy band is kept; under `mixes:` so the enrichment re-run that clears the mixes cache clears it. */
export const ENERGY_BAND_KEY = "mixes:energy-band";
export const ENERGY_BAND_CACHE_SECONDS = 3 * 3600;
/** A library with no readings yet is asked again soon, since the readings arrive with analysis. */
const ENERGY_BAND_EMPTY_CACHE_SECONDS = 60;

/**
 * The arousal readings that bound the middle half of the library's energy, or null with no readings. Sorting every
 * song's arousal is the cost, and the two numbers move only when analysis finishes, so they are kept in Redis.
 */
async function energyBand(): Promise<[number, number] | null> {
    try {
        const kept = await redisClient.get(ENERGY_BAND_KEY);
        if (kept) return (JSON.parse(kept) as { band: [number, number] | null }).band;
    } catch (error) {
        logger.debug(`[Mixes] energy band cache unreadable: ${error instanceof Error ? error.message : error}`);
    }
    const [row] = await prisma.$queryRaw<Array<{ band: number[] | null }>>`
        SELECT percentile_cont(ARRAY[0.25, 0.75]) WITHIN GROUP (ORDER BY t.arousal) AS band
        FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
        WHERE t.arousal IS NOT NULL AND t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY'
    `;
    const band: [number, number] | null = row?.band ? [row.band[0], row.band[1]] : null;
    try {
        await redisClient.setex(
            ENERGY_BAND_KEY,
            band ? ENERGY_BAND_CACHE_SECONDS : ENERGY_BAND_EMPTY_CACHE_SECONDS,
            JSON.stringify({ band }),
        );
    } catch (error) {
        logger.debug(`[Mixes] energy band cache not written: ${error instanceof Error ? error.message : error}`);
    }
    return band;
}

/**
 * This listener's night songs from the last NIGHT_LOOKBACK_DAYS, one copy per title and artist (plays summed, the
 * most-played copy kept), most played first. Only owned, playable songs. `energy` is read (the library's middle half)
 * only when asked for, since only Midnight Drive ranks by it; otherwise every song carries 0.5.
 */
export async function nightSongs(
    userId: string,
    zone: string,
    { energy = false, now = new Date() }: { energy?: boolean; now?: Date } = {},
): Promise<NightSong[]> {
    const since = new Date(now.getTime() - NIGHT_LOOKBACK_DAYS * 86_400_000);
    const rows = await prisma.$queryRaw<
        Array<{ id: string; artist_key: string; title_key: string; plays: number; pace: number; arousal: number | null }>
    >`
        WITH night AS (
            SELECT t.id, ${artistSql()} AS artist_key, lower(t.title) AS title_key,
                   ${Prisma.raw(PACE_SQL)} AS pace, t.arousal
            FROM "Play" p
            JOIN "Track" t ON t.id = p."trackId"
            JOIN "Album" a ON a.id = t."albumId"
            JOIN "Artist" ar ON ar.id = a."artistId"
            WHERE p."userId" = ${userId} AND p."playedAt" >= ${since} AND p.heard
              AND t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY'
              AND (EXTRACT(HOUR FROM p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone}) >= ${NIGHT_START_HOUR}
                   OR EXTRACT(HOUR FROM p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone}) < ${NIGHT_END_HOUR})
        )
        SELECT id, artist_key, title_key, pace, arousal, count(*)::int AS plays
        FROM night GROUP BY id, artist_key, title_key, pace, arousal
    `;
    // The band is looked up only for a listener who has night songs to place in it.
    const band = energy && rows.length > 0 ? await energyBand() : null;
    const energyOf = (arousal: number | null) =>
        !band || arousal === null ? 0.5 : arousal >= band[0] && arousal <= band[1] ? 1 : 0;
    const byTitle = new Map<string, NightSong & { best: number }>();
    for (const r of rows) {
        const key = `${r.title_key}\0${r.artist_key}`;
        const seen = byTitle.get(key);
        if (!seen) {
            byTitle.set(key, { id: r.id, artistId: r.artist_key, plays: r.plays, pace: r.pace, energy: energyOf(r.arousal), best: r.plays });
        } else {
            seen.plays += r.plays;
            if (r.plays > seen.best || (r.plays === seen.best && r.id < seen.id)) {
                Object.assign(seen, { id: r.id, pace: r.pace, energy: energyOf(r.arousal), best: r.plays });
            }
        }
    }
    return [...byTitle.values()]
        .map(({ best: _best, ...song }) => song)
        .sort((a, b) => b.plays - a.plays || (a.id < b.id ? -1 : 1));
}

/**
 * Up to `count` songs that sound like `seeds` (weighted by plays), never one of the seeds, in rank order. Empty when
 * none of the seeds has similarity data yet.
 */
async function similarSongs(seeds: NightSong[], count: number): Promise<StationSong[]> {
    if (seeds.length === 0 || count <= 0) return [];
    const ctx = await matchingContext(seeds.map((s) => s.id));
    if (!ctx) return [];
    const withData = seeds.filter((s) => ctx.tracks.has(s.id));
    if (withData.length === 0) return [];
    const total = withData.reduce((sum, s) => sum + s.plays, 0);
    const ranked = await rankMatches(
        ctx,
        withData.map((s) => ({ trackId: s.id, weight: s.plays / total })),
        { limit: count, counted: withData.map((s) => s.id) },
    );
    return ranked.map((t) => ({ id: t.id, artistId: t.artistId }));
}

/**
 * The fallback recipe's members (for this listener when there is one), or none when the library has no mood statistics
 * yet: the station then answers an empty list, as every other mood station does before the mood step has run.
 */
async function fallbackSongs(recipeId: string, userId?: string): Promise<StationSong[]> {
    try {
        return (await recipeMembers(getRecipe(recipeId), userId)) ?? [];
    } catch (error) {
        if (!(error instanceof UnrankableLibraryError)) throw error;
        logger.debug(error.message);
        return [];
    }
}

/** Ids not yet in `have`, in order. */
function without(songs: StationSong[], have: Iterable<StationSong>): StationSong[] {
    const seen = new Set<string>();
    for (const s of have) seen.add(s.id);
    return songs.filter((s) => !seen.has(s.id));
}

/**
 * The Late Night station's songs for this listener. With COLD_START_SONGS or more distinct night songs, those songs
 * (only the ones played at night twice or more when at least COLD_START_SONGS of them were, so a single late-night
 * song does not outweigh the habit). With fewer, their night songs plus similar songs up to STATION_FILL, and with no
 * night plays the recipe's songs. The order the station plays them in is the station's usual seeded one (stationOrder).
 */
export async function nightStationPool(
    userId: string | undefined,
    requestedZone: string | undefined,
    fallbackRecipe: string,
): Promise<StationSong[]> {
    if (!userId) return fallbackSongs(fallbackRecipe);
    const own = await nightSongs(userId, await nightZone(requestedZone));
    const repeated = own.filter((s) => s.plays >= 2);
    if (own.length >= COLD_START_SONGS) {
        return repeated.length >= COLD_START_SONGS ? repeated : own;
    }
    const filled = [...own, ...without(await similarSongs(own, STATION_FILL - own.length), own)];
    if (filled.length >= MIN_MIX_TRACKS) return filled;
    return [...filled, ...without(await fallbackSongs(fallbackRecipe, userId), filled)];
}

/** How a night mix ranks the listener's night songs. */
export type NightRanking = "plays" | "drive";

/**
 * A draw of every song without replacement, in an order fixed by `seed`, where a song's chance of coming early grows
 * with its weight (Efraimidis and Spirakis: each song gets the key ln(u)/weight, u a hash of the seed and the song's
 * id in (0, 1), and the highest keys come first). Every song with a positive weight can come first; a song with twice
 * the weight comes up about twice as often.
 */
export function weightedOrder<T extends { id: string }>(songs: T[], weight: (s: T) => number, seed: string): T[] {
    return songs
        .map((song) => {
            const hex = crypto.createHash("sha256").update(`${seed}\0${song.id}`).digest("hex").slice(0, 13);
            const u = (parseInt(hex, 16) + 0.5) / 2 ** 52;
            return { song, key: Math.log(u) / weight(song) };
        })
        .sort((a, b) => b.key - a.key || (a.song.id < b.song.id ? -1 : 1))
        .map(({ song }) => song);
}

/**
 * The songs a night mix plays, in order. With COLD_START_SONGS or more night songs the mix is a fresh draw each day
 * (seeded by mix, day and user, as every recipe mix is): every night song can appear, and a song comes up more often
 * the more it was played at night. "drive" also favours fit (a steady beat at a middle pace, 0 to 1, plus middle
 * energy, 0 to 1): a song's weight is its night plays times (1 + fit). The artist cap (2 per artist, relaxing as in
 * drawMembers) applies to the drawn order. Under COLD_START_SONGS night songs there is too little to draw from: the
 * listener's songs come first (for "drive" by fit, then plays; ties by the day's seeded order). Either way a list still
 * short of the limit (a cold start, or few artists whose songs the cap leaves out) is filled with songs that sound like
 * the most-played night songs, and with too few the fallback recipe's draw.
 */
export async function nightMixTracks(
    spec: { fallbackRecipe: string; ranking: NightRanking },
    userId: string,
    today: string,
    requestedZone: string | undefined,
    limit = TRACK_LIMIT,
): Promise<string[] | null> {
    const own = await nightSongs(userId, await nightZone(requestedZone), { energy: spec.ranking === "drive" });
    const seed = JSON.stringify([spec.fallbackRecipe, today, userId]);
    const fit = (s: NightSong) => (spec.ranking === "drive" ? s.pace + s.energy : 0);
    let ordered: NightSong[];
    if (own.length >= COLD_START_SONGS) {
        ordered = weightedOrder(own, (s) => s.plays * (1 + fit(s)), seed);
    } else {
        // Every song gets a place in the day's seeded order, with no artist cap (the cap is applied once, below, to
        // the ranked list): a song a cap would leave out of the order must not default to first place every day.
        const tie = new Map(seededOrder(own, seed).map((s, i) => [s.id, i]));
        ordered = [...own].sort(
            (a, b) => fit(b) - fit(a) || b.plays - a.plays || tie.get(a.id)! - tie.get(b.id)!,
        );
    }
    let picked = capByArtist(ordered, limit);
    // Short of the limit (a cold start, or a few artists whose songs the cap leaves out): fill with songs that sound like
    // the listener's most-played night songs.
    if (picked.length < limit) {
        const have = ordered.filter((s) => picked.includes(s.id));
        const extra = without(await similarSongs(own.slice(0, FAMILIAR_SEEDS), limit * 2), own);
        const merged = [...have, ...extra];
        picked = capByArtist(merged, limit);
    }
    if (picked.length < MIN_MIX_TRACKS) {
        const members = await fallbackSongs(spec.fallbackRecipe, userId);
        if (members.length === 0) {
            logger.debug(`[Mixes] ${spec.fallbackRecipe}: no night plays and no recipe members`);
            return null;
        }
        const rest = without(members, picked.map((id) => ({ id, artistId: "" })));
        picked = [...picked, ...drawMembers(rest, seed, limit - picked.length)];
    }
    return picked.length >= MIN_MIX_TRACKS ? picked : null;
}

/** A night mix as the Home page lists it: the same shape as every recipe mix. */
export async function nightMix(
    spec: RecipeMixSpec & { ranking: NightRanking },
    userId: string,
    today: string,
    requestedZone: string | undefined,
): Promise<ProgrammaticMix | null> {
    const trackIds = await nightMixTracks({ fallbackRecipe: spec.recipe, ranking: spec.ranking }, userId, today, requestedZone);
    return trackIds ? mixFromTracks(spec, today, trackIds) : null;
}

/** A generator for the daily rotation, with the listener's time zone bound at the call. */
export const nightMixGenerator =
    (spec: RecipeMixSpec & { ranking: NightRanking }) =>
    (userId: string, today: string, zone?: string): Promise<ProgrammaticMix | null> =>
        nightMix(spec, userId, today, zone);

/** The Late Night station's refill: the listener's night songs in the station's usual seeded order (stationOrder). */
export function pickNightStationPage(
    fallbackRecipe: string,
    requestedZone: string | undefined,
    request: StationRequest,
): Promise<StationPage> {
    return stationPage("night", () => nightStationPool(request.listener, requestedZone, fallbackRecipe), request);
}
