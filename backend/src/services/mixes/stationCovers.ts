/**
 * The cover each radio station tile shows. A station shuffles, so asking it for a cover on every visit gives a new
 * album each time and an image address nobody has cached. Instead each listener's pick is made once per local day and
 * kept in Redis until that day ends: the first request of the day picks, every later one reads, and the image address
 * stays the same all day.
 */
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { IN_LIBRARY } from "../../utils/libraryEligibility";
import { nightZone } from "./nightPlays";
import { selectRadioTracks, stillPlayable } from "./stationSelection";

/** The station types that have tiles (radioRow.ts lists them). */
export const COVER_STATION_TYPES = ["all", "workout", "discovery", "favorites", "mood", "genre", "decade"] as const;
export type CoverStationType = (typeof COVER_STATION_TYPES)[number];

export interface CoverStation {
  type: CoverStationType;
  value?: string;
}

/**
 * Songs a station is asked for when looking for one with a cover. Twenty rather than five: the cover lookup is one
 * query on those ids, so a station whose first songs have no art costs almost nothing more to get past them.
 */
const COVER_SAMPLE = 20;
/**
 * How long "no cover" is kept. A station can lack one only for a passing reason (an empty library, moods not built
 * yet, a recipe that cannot rank yet), so it is asked again soon; a real cover is kept to the end of the day.
 */
export const NO_COVER_SECONDS = 600;
/** Stations worked out at once on the first request of the day. */
const COVER_CONCURRENCY = 4;
const KEY_PREFIX = "radiocover";

/**
 * The listener's local calendar day in `zone` (YYYY-MM-DD) and the seconds left of it. The zone is one Postgres knows
 * (nightZone); the JavaScript runtime disagrees on a few names, and those days are read in UTC.
 */
export function localDay(zone: string, now: Date = new Date()): { day: string; secondsLeft: number } {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
  } catch {
    return localDay("UTC", now);
  }
  const used = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    // A day is 23 to 25 hours across a clock change; the pick may then live an hour too long or short.
    secondsLeft: Math.max(60, 86_400 - used),
  };
}

/** The cover of the first song, in the order the station would play them, that has one; null when none does. */
async function pickCover(station: CoverStation, query: Record<string, unknown>, listener: string): Promise<string | null> {
  const picked = await selectRadioTracks(station.type, station.value, query, COVER_SAMPLE, listener);
  // A retired or unknown mood has no songs; that is no cover, not an error.
  if ("reply" in picked) return null;
  const playable = picked.station ? null : await stillPlayable(picked.trackIds);
  const ids = playable ? picked.trackIds.filter((id) => playable.has(id)) : picked.trackIds;
  if (ids.length === 0) return null;
  // Only songs of library albums: a Discover album's cover is never a station's.
  const rows = await prisma.track.findMany({
    where: { id: { in: ids }, ...IN_LIBRARY },
    select: { id: true, album: { select: { coverUrl: true } } },
  });
  const coverOf = new Map(rows.map((r) => [r.id, r.album.coverUrl]));
  for (const id of ids) {
    const cover = coverOf.get(id);
    if (cover) return cover;
  }
  return null;
}

/** This listener's cover for one station today: kept if already picked, otherwise picked now and kept. */
async function dailyCover(
  station: CoverStation,
  listener: string,
  day: string,
  secondsLeft: number,
  zone: string,
): Promise<string | null> {
  const key = `${KEY_PREFIX}:${listener}:${day}:${station.type}:${station.value ?? ""}`;
  try {
    const kept = await redisClient.get(key);
    if (kept !== null) return (JSON.parse(kept) as { cover: string | null }).cover;
  } catch (error) {
    logger.debug(`[RadioCovers] cache unreadable: ${error instanceof Error ? error.message : error}`);
  }
  const cover = await pickCover(station, { tz: zone }, listener);
  try {
    // NX: when two requests pick at once, both answer with whichever was kept first.
    const stored = await redisClient.set(key, JSON.stringify({ cover }), "EX", cover ? secondsLeft : Math.min(secondsLeft, NO_COVER_SECONDS), "NX");
    if (stored !== "OK") {
      const winner = await redisClient.get(key);
      if (winner !== null) return (JSON.parse(winner) as { cover: string | null }).cover;
    }
  } catch (error) {
    logger.debug(`[RadioCovers] cache not written: ${error instanceof Error ? error.message : error}`);
  }
  return cover;
}

/**
 * Each station's cover for this listener today, in the order asked. `tz` is the listener's zone; one that is missing
 * or unknown is read in the server's own zone, as Late Night does (nightZone).
 */
export async function stationCovers(
  stations: CoverStation[],
  listener: string,
  tz: unknown,
): Promise<(string | null)[]> {
  const zone = await nightZone(typeof tz === "string" ? tz : undefined);
  const { day, secondsLeft } = localDay(zone);
  const covers: (string | null)[] = new Array(stations.length).fill(null);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < stations.length) {
      const i = nextIndex++;
      try {
        covers[i] = await dailyCover(stations[i], listener, day, secondsLeft, zone);
      } catch (error) {
        // One station failing leaves its tile uncovered; it is not cached, so the next request tries again.
        logger.warn(`[RadioCovers] ${stations[i].type}/${stations[i].value ?? ""}: ${error instanceof Error ? error.message : error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, stations.length) }, worker));
  return covers;
}
