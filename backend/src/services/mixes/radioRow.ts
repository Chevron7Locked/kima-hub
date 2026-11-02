/**
 * The radio stations a page shows, each with its cover, in one reply: which stations exist (the vibe analyzer, the mood
 * stations, the library's genres and decades) and their covers are all known here, so a page draws its tiles once,
 * covers in place, like any other row. Each listener's covers are also picked ahead at the start of their day.
 */
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { computeGenreTotals } from "../../utils/genreSql";
import { getEffectiveYear, getDecadeFromYear } from "../../utils/dateFilters";
import { LIBRARY_LOCATION } from "../libraryFilters";
import { featureDetection } from "../featureDetection";
import { moodStationList } from "./stations";
import { nightZone } from "./nightPlays";
import { localDay, stationCovers, type CoverStation } from "./stationCovers";

/** A genre or decade becomes a station once it has this many library songs. */
const MIN_STATION_SONGS = 15;
/** The most genres the radio page lists. */
const MAX_GENRES = 20;
/** The home row's share of them. */
const HOME_GENRES = 6;
const HOME_DECADES = 4;

export const RADIO_ROW_SCOPES = ["home", "all"] as const;
export type RadioRowScope = (typeof RADIO_ROW_SCOPES)[number];

export interface RadioRowStation {
    type: CoverStation["type"];
    value: string | null;
    /** Mood stations: their name and the line generated from their recipe. */
    name?: string;
    description?: string;
    /** Genre and decade stations: their library songs. */
    count?: number;
    cover: string | null;
}

/** The library's genres with enough songs for a station, most songs first (computeGenreTotals is the shared tally). */
export async function libraryGenres(): Promise<{ genre: string; count: number }[]> {
    const artists = await prisma.$queryRaw<
        { name: string; normalizedName: string | null; genres: unknown; userGenres: unknown; n: bigint }[]
    >`
        SELECT ar.name, ar."normalizedName", ar.genres, ar."userGenres", COUNT(t.id)::bigint AS n
        FROM "Artist" ar
        JOIN "Album" a ON a."artistId" = ar.id
        JOIN "Track" t ON t."albumId" = a.id
        WHERE a.location = 'LIBRARY' AND (ar.genres IS NOT NULL OR ar."userGenres" IS NOT NULL)
        GROUP BY ar.id
    `;
    return computeGenreTotals(artists.map((a) => ({ ...a, songs: Number(a.n), albums: 0 })))
        .filter((g) => g.songs >= MIN_STATION_SONGS)
        .map((g) => ({ genre: g.name.toLowerCase(), count: g.songs }))
        .sort((x, y) => y.count - x.count || (x.genre < y.genre ? -1 : x.genre > y.genre ? 1 : 0))
        .slice(0, MAX_GENRES);
}

/** The library's decades with enough songs for a station, newest first. */
export async function libraryDecades(): Promise<{ decade: number; count: number }[]> {
    const albums = await prisma.album.findMany({
        where: { location: LIBRARY_LOCATION },
        select: { year: true, originalYear: true, displayYear: true, _count: { select: { tracks: true } } },
    });
    const songs = new Map<number, number>();
    for (const album of albums) {
        const year = getEffectiveYear(album);
        if (!year) continue;
        const decade = getDecadeFromYear(year);
        songs.set(decade, (songs.get(decade) ?? 0) + album._count.tracks);
    }
    return [...songs.entries()]
        .map(([decade, count]) => ({ decade, count }))
        .filter((d) => d.count >= MIN_STATION_SONGS)
        .sort((a, b) => b.decade - a.decade);
}

/** The stations of a page, in the order the tiles show: quick start, moods, genres, decades. */
async function rowStations(scope: RadioRowScope): Promise<Omit<RadioRowStation, "cover">[]> {
    const [{ vibeEmbeddings }, genres, decades] = await Promise.all([
        featureDetection.getFeatures(),
        libraryGenres(),
        libraryDecades(),
    ]);
    const home = scope === "home";
    // Workout and the mood stations play from the learned moods, which need the vibe analyzer's sound vectors.
    return [
        { type: "all", value: null },
        ...(vibeEmbeddings ? [{ type: "workout" as const, value: null }] : []),
        { type: "discovery", value: null },
        { type: "favorites", value: null },
        ...(vibeEmbeddings ? moodStationList().map((m) => ({ type: "mood" as const, ...m })) : []),
        ...(home ? genres.slice(0, HOME_GENRES) : genres).map((g) => ({ type: "genre" as const, value: g.genre, count: g.count })),
        ...(home ? decades.slice(0, HOME_DECADES) : decades).map((d) => ({ type: "decade" as const, value: String(d.decade), count: d.count })),
    ];
}

const zoneKey = (listener: string) => `radiocover:tz:${listener}`;
const warmedKey = (listener: string, day: string) => `radiocover:warm:${listener}:${day}`;
/** How long after their last visit a listener's covers are still picked ahead. */
const ZONE_SECONDS = 7 * 24 * 3600;

/** A page's stations and this listener's covers for them today; the zone is kept for picking ahead. */
export async function radioRow(listener: string, tz: unknown, scope: RadioRowScope): Promise<RadioRowStation[]> {
    const zone = await nightZone(typeof tz === "string" ? tz : undefined);
    redisClient.set(zoneKey(listener), zone, "EX", ZONE_SECONDS).catch((error: unknown) => {
        logger.debug(`[RadioRow] zone not kept: ${error instanceof Error ? error.message : error}`);
    });
    return withCovers(await rowStations(scope), listener, zone);
}

async function withCovers(stations: Omit<RadioRowStation, "cover">[], listener: string, zone: string): Promise<RadioRowStation[]> {
    const covers = await stationCovers(
        stations.map((s) => ({ type: s.type, value: s.value ?? undefined })),
        listener,
        zone,
    );
    return stations.map((s, i) => ({ ...s, cover: covers[i] }));
}

/**
 * Picks the day's covers for every listener whose day has begun since their last pick, in the zone they last asked
 * from (within a week of their last visit), so their first row of the day reads them instead of waiting on the picks.
 * The radio page's list holds the home row's, so one pick serves both.
 */
export async function warmRadioCovers(): Promise<void> {
    const keys: string[] = [];
    let cursor = "0";
    do {
        const [next, batch] = await redisClient.scan(cursor, "MATCH", zoneKey("*"), "COUNT", 200);
        cursor = next;
        keys.push(...batch);
    } while (cursor !== "0");

    if (keys.length === 0) return;
    const stations = await rowStations("all");
    for (const key of keys) {
        const listener = key.slice(zoneKey("").length);
        try {
            const zone = await redisClient.get(key);
            if (!zone) continue;
            const { day, secondsLeft } = localDay(zone);
            if (await redisClient.exists(warmedKey(listener, day))) continue;
            if (!(await prisma.user.findUnique({ where: { id: listener }, select: { id: true } }))) {
                await redisClient.del(key);
                continue;
            }
            const row = await withCovers(stations, listener, zone);
            // A pick that found no cover at all (a failing database, an empty library) is tried again next cycle.
            if (row.some((s) => s.cover)) await redisClient.set(warmedKey(listener, day), "1", "EX", secondsLeft);
        } catch (error) {
            logger.warn(`[RadioRow] covers not picked ahead for ${listener}: ${error instanceof Error ? error.message : error}`);
        }
    }
}
