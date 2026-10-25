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
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
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
} from "./recipes";
import { TRACK_LIMIT } from "./helpers";
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

/**
 * This listener's night songs, one copy per title and artist (plays summed, the most-played copy kept), most played
 * first. Only owned, playable songs.
 */
export async function nightSongs(userId: string, zone: string): Promise<NightSong[]> {
    const rows = await prisma.$queryRaw<
        Array<{ id: string; artist_key: string; title_key: string; plays: number; pace: number; energy: number }>
    >`
        WITH library_energy AS (
            SELECT t.id, percent_rank() OVER (ORDER BY t.arousal) AS pct
            FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
            WHERE t.arousal IS NOT NULL AND t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY'
        ),
        night AS (
            SELECT t.id, ${artistSql()} AS artist_key, lower(t.title) AS title_key,
                   ${Prisma.raw(PACE_SQL)} AS pace,
                   CASE WHEN le.pct IS NULL THEN 0.5::float8
                        WHEN le.pct BETWEEN 0.25 AND 0.75 THEN 1::float8 ELSE 0::float8 END AS energy
            FROM "Play" p
            JOIN "Track" t ON t.id = p."trackId"
            JOIN "Album" a ON a.id = t."albumId"
            JOIN "Artist" ar ON ar.id = a."artistId"
            LEFT JOIN library_energy le ON le.id = t.id
            WHERE p."userId" = ${userId} AND p.heard
              AND t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY'
              AND (EXTRACT(HOUR FROM p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone}) >= ${NIGHT_START_HOUR}
                   OR EXTRACT(HOUR FROM p."playedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone}) < ${NIGHT_END_HOUR})
        )
        SELECT id, artist_key, title_key, pace, energy, count(*)::int AS plays
        FROM night GROUP BY id, artist_key, title_key, pace, energy
    `;
    const byTitle = new Map<string, NightSong & { best: number }>();
    for (const r of rows) {
        const key = `${r.title_key}\0${r.artist_key}`;
        const seen = byTitle.get(key);
        if (!seen) {
            byTitle.set(key, { id: r.id, artistId: r.artist_key, plays: r.plays, pace: r.pace, energy: r.energy, best: r.plays });
        } else {
            seen.plays += r.plays;
            if (r.plays > seen.best || (r.plays === seen.best && r.id < seen.id)) {
                Object.assign(seen, { id: r.id, pace: r.pace, energy: r.energy, best: r.plays });
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
 * The songs a night mix plays, in order. "plays" ranks night songs by how often they were played at night. "drive"
 * ranks by fit first (a steady beat at a middle pace, 0 to 1, plus middle energy, 0 to 1) and by night plays within
 * the same fit, so every night song stays a candidate (no hard filter) and the listener's habit still decides among
 * songs that fit equally. Ties break by a hash of the day and the user, as every mix does. Under COLD_START_SONGS
 * night songs the rest is filled with similar songs, and with too few the fallback recipe's draw.
 */
export async function nightMixTracks(
    spec: { fallbackRecipe: string; ranking: NightRanking },
    userId: string,
    today: string,
    requestedZone: string | undefined,
    limit = TRACK_LIMIT,
): Promise<string[] | null> {
    const own = await nightSongs(userId, await nightZone(requestedZone));
    const seed = JSON.stringify([spec.fallbackRecipe, today, userId]);
    const fit = (s: NightSong) => (spec.ranking === "drive" ? s.pace + s.energy : 0);
    const tie = new Map(drawMembers(own, seed, own.length).map((id, i) => [id, i]));
    const ordered = [...own].sort(
        (a, b) => fit(b) - fit(a) || b.plays - a.plays || (tie.get(a.id) ?? 0) - (tie.get(b.id) ?? 0),
    );
    let picked = capByArtist(ordered, limit);
    if (own.length < COLD_START_SONGS && picked.length < limit) {
        const have = ordered.filter((s) => picked.includes(s.id));
        const extra = without(await similarSongs(own, limit * 2), own);
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
