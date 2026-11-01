/**
 * Which songs a radio station plays: the one selection both GET /library/radio and the station tiles' covers
 * (POST /library/radio/covers) read, so a tile's cover is the cover of a song the station itself would play.
 */
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { getMergedGenres } from "../../utils/metadataOverrides";
import { libraryArtistIdsForGenre } from "../../utils/genreSql";
import { getEffectiveDecadeWhereClause } from "../../utils/dateFilters";
import { shuffleArray } from "../../utils/shuffle";
import { drawIds, drawWeighted, sampleTrackIds, unplayedTrackIds } from "../mixes/helpers";
import {
  UnrankableLibraryError,
  pickRecipeStationPage,
  pickWildcardPage,
  type StationPage,
  type StationRequest,
} from "../mixes/recipes";
import { pickNightStationPage } from "../mixes/nightPlays";
import { SEED_PATTERN, emptyPage } from "../mixes/stationOrder";
import { resolveMoodStation } from "../mixes/stations";
import { LIBRARY_LOCATION } from "../libraryFilters";
import { LIBRARY_PLAYABLE, PLAYABLE } from "../../utils/libraryEligibility";

/** A recipe station's refill; no songs when the library cannot rank its songs for the recipe. */
async function recipeStationPage(recipe: string, request: StationRequest): Promise<StationPage> {
  try {
    return await pickRecipeStationPage(recipe, request);
  } catch (error) {
    if (!(error instanceof UnrankableLibraryError)) throw error;
    logger.debug(error.message);
    return emptyPage(request);
  }
}

/** The ids of these songs that can still play: the file is present and not corrupt. */
export async function stillPlayable(ids: string[]): Promise<Set<string>> {
  const rows = await prisma.track.findMany({ where: { id: { in: ids }, ...LIBRARY_PLAYABLE }, select: { id: true } });
  return new Set(rows.map((t) => t.id));
}

export const BAD_STATION_REQUEST = "A station's offset needs its seed, and a seed is 1 to 128 letters, digits, - or _";

/**
 * A mood, Wildcard or workout station plays every matching song in one order that spreads each artist's songs
 * (stationOrder.ts): a player that sends the same `seed` with `offset` set to the `next` of its last refill hears each
 * song once before the station starts over. Without a seed every refill is a fresh order. Null when the query's seed
 * or offset cannot be used; the other radios do not read them.
 */
function parseStationRequest(query: Record<string, unknown>, limit: number, listener?: string): StationRequest | null {
  const { seed, offset } = query;
  if (seed !== undefined && (typeof seed !== "string" || !SEED_PATTERN.test(seed))) return null;
  if (offset !== undefined && (typeof offset !== "string" || !/^\d{1,9}$/.test(offset))) return null;
  const at = offset === undefined ? 0 : Number(offset);
  if (seed === undefined && at > 0) return null;
  return { limit, seed, offset: at, listener, playable: stillPlayable };
}


/** A selection that ends the request with this reply instead of songs. */
export interface RadioReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The song ids a station would play for `listener`, up to about `limit`. `station` is true for the stations that play
 * every matching song in their own order, already checked playable; the other radios still need that check. `next` is
 * the position to ask from next, for a station asked with a seed.
 */
export async function selectRadioTracks(
  type: unknown,
  value: unknown,
  query: Record<string, unknown>,
  limitNum: number,
  listener: string | undefined,
): Promise<{ reply: RadioReply } | { trackIds: string[]; station: boolean; next: number | undefined }> {
  let trackIds: string[] = [];
  let station = false;
  let next: number | undefined;

  switch (type) {
    case "discovery": {
      const unplayed = drawIds(
        await unplayedTrackIds({ excludeMissing: true, excludeCorrupt: true }),
        limitNum * 2,
      );

      if (unplayed.length >= limitNum) {
        trackIds = unplayed;
      } else {
        // The least played of every unplayed track and a random draw of the
        // others, so plays are counted for that draw, not the whole library.
        const candidates = [
          ...new Set([
            ...unplayed,
            ...(await sampleTrackIds({ where: PLAYABLE, take: limitNum * 10 })),
          ]),
        ];
        const playCounts = await prisma.play.groupBy({
          by: ["trackId"],
          where: { trackId: { in: candidates } },
          _count: { trackId: true },
        });
        const playsOf = new Map(playCounts.map((p) => [p.trackId, p._count.trackId]));
        trackIds = candidates
          .sort((a, b) => (playsOf.get(a) ?? 0) - (playsOf.get(b) ?? 0))
          .slice(0, limitNum * 2);
      }
      break;
    }

    case "favorites": {
      const mostPlayedTracks = await prisma.$queryRaw<
        { id: string; play_count: bigint }[]
      >`
                  SELECT t.id, COUNT(p.id) as play_count
                  FROM "Track" t
                  JOIN "Album" a ON a.id = t."albumId"
                  LEFT JOIN "Play" p ON p."trackId" = t.id
                  WHERE t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY'
                  GROUP BY t.id
                  HAVING COUNT(p.id) > 0
                  ORDER BY -LN(1 - random()) / COUNT(p.id) ASC
                  LIMIT ${limitNum * 2}
              `;

      if (mostPlayedTracks.length > 0) {
        trackIds = mostPlayedTracks.map((t) => t.id);
      } else {
        logger.debug(
          "[Radio:favorites] No play data found, returning random tracks",
        );
        trackIds = await sampleTrackIds({
          where: {},
          take: limitNum * 2,
        });
      }
      break;
    }

    case "decade": {
      const decadeStart = parseInt(value as string) || 2000;

      trackIds = await sampleTrackIds({
        where: {
          album: getEffectiveDecadeWhereClause(decadeStart),
        },
        take: limitNum * 3,
      });
      break;
    }

    case "genre": {
      const genreValue = (value as string) || "";
      // Every spelling of the genre plays, and genres that contain it ("hip hop" plays "alternative hip-hop").
      // A name made only of spaces and punctuation ("-", "") is no genre and plays nothing. The names are compared
      // by genreKey (libraryArtistIdsForGenre), the database only lists the library's artists.
      const artistIds = await libraryArtistIdsForGenre(genreValue);
      const genreTracks = artistIds.length
        ? await prisma.$queryRaw<{ id: string }[]>`
            SELECT t.id FROM "Track" t JOIN "Album" al ON al.id = t."albumId"
             WHERE al.location = ${LIBRARY_LOCATION}::"AlbumLocation" AND al."artistId" = ANY(${artistIds}::text[])`
        : [];
      trackIds = drawIds(
        genreTracks.map((t) => t.id),
        limitNum * 2,
      );

      logger.debug(
        `[Radio:genre] Found ${trackIds.length} tracks for genre "${genreValue}" from Artist.genres and userGenres`,
      );
      break;
    }

    case "mood": {
      const lookup = resolveMoodStation((value as string) || "");
      // Stations the app no longer offers answer an empty list, not an error.
      if (lookup.kind === "retired") {
        return { reply: { status: 200, body: { tracks: [], message: `The ${lookup.value} station has been retired` } } };
      }
      if (lookup.kind === "unknown") {
        return { reply: { status: 400, body: { error: `Unknown mood: ${lookup.value}` } } };
      }
      // A station with no recipe is Wildcard (pickWildcardPage).
      const moodStation = lookup.station;
      const recipe = moodStation.recipe;
      const request = parseStationRequest(query, limitNum, listener);
      if (!request) return { reply: { status: 400, body: { error: BAD_STATION_REQUEST } } };
      if (moodStation.personal?.kind === "night" && recipe) {
        // Late Night plays this listener's own night plays; the recipe is its cold-start fallback (nightPlays.ts).
        const tz = typeof query.tz === "string" ? query.tz : undefined;
        ({ trackIds, next } = await pickNightStationPage(recipe, tz, request));
      } else {
        ({ trackIds, next } = await (recipe ? recipeStationPage(recipe, request) : pickWildcardPage(request)));
      }
      station = true;
      break;
    }

    case "workout": {
      const request = parseStationRequest(query, limitNum, listener);
      if (!request) return { reply: { status: 400, body: { error: BAD_STATION_REQUEST } } };
      ({ trackIds, next } = await recipeStationPage("workout", request));
      station = true;
      break;
    }

    case "artist": {
      const artistId = value as string;
      if (!artistId) {
        return { reply: { status: 400, body: { error: "Artist ID required for artist radio" } } };
      }

      logger.debug(`[Radio:artist] Starting artist radio for: ${artistId}`);

      const artistTracks = await prisma.track.findMany({
        where: { album: { artistId, location: LIBRARY_LOCATION } },
        select: {
          id: true,
          bpm: true,
          energy: true,
          valence: true,
          danceability: true,
        },
      });
      logger.debug(
        `[Radio:artist] Found ${artistTracks.length} tracks from artist`,
      );

      if (artistTracks.length === 0) {
        return { reply: { status: 200, body: { tracks: [] } } };
      }

      const analyzedTracks = artistTracks.filter(
        (t) => t.bpm || t.energy || t.valence,
      );
      const avgVibe =
        analyzedTracks.length > 0
          ? {
              bpm:
                analyzedTracks.reduce((sum, t) => sum + (t.bpm || 0), 0) /
                analyzedTracks.length,
              energy:
                analyzedTracks.reduce((sum, t) => sum + (t.energy || 0), 0) /
                analyzedTracks.length,
              valence:
                analyzedTracks.reduce((sum, t) => sum + (t.valence || 0), 0) /
                analyzedTracks.length,
              danceability:
                analyzedTracks.reduce(
                  (sum, t) => sum + (t.danceability || 0),
                  0,
                ) / analyzedTracks.length,
            }
          : null;
      logger.debug(`[Radio:artist] Artist vibe:`, avgVibe);

      const otherOwnedArtist = await prisma.ownedAlbum.findFirst({
        where: { NOT: { artistId } },
        select: { artistId: true },
      });

      const similarInLibrary = await prisma.similarArtist.findMany({
        where: {
          fromArtistId: artistId,
          toArtist: { ownedAlbums: { some: {} } },
          NOT: { toArtistId: artistId },
        },
        orderBy: { weight: "desc" },
        take: 15,
      });
      let similarArtistIds = similarInLibrary.map((s) => s.toArtistId);
      logger.debug(
        `[Radio:artist] Found ${similarArtistIds.length} similar artists in library`,
      );

      if (similarArtistIds.length < 5 && otherOwnedArtist) {
        const artist = await prisma.artist.findUnique({
          where: { id: artistId },
          select: { genres: true, userGenres: true },
        });
        const artistGenres = getMergedGenres(artist || {});

        if (artistGenres.length > 0) {
          const genreMatchArtists = await prisma.artist.findMany({
            where: {
              ownedAlbums: { some: {} },
              NOT: { id: artistId },
            },
            select: {
              id: true,
              genres: true,
              userGenres: true,
            },
          });

          const scoredArtists = genreMatchArtists
            .map((a) => {
              const theirGenres = getMergedGenres(a);
              const overlap = artistGenres.filter((g) =>
                theirGenres.some(
                  (tg) =>
                    tg.toLowerCase().includes(g.toLowerCase()) ||
                    g.toLowerCase().includes(tg.toLowerCase()),
                ),
              ).length;
              return { id: a.id, score: overlap };
            })
            .filter((a) => a.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);

          const genreArtistIds = scoredArtists.map((a) => a.id);
          similarArtistIds = [
            ...new Set([...similarArtistIds, ...genreArtistIds]),
          ];
          logger.debug(
            `[Radio:artist] After genre matching: ${similarArtistIds.length} similar artists`,
          );
        }
      }

      let similarTracks: {
        id: string;
        bpm: number | null;
        energy: number | null;
        valence: number | null;
        danceability: number | null;
      }[] = [];
      if (similarArtistIds.length > 0) {
        similarTracks = await prisma.track.findMany({
          where: {
            album: { artistId: { in: similarArtistIds }, location: LIBRARY_LOCATION },
            ...PLAYABLE,
          },
          select: {
            id: true,
            bpm: true,
            energy: true,
            valence: true,
            danceability: true,
          },
        });
        logger.debug(
          `[Radio:artist] Found ${similarTracks.length} tracks from similar artists`,
        );
      }

      if (avgVibe && similarTracks.length > 0) {
        similarTracks = similarTracks
          .map((t) => {
            if (!t.bpm && !t.energy && !t.valence)
              return { ...t, vibeScore: 0.5 };

            let score = 0;
            let factors = 0;

            if (t.bpm && avgVibe.bpm) {
              const bpmDiff = Math.abs(t.bpm - avgVibe.bpm);
              score += Math.max(0, 1 - bpmDiff / 40);
              factors++;
            }
            if (t.energy !== null && avgVibe.energy) {
              score += 1 - Math.abs((t.energy || 0) - avgVibe.energy);
              factors++;
            }
            if (t.valence !== null && avgVibe.valence) {
              score += 1 - Math.abs((t.valence || 0) - avgVibe.valence);
              factors++;
            }
            if (t.danceability !== null && avgVibe.danceability) {
              score +=
                1 - Math.abs((t.danceability || 0) - avgVibe.danceability);
              factors++;
            }

            return {
              ...t,
              vibeScore: factors > 0 ? score / factors : 0.5,
            };
          })
          .sort((a, b) => (b as any).vibeScore - (a as any).vibeScore);

        logger.debug(
          `[Radio:artist] Applied vibe boost, top score: ${(
            similarTracks[0] as any
          )?.vibeScore?.toFixed(2)}`,
        );
      }

      // Only tracks that can play are candidates, so the 40/60 split holds after
      // the playable filter below. The similar tracks are filtered in their query.
      const playableIds = new Set(
        (
          await prisma.track.findMany({
            where: {
              id: { in: artistTracks.map((t) => t.id) },
              ...PLAYABLE,
            },
            select: { id: true },
          })
        ).map((t) => t.id),
      );
      const ownPlayable = artistTracks.filter((t) => playableIds.has(t.id));

      const originalCount = Math.min(
        Math.ceil(limitNum * 0.4),
        ownPlayable.length,
      );
      const similarCount = Math.min(
        limitNum - originalCount,
        similarTracks.length,
      );

      const selectedOriginal = shuffleArray(ownPlayable).slice(
        0,
        originalCount,
      );
      // Tracks with a closeness score are drawn in proportion to it. Those without one are drawn uniformly, with the share of
      // slots their share of the candidates is, rounded to a whole track. A track scoring exactly 0 has no weight and is taken
      // only when too few weighted tracks are left.
      let selectedSimilar: typeof similarTracks = [];
      if (similarCount >= 1) {
        const scoreOf = (t: unknown) => (t as { vibeScore?: number }).vibeScore;
        const scored = similarTracks.filter((t) => scoreOf(t) !== undefined);
        const unscored = similarTracks.filter((t) => scoreOf(t) === undefined);
        const unscoredSlots = Math.round(
          (similarCount * unscored.length) / similarTracks.length,
        );
        const weightedSlots = similarCount - unscoredSlots;
        selectedSimilar = [
          ...(weightedSlots >= 1
            ? drawWeighted(scored, (t) => scoreOf(t) ?? 0, weightedSlots)
            : []),
          ...shuffleArray(unscored).slice(0, unscoredSlots),
        ];
        if (selectedSimilar.length < similarCount) {
          const taken = new Set(selectedSimilar);
          selectedSimilar.push(
            ...shuffleArray(similarTracks.filter((t) => !taken.has(t))).slice(
              0,
              similarCount - selectedSimilar.length,
            ),
          );
        }
      }

      trackIds = [...selectedOriginal, ...selectedSimilar].map((t) => t.id);
      logger.debug(
        `[Radio:artist] Final mix: ${selectedOriginal.length} original + ${selectedSimilar.length} similar = ${trackIds.length} tracks`,
      );
      break;
    }

    case "all":
    default:
      trackIds = await sampleTrackIds({ where: {}, take: 300 });
  }

  return { trackIds, station, next };
}
