import { randomUUID } from "crypto";
import path from "path";
import { withRetry } from "../utils/async";
import pLimit from "p-limit";
import * as fuzz from "fuzzball";
import { spotifyService, SpotifyTrack } from "./spotify";
import { logger } from "../utils/logger";
import { musicBrainzService } from "./musicbrainz";
import { deezerService } from "./deezer";
import {
  createPlaylistLogger,
} from "../utils/playlistLogger";
import { notificationService } from "./notificationService";
import { getSystemSettings } from "../utils/systemSettings";
import { mayAcquire } from "../utils/acquirePermission";
import { isLidarrConfigured } from "./lidarrClient";
import { prisma, Prisma } from "../utils/db";
import { LIBRARY_ALBUM_WHERE, LIBRARY_LOCATION } from "./libraryFilters";
import { redisClient } from "../utils/redis";
import PQueue from "p-queue";
import { acquisitionService } from "./acquisitionService";
import { sourcePauseController } from "./sourcePauseController";
import { normalizeArtistName } from "./artistIdentity";
import { parseCredit } from "./artistIdentity";
import { rankAfter, rankForPosition } from "../utils/lexoRank";
import { allocateAppendRanks } from "./playlistService";
import { trackIdentityService } from "./trackIdentity";
import { failureCause } from "../utils/outcome";
import { resolveArtistMbid } from "./artistCorrection";
import { titlesAgree } from "./albumIdentity";
import { songLinkService } from "./songlink";
import { eventBus } from "./eventBus";
import { extractPlaylist as ytdlpExtractPlaylist } from "./ytdlp";
import { M3UEntry } from "./m3uParser";
import { announcePlaylistChange } from "./playlistEvents";
import {
  matchTrackToLibrary,
  type MatchCandidate,
} from "./trackMatching";
import {
  normalizeString,
  stripTrackSuffix,
  normalizeTrackTitle,
} from "../utils/normalization";

const jobLoggers = new Map<string, ReturnType<typeof createPlaylistLogger>>();

/**
 * Spotify Import Service
 *
 * Handles matching Spotify tracks to local library and managing imports
 */

interface MatchedTrack {
  spotifyTrack: SpotifyTrack;
  localTrack: {
    id: string;
    title: string;
    albumId: string;
    albumTitle: string;
    artistName: string;
  } | null;
  matchType: "exact" | "fuzzy" | "none";
  matchConfidence: number; // 0-100
}

interface AlbumToDownload {
  spotifyAlbumId: string;
  albumName: string;
  artistName: string;
  artistMbid: string | null;
  albumMbid: string | null;
  coverUrl: string | null;
  trackCount: number;
  tracksNeeded: SpotifyTrack[];
}

interface ImportPreview {
  playlist: {
    id: string;
    name: string;
    description: string | null;
    owner: string;
    imageUrl: string | null;
    trackCount: number;
  };
  matchedTracks: MatchedTrack[];
  albumsToDownload: AlbumToDownload[];
  summary: {
    total: number;
    inLibrary: number;
    downloadable: number;
    notFound: number;
  };
}

interface ImportJob {
  id: string;
  userId: string;
  spotifyPlaylistId: string;
  playlistName: string;
  status:
    | "pending"
    | "fetching"
    | "downloading"
    | "scanning"
    | "creating_playlist"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number;
  albumsTotal: number;
  albumsCompleted: number;
  tracksMatched: number;
  tracksTotal: number;
  tracksDownloadable: number; // Tracks from albums being downloaded
  createdPlaylistId: string | null;
  error: string | null;
  sourceUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Store the original track list so we can match after downloads
  pendingTracks: Array<{
    artist: string;
    title: string;
    album: string;
    albumMbid: string | null;
    artistMbid: string | null;
    preMatchedTrackId: string | null; // Track ID if already matched in preview
    isrc: string | null;
  }>;
}

const IMPORT_JOB_KEY = (id: string) => `import:job:${id}`;
const IMPORT_JOB_TTL = 24 * 60 * 60; // 24 hours

const PREVIEW_JOB_KEY = (id: string) => `preview:job:${id}`;
const PREVIEW_JOB_TTL = 2 * 60 * 60; // 2 hours

/**
 * Extract a readable hint from a playlist URL to show before the real name resolves.
 */
function extractPlaylistHint(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("spotify")) return "Spotify Playlist";
    if (parsed.hostname.includes("deezer")) return "Deezer Playlist";
    if (parsed.hostname.includes("youtube") || parsed.hostname.includes("youtu.be")) return "YouTube Import";
    if (parsed.hostname.includes("apple")) return "Apple Music Import";
    if (parsed.hostname.includes("tidal")) return "Tidal Import";
    if (parsed.hostname.includes("soundcloud")) return "SoundCloud Import";
    if (parsed.hostname.includes("bandcamp")) return "Bandcamp Import";
    if (parsed.hostname.includes("mixcloud")) return "Mixcloud Import";
    return "Playlist Import";
  } catch {
    return "Playlist Import";
  }
}

/**
 * Save import job to both database and Redis cache for cross-process sharing
 */
async function saveImportJob(job: ImportJob): Promise<void> {
  await prisma.spotifyImportJob.upsert({
    where: { id: job.id },
    create: {
      id: job.id,
      userId: job.userId,
      spotifyPlaylistId: job.spotifyPlaylistId,
      playlistName: job.playlistName,
      status: job.status,
      progress: job.progress,
      albumsTotal: job.albumsTotal,
      albumsCompleted: job.albumsCompleted,
      tracksMatched: job.tracksMatched,
      tracksTotal: job.tracksTotal,
      tracksDownloadable: job.tracksDownloadable,
      createdPlaylistId: job.createdPlaylistId,
      error: job.error,
      sourceUrl: job.sourceUrl,
      pendingTracks: job.pendingTracks as any,
    },
    update: {
      playlistName: job.playlistName,
      status: job.status,
      progress: job.progress,
      albumsTotal: job.albumsTotal,
      albumsCompleted: job.albumsCompleted,
      tracksMatched: job.tracksMatched,
      tracksTotal: job.tracksTotal,
      tracksDownloadable: job.tracksDownloadable,
      createdPlaylistId: job.createdPlaylistId,
      error: job.error,
      updatedAt: new Date(),
    },
  });

  try {
    await redisClient.setex(
      IMPORT_JOB_KEY(job.id),
      IMPORT_JOB_TTL,
      JSON.stringify(job),
    );
  } catch (error) {
    logger.warn(`Failed to cache import job ${job.id} in Redis:`, error);
    // Continue - Redis is optional, DB is source of truth
  }

  eventBus.emit({
    type: "import:progress",
    userId: job.userId,
    payload: {
      jobId: job.id,
      playlistName: job.playlistName,
      status: job.status,
      progress: job.progress,
      albumsTotal: job.albumsTotal,
      albumsCompleted: job.albumsCompleted,
      tracksMatched: job.tracksMatched,
      tracksTotal: job.tracksTotal,
      tracksDownloadable: job.tracksDownloadable,
      createdPlaylistId: job.createdPlaylistId,
      error: job.error,
    },
  });
}

function toMatchCandidate(t: {
  id: string;
  title: string;
  albumId: string;
  album: { title: string; artist: { name: string } };
}): MatchCandidate {
  return {
    id: t.id,
    title: t.title,
    albumId: t.albumId,
    albumTitle: t.album.title,
    artistName: t.album.artist.name,
  };
}

function toImportJob(
  dbJob: Prisma.SpotifyImportJobGetPayload<object>,
): ImportJob {
  return {
    id: dbJob.id,
    userId: dbJob.userId,
    spotifyPlaylistId: dbJob.spotifyPlaylistId,
    playlistName: dbJob.playlistName,
    status: dbJob.status as ImportJob["status"],
    progress: dbJob.progress,
    albumsTotal: dbJob.albumsTotal,
    albumsCompleted: dbJob.albumsCompleted,
    tracksMatched: dbJob.tracksMatched,
    tracksTotal: dbJob.tracksTotal,
    tracksDownloadable: dbJob.tracksDownloadable,
    createdPlaylistId: dbJob.createdPlaylistId,
    error: dbJob.error,
    sourceUrl: dbJob.sourceUrl,
    createdAt: dbJob.createdAt,
    updatedAt: dbJob.updatedAt,
    pendingTracks: (dbJob.pendingTracks as any) || [],
  };
}

/**
 * Get import job from Redis cache or database
 * Redis provides cross-process sharing between API and worker processes
 */
export async function getImportJob(importJobId: string): Promise<ImportJob | null> {
  try {
    const cached = await redisClient.get(IMPORT_JOB_KEY(importJobId));
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    logger.warn(
      `Failed to read import job ${importJobId} from Redis:`,
      error,
    );
  }

  const dbJob = await prisma.spotifyImportJob.findUnique({
    where: { id: importJobId },
  });

  if (!dbJob) return null;

  const job = toImportJob(dbJob);

  try {
    await redisClient.setex(
      IMPORT_JOB_KEY(importJobId),
      IMPORT_JOB_TTL,
      JSON.stringify(job),
    );
  } catch (error) {
    logger.warn(
      `Failed to cache import job ${importJobId} in Redis:`,
      error,
    );
    // Continue - Redis is optional
  }

  return job;
}

function notifyImportFailed(job: ImportJob): void {
  notificationService
    .notifyImportFailed(job.userId, job.playlistName, job.error ?? "Unknown error")
    .catch((e) => logger.error(`[Spotify Import] Job ${job.id}: failure notification failed:`, e));
}


/** Library tracks whose artist's name begins with one of `words` (the candidate pool both import paths match against). */
function tracksOfArtistsStartingWith(words: string[]): Prisma.TrackWhereInput {
  return {
    album: {
      artist: {
        OR: words.flatMap((w) => [
          { normalizedName: { equals: w, mode: "insensitive" as const } },
          { normalizedName: { startsWith: `${w} `, mode: "insensitive" as const } },
        ]),
      },
    },
  };
}

/** Titles this short ("Intro", "Home") are too common to match without the artist. */
const MIN_TITLE_ONLY_LENGTH = 10;

class SpotifyImportService {
  private activeImportControllers = new Map<string, AbortController>();

  /**
   * Match a Spotify track to the library. Candidates come from ISRC, the exact
   * artist's tracks, then first-word prefix sweeps; the shared ladder in
   * services/trackMatching picks the verdict.
   */
  private async matchTrack(spotifyTrack: SpotifyTrack): Promise<MatchedTrack> {
    const candidates = new Map<string, MatchCandidate>();
    const add = (rows: MatchCandidate[]) => {
      for (const c of rows) {
        if (!candidates.has(c.id)) candidates.set(c.id, c);
      }
    };
    const withAlbum = {
      include: { album: { include: { artist: true } } },
    } as const;

    if (spotifyTrack.isrc) {
      const rows = await prisma.track.findMany({
        where: {
          isrc: spotifyTrack.isrc,
          album: { location: LIBRARY_LOCATION },
        },
        ...withAlbum,
      });
      add(rows.map(toMatchCandidate));
    }

    const primaryArtist =
      parseCredit(spotifyTrack.artist).primary || spotifyTrack.artist;
    const normalizedPrimaryArtist = normalizeArtistName(primaryArtist);
    const dbNormalizedArtist = normalizeArtistName(spotifyTrack.artist);

    const artistRows = await prisma.track.findMany({
      where: {
        album: {
          ...LIBRARY_ALBUM_WHERE,
          artist: {
            normalizedName: {
              in: [normalizedPrimaryArtist, dbNormalizedArtist],
            },
          },
        },
      },
      ...withAlbum,
    });
    add(artistRows.map(toMatchCandidate));

    // Fuzzy sweeps: artists whose normalizedName contains the first word (covers
    // "Artist A feat. B" stored under a compound name); the matcher narrows them
    // to exact-artist candidates.
    if (candidates.size === 0) {
      const firstWord = normalizedPrimaryArtist.split(" ")[0];
      if (firstWord.length >= 3) {
        add(
          (
            await prisma.track.findMany({
              where: {
                album: {
                  ...LIBRARY_ALBUM_WHERE,
                  artist: { normalizedName: { contains: firstWord } },
                },
              },
              ...withAlbum,
              take: 50,
            })
          ).map(toMatchCandidate),
        );
      }
      if (candidates.size === 0) {
        add(
          (
            await prisma.track.findMany({
              where: {
                album: {
                  ...LIBRARY_ALBUM_WHERE,
                  artist: {
                    normalizedName: {
                      startsWith: normalizedPrimaryArtist.substring(
                        0,
                        Math.min(5, normalizedPrimaryArtist.length),
                      ),
                    },
                  },
                },
              },
              ...withAlbum,
              take: 50,
            })
          ).map(toMatchCandidate),
        );
      }
      if (candidates.size === 0 && primaryArtist !== spotifyTrack.artist) {
        add(
          (
            await prisma.track.findMany({
              where: {
                album: {
                  ...LIBRARY_ALBUM_WHERE,
                  artist: {
                    normalizedName: {
                      contains: dbNormalizedArtist.split(" ")[0],
                    },
                  },
                },
              },
              ...withAlbum,
              take: 50,
            })
          ).map(toMatchCandidate),
        );
      }
    }

    const match = matchTrackToLibrary(
      {
        title: spotifyTrack.title,
        artist: spotifyTrack.artist,
        album: spotifyTrack.album,
      },
      [...candidates.values()],
    );

    if (match) {
      return {
        spotifyTrack,
        localTrack: {
          id: match.candidate.id,
          title: match.candidate.title,
          albumId: match.candidate.albumId,
          albumTitle: match.candidate.albumTitle,
          artistName: match.candidate.artistName,
        },
        matchType: match.matchType,
        matchConfidence: match.confidence,
      };
    }

    return {
      spotifyTrack,
      localTrack: null,
      matchType: "none",
      matchConfidence: 0,
    };
  }

  /** The album's release group, found in the catalogue of the verified artist. */
  private async findAlbumMbid(
    artistName: string,
    albumName: string,
  ): Promise<{ artistMbid: string | null; albumMbid: string | null }> {
    const artist = await resolveArtistMbid(artistName, [albumName]);
    if (artist.kind !== "answered") {
      logger.warn(
        `MB artist for "${artistName}" / "${albumName}": ${
          artist.kind === "absent" ? "no verified match" : failureCause(artist)
        }`,
      );
      return { artistMbid: null, albumMbid: null };
    }
    const artistMbid = artist.value.mbid;

    const catalogue = await musicBrainzService.getAllReleaseGroups(artistMbid, ["album", "ep", "single"]);
    if (catalogue.kind !== "answered") return { artistMbid, albumMbid: null };
    const match = catalogue.value.find((rg: any) => titlesAgree(rg.title, albumName));
    return { artistMbid, albumMbid: match?.id ?? null };
  }

  /**
   * Look up "Unknown Album" tracks in MusicBrainz before album grouping, so they
   * group under their real albums. Mutates `tracks`; returns resolution stats.
   */
  private async enrichUnknownAlbumsViaMusicBrainz(
    tracks: SpotifyTrack[],
    logPrefix: string,
  ): Promise<{
    resolved: number;
    failed: number;
    cached: Map<
      string,
      { albumName: string; albumId: string; albumMbid: string }
    >;
  }> {
    const unknownAlbumTracks = tracks.filter(
      (t) => t.album === "Unknown Album",
    );

    if (unknownAlbumTracks.length === 0) {
      return { resolved: 0, failed: 0, cached: new Map() };
    }

    // While MusicBrainz is rate limited these tracks stay unknown without counting
    // as failed, so the same attempt budget applies once the pause lifts.
    if (await sourcePauseController.isPaused("musicbrainz")) {
      logger.warn(
        `${logPrefix} MusicBrainz paused (rate limited); leaving ${unknownAlbumTracks.length} Unknown-Album tracks unresolved this run`,
      );
      return { resolved: 0, failed: 0, cached: new Map() };
    }

    logger.info(
      `${logPrefix} Resolving ${unknownAlbumTracks.length} tracks with Unknown Album via MusicBrainz...`,
    );

    // Cache to avoid duplicate lookups for same artist+title
    const resolutionCache = new Map<
      string,
      { albumName: string; albumId: string; albumMbid: string } | null
    >();
    // Results cache for use in album grouping
    const resultsCache = new Map<
      string,
      { albumName: string; albumId: string; albumMbid: string }
    >();

    let resolved = 0;
    let failed = 0;

    // Separate cache hits from tracks needing MB lookup
    const tracksNeedingLookup: typeof unknownAlbumTracks = [];
    for (const track of unknownAlbumTracks) {
      const cacheKey = `${track.artist.toLowerCase()}|||${track.title.toLowerCase()}`;
      if (resolutionCache.has(cacheKey)) {
        const cached = resolutionCache.get(cacheKey);
        if (cached) {
          track.album = cached.albumName;
          track.albumId = `mbid:${cached.albumMbid}`;
          resolved++;
          logger.debug(
            `${logPrefix} [Cache Hit] "${track.title}" -> "${cached.albumName}"`,
          );
        } else {
          failed++;
        }
      } else {
        tracksNeedingLookup.push(track);
      }
    }

    // Fire all MB lookups concurrently -- PQueue rate limiter serializes HTTP calls
    const lookupResults = await Promise.all(
      tracksNeedingLookup.map(async (track) => {
        const cacheKey = `${track.artist.toLowerCase()}|||${track.title.toLowerCase()}`;
        const normalizedTitle = stripTrackSuffix(track.title);

        logger.debug(
          `${logPrefix} Looking up: "${track.title}" by ${track.artist}...`,
        );

        const recordingInfo = await musicBrainzService.searchRecording({
          title: normalizedTitle,
          artists: [track.artist],
          durationSec: Math.round(track.durationMs / 1000),
        });

        if (recordingInfo.kind === "answered") {
          const result = {
            albumName: recordingInfo.value.albumName,
            albumId: recordingInfo.value.albumMbid,
            albumMbid: recordingInfo.value.albumMbid,
          };
          return { track, cacheKey, result, status: "resolved" as const };
        }
        if (recordingInfo.kind === "absent") {
          return { track, cacheKey, result: null, status: "failed" as const };
        }
        // A rate limit pauses the source for the NEXT run and does not
        // count this track as failed — it stays unresolved instead of
        // burning the retry ladder against a refusing API.
        if (recordingInfo.kind === "rateLimited") {
          logger.warn(
            `${logPrefix} MusicBrainz rate-limited — "${track.title}" stays unresolved`,
          );
          return { track, cacheKey, result: null, status: "parked" as const };
        }
        logger.error(
          `${logPrefix} Error resolving "${track.title}": ${failureCause(recordingInfo)}`,
        );
        return { track, cacheKey, result: null, status: "failed" as const };
      }),
    );

    // Apply results
    for (const { track, cacheKey, result, status } of lookupResults) {
      if (status === "resolved" && result) {
        track.album = result.albumName;
        track.albumId = `mbid:${result.albumMbid}`;
        resolutionCache.set(cacheKey, result);
        resultsCache.set(track.spotifyId, result);
        resolved++;
        logger.info(
          `${logPrefix} Resolved: "${track.title}" -> "${result.albumName}"`,
        );
      } else if (status === "parked") {
        // Rate-limited: do NOT cache the miss (the question stays open
        // for the next run) and do NOT count it as failed.
        logger.debug(
          `${logPrefix} Parked (source paused): "${track.title}" by ${track.artist}`,
        );
      } else {
        resolutionCache.set(cacheKey, null);
        failed++;
        logger.debug(
          `${logPrefix} Could not resolve: "${track.title}" by ${track.artist}`,
        );
      }
    }

    logger.info(
      `${logPrefix} MusicBrainz resolution complete: ${resolved} resolved, ${failed} still unknown`,
    );

    return { resolved, failed, cached: resultsCache };
  }

  /**
   * Shared preview generator for any source tracklist
   */
  private async buildPreviewFromTracklist(
    tracks: SpotifyTrack[],
    playlistMeta: {
      id: string;
      name: string;
      description: string | null;
      owner: string;
      imageUrl: string | null;
      trackCount: number;
    },
    source: string,
  ): Promise<ImportPreview> {
    const logPrefix = `[${source} Import]`;

    // Check if Lidarr is configured -- MusicBrainz resolution is only needed for Lidarr
    const previewSettings = await getSystemSettings();
    const lidarrEnabled = isLidarrConfigured(previewSettings);

    // PHASE 0: Early MusicBrainz resolution for "Unknown Album" tracks
    // This MUST happen BEFORE grouping so tracks get grouped by actual albums
    // Only needed when Lidarr is configured (Soulseek searches by text, not MBID)
    const unknownCount = tracks.filter(
      (t) => t.album === "Unknown Album",
    ).length;

    if (unknownCount > 0 && lidarrEnabled) {
      logger.info(
        `${logPrefix} Found ${unknownCount} tracks with Unknown Album, attempting MusicBrainz resolution...`,
      );
      try {
        await this.enrichUnknownAlbumsViaMusicBrainz(tracks, logPrefix);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(
          `${logPrefix} MusicBrainz enrichment failed: ${errorMsg}`,
        );
        // Continue with original tracks - graceful degradation
      }

      const stillUnknown = tracks.filter(
        (t) => t.album === "Unknown Album",
      ).length;
      if (stillUnknown > 0) {
        logger.info(
          `${logPrefix} ${stillUnknown} tracks still have Unknown Album after MusicBrainz resolution`,
        );
      }
    } else if (unknownCount > 0) {
      logger.info(
        `${logPrefix} Skipping MusicBrainz resolution for ${unknownCount} Unknown Album tracks (Lidarr not configured)`,
      );
    }

    // Parallel DB lookups, capped at 8 so a large playlist does not exhaust the Prisma pool.
    // Promise.all keeps insertion order, so matchedTracks[i] is tracks[i].
    const matchLimit = pLimit(8);
    const matchedTracks: MatchedTrack[] = await Promise.all(
      tracks.map((track) => matchLimit(() => this.matchTrack(track))),
    );

    // Second pass: build unmatchedByAlbum from ordered results
    const unmatchedByAlbum = new Map<string, SpotifyTrack[]>();
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const matched = matchedTracks[i];
      if (!matched.localTrack) {
        const key = `${track.artist}|||${track.album}`;
        const existing = unmatchedByAlbum.get(key) || [];
        existing.push(track);
        unmatchedByAlbum.set(key, existing);
      }
    }

    // Fire all album MBID lookups concurrently -- PQueue rate limiter serializes HTTP calls
    const albumsToDownload: AlbumToDownload[] = await Promise.all(
      Array.from(unmatchedByAlbum.entries()).map(async ([key, albumTracks]) => {
        const [artistName, albumName] = key.split("|||");

        let resolvedAlbumName = albumName;
        let artistMbid: string | null = null;
        let albumMbid: string | null = null;

        const firstTrack = albumTracks[0];

        logger.debug(`\n${logPrefix} ========================================`);
        logger.debug(
          `${logPrefix} Looking up: "${artistName}" - "${albumName}"`,
        );

        if (lidarrEnabled) {
          const wasMbResolved = firstTrack.albumId?.startsWith("mbid:");
          const preResolvedMbid = wasMbResolved
            ? firstTrack.albumId!.replace("mbid:", "")
            : null;

          if (preResolvedMbid) {
            albumMbid = preResolvedMbid;
            logger.debug(`${logPrefix} Using pre-resolved MBID: ${albumMbid}`);
            const group = await musicBrainzService.getReleaseGroup(albumMbid);
            if (group.kind === "answered") {
              artistMbid = group.value?.["artist-credit"]?.[0]?.artist?.id ?? null;
            } else if (group.kind !== "absent") {
              logger.debug(
                `${logPrefix} Release group lookup failed: ${failureCause(group)}`,
              );
            }
          } else if (albumName && albumName !== "Unknown Album") {
            const normalizedAlbumName = stripTrackSuffix(albumName);
            const wasNormalized = normalizedAlbumName !== albumName;

            logger.debug(
              `${logPrefix} Searching for album "${albumName}" by ${artistName}...`,
            );
            if (wasNormalized) {
              logger.debug(
                `${logPrefix}   → Normalized to: "${normalizedAlbumName}"`,
              );
            }

            const mbResult = await this.findAlbumMbid(
              artistName,
              normalizedAlbumName,
            );
            artistMbid = mbResult.artistMbid;
            albumMbid = mbResult.albumMbid;

            if (albumMbid) {
              logger.debug(
                `${logPrefix} ✓ Found album directly: "${albumName}" (MBID: ${albumMbid})`,
              );
            }
          }

          if (!albumMbid) {
            logger.debug(
              `${logPrefix} Album not found, trying track-based search...`,
            );
            for (const track of albumTracks) {
              const normalizedTrackTitle = stripTrackSuffix(track.title);
              const wasNormalized = normalizedTrackTitle !== track.title;

              logger.debug(
                `${logPrefix}   Searching for track "${track.title}"...`,
              );
              if (wasNormalized) {
                logger.debug(
                  `${logPrefix}     → Normalized to: "${normalizedTrackTitle}"`,
                );
              }

              const recordingInfo = await musicBrainzService.searchRecording({
                title: normalizedTrackTitle,
                artists: [artistName],
                durationSec: Math.round(track.durationMs / 1000),
              });

              if (recordingInfo.kind === "answered") {
                resolvedAlbumName = recordingInfo.value.albumName;
                artistMbid = recordingInfo.value.artistMbid;
                albumMbid = recordingInfo.value.albumMbid;

                logger.debug(
                  `${logPrefix} ✓ Found via track: "${resolvedAlbumName}" (MBID: ${albumMbid})`,
                );
                break;
              }
              if (recordingInfo.kind !== "absent") {
                logger.debug(
                  `${logPrefix}   Track lookup ${recordingInfo.kind}: ${failureCause(recordingInfo)}`,
                );
              }
            }
          }

          if (!albumMbid) {
            logger.debug(
              `${logPrefix} ✗ Could not find album MBID for ${artistName} - "${resolvedAlbumName}"`,
            );
          }
        } else {
          logger.info(
            `${logPrefix} Skipping MBID resolution for "${resolvedAlbumName}" (Lidarr not configured)`,
          );
        }

        const albumToDownload: AlbumToDownload = {
          spotifyAlbumId: albumTracks[0].albumId?.replace("mbid:", "") || "",
          albumName: resolvedAlbumName,
          artistName,
          artistMbid,
          albumMbid,
          coverUrl: albumTracks[0].coverUrl,
          trackCount: albumTracks.length,
          tracksNeeded: albumTracks,
        };

        logger.debug(`${logPrefix} Download strategy:`);
        if (albumMbid) {
          logger.debug(`   Will request album from Lidarr/Soulseek:`);
          logger.debug(
            `   Artist: "${artistName}" (MBID: ${artistMbid || "NONE"})`,
          );
          logger.debug(`   Album: "${resolvedAlbumName}" (MBID: ${albumMbid})`);
        } else {
          logger.debug(
            `   Will request individual tracks via Soulseek (no MBID):`,
          );
          logger.debug(`   Artist: "${artistName}"`);
          logger.debug(
            `   Tracks: ${albumTracks.map((t) => `"${t.title}"`).join(", ")}`,
          );
        }
        logger.debug(`${logPrefix} ========================================\n`);

        return albumToDownload;
      }),
    );

    const inLibrary = matchedTracks.filter((m) => m.localTrack !== null).length;

    const downloadable = albumsToDownload.reduce(
      (sum, a) => sum + a.tracksNeeded.length,
      0,
    );

    const withMbid = albumsToDownload.filter(a => a.albumMbid).length;
    const withoutMbid = albumsToDownload.length - withMbid;
    logger.info(
      `${logPrefix} Preview complete: ${playlistMeta.trackCount} tracks, ${inLibrary} in library, ${albumsToDownload.length} albums to download (${withMbid} with MBID, ${withoutMbid} without)`,
    );

    return {
      playlist: playlistMeta,
      matchedTracks,
      albumsToDownload,
      summary: {
        total: playlistMeta.trackCount,
        inLibrary,
        downloadable,
        notFound: 0,
      },
    };
  }

  /**
   * Generate a preview of what will be imported
   */
  async generatePreview(
    spotifyUrl: string,
    onFetchProgress?: (fetched: number, total: number) => void,
    onMatchingStart?: () => void,
  ): Promise<ImportPreview> {
    const playlist = await spotifyService.getPlaylist(spotifyUrl, onFetchProgress);
    if (!playlist) {
      throw new Error(
        "Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL.",
      );
    }

    onMatchingStart?.();

    return this.buildPreviewFromTracklist(
      playlist.tracks,
      {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        owner: playlist.owner,
        imageUrl: playlist.imageUrl,
        trackCount: playlist.trackCount,
      },
      "Spotify",
    );
  }

  /**
   * Generate a preview from a Deezer playlist
   * Converts Deezer tracks to Spotify format and processes them
   */
  async generatePreviewFromDeezer(deezerPlaylist: any): Promise<ImportPreview> {
    const spotifyTracks: SpotifyTrack[] = deezerPlaylist.tracks.map(
      (track: any, index: number) => ({
        spotifyId: track.deezerId,
        title: track.title,
        artist: track.artist,
        artistId: track.artistId || "",
        album: track.album || "Unknown Album",
        albumId: track.albumId || "",
        isrc: null,
        durationMs: track.durationMs,
        trackNumber: track.trackNumber || index + 1,
        previewUrl: track.previewUrl || null,
        coverUrl: track.coverUrl || deezerPlaylist.imageUrl || null,
      }),
    );

    return this.buildPreviewFromTracklist(
      spotifyTracks,
      {
        id: deezerPlaylist.id,
        name: deezerPlaylist.title,
        description: deezerPlaylist.description || null,
        owner: deezerPlaylist.creator || "Deezer",
        imageUrl: deezerPlaylist.imageUrl || null,
        trackCount: deezerPlaylist.trackCount || spotifyTracks.length,
      },
      "Deezer",
    );
  }

  isExternalPlatformUrl(url: string): boolean {
    const platform = songLinkService.detectPlatform(url);
    return !!platform && platform !== "spotify" && platform !== "deezer";
  }

  async generatePreviewFromExternalPlatform(url: string): Promise<ImportPreview> {
    const platform = songLinkService.detectPlatform(url) || "unknown";

    const isSingleTrack = !this.isPlaylistUrl(url);
    if (isSingleTrack) {
      const resolved = await trackIdentityService.resolveUrl(url);
      if (!resolved) {
        throw new Error(`Could not resolve track from ${platform} URL`);
      }

      const track: SpotifyTrack = {
        spotifyId: resolved.spotifyId || `ext-${Date.now()}`,
        title: resolved.title,
        artist: resolved.artist,
        artistId: "",
        album: resolved.album || "Unknown Album",
        albumId: "",
        isrc: resolved.isrc,
        durationMs: 0,
        trackNumber: 1,
        previewUrl: null,
        coverUrl: resolved.coverUrl,
      };

      return this.buildPreviewFromTracklist(
        [track],
        {
          id: `external-${Date.now()}`,
          name: `${platform} import`,
          description: null,
          owner: "",
          imageUrl: resolved.coverUrl || null,
          trackCount: 1,
        },
        platform,
      );
    }

    return this.extractPlaylistWithYtDlp(url);
  }

  private isPlaylistUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if ((hostname.includes("youtube.com") || hostname.includes("youtu.be")) && parsed.searchParams.has("list")) return true;
      if (hostname.includes("music.youtube.com") && parsed.pathname.includes("/playlist")) return true;
      if (hostname.includes("soundcloud.com") && parsed.pathname.includes("/sets/")) return true;
      if (hostname.includes("bandcamp.com") && parsed.pathname.includes("/album/")) return true;
      if (hostname.includes("mixcloud.com") && parsed.pathname.includes("/playlist/")) return true;
      return false;
    } catch {
      // A URL that will not parse is not a playlist link.
      return false;
    }
  }

  private async extractPlaylistWithYtDlp(url: string): Promise<ImportPreview> {
    const playlist = await ytdlpExtractPlaylist(url);

    if (playlist.tracks.length === 0) {
      throw new Error(`No tracks found in ${playlist.platform} playlist`);
    }

    const resolvedTracks: SpotifyTrack[] = [];
    const tracksNeedingSongLink = playlist.tracks.filter((t) => !t.hasNativeMetadata);
    const limit = pLimit(3);

    logger.info(
      `[yt-dlp] ${playlist.tracks.length} tracks total, ${tracksNeedingSongLink.length} need song.link resolution`,
    );

    await Promise.all(
      playlist.tracks.map((track, idx) =>
        limit(async () => {
          let coverUrl: string | null = track.thumbnailUrl;

          if (!track.hasNativeMetadata) {
            try {
              const resolved = await Promise.race([
                trackIdentityService.resolveUrl(track.url),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
              ]);
              if (resolved?.title && resolved?.artist) {
                resolvedTracks.push({
                  spotifyId: resolved.spotifyId || `ext-${playlist.id}-${idx}`,
                  title: resolved.title,
                  artist: resolved.artist,
                  artistId: "",
                  album: resolved.album || track.album || "Unknown Album",
                  albumId: "",
                  isrc: resolved.isrc || null,
                  durationMs: track.duration || 0,
                  trackNumber: idx + 1,
                  previewUrl: null,
                  coverUrl: resolved.coverUrl || coverUrl,
                });
                return;
              }
            } catch {
              // song.link could not resolve it; fall back to yt-dlp's own metadata below
            }
          }

          resolvedTracks.push({
            spotifyId: `ext-${playlist.id}-${idx}`,
            title: track.title,
            artist: track.artist,
            artistId: "",
            album: track.album || "Unknown Album",
            albumId: "",
            isrc: null,
            durationMs: track.duration || 0,
            trackNumber: idx + 1,
            previewUrl: null,
            coverUrl,
          });
        }),
      ),
    );

    resolvedTracks.sort((a, b) => a.trackNumber - b.trackNumber);

    if (resolvedTracks.length === 0) {
      throw new Error(`Could not resolve any tracks from ${playlist.platform} playlist`);
    }

    return this.buildPreviewFromTracklist(
      resolvedTracks,
      {
        id: playlist.id,
        name: playlist.title,
        description: null,
        owner: playlist.uploader || "",
        imageUrl: resolvedTracks[0]?.coverUrl || null,
        trackCount: resolvedTracks.length,
      },
      playlist.platform,
    );
  }

  /**
   * Build the pendingTracks array from a preview's matched tracks.
   * Shared between startImport and processQuickImportFromQueue.
   */
  private buildPendingTracks(
    preview: ImportPreview,
  ): ImportJob["pendingTracks"] {
    return preview.matchedTracks.map((m) => {
      const spotifyAlbum = m.spotifyTrack.album;
      const spotifyAlbumId = m.spotifyTrack.albumId;
      const spotifyArtist = m.spotifyTrack.artist;
      const spotifyTrackId = m.spotifyTrack.spotifyId;
      const trackTitle = m.spotifyTrack.title;

      const wasMbResolved = spotifyAlbumId?.startsWith("mbid:");
      const resolvedMbid = wasMbResolved
        ? spotifyAlbumId.replace("mbid:", "")
        : null;

      let albumToDownload: AlbumToDownload | undefined;

      // Strategy 1: Match by resolved MusicBrainz MBID
      if (resolvedMbid) {
        albumToDownload = preview.albumsToDownload.find(
          (a) => a.albumMbid === resolvedMbid,
        );
      }

      // Strategy 2: Match by Spotify album ID
      if (!albumToDownload && spotifyAlbumId && !wasMbResolved) {
        albumToDownload = preview.albumsToDownload.find(
          (a) => a.spotifyAlbumId === spotifyAlbumId,
        );
      }

      // Strategy 3: Find album that contains this specific track
      if (!albumToDownload) {
        albumToDownload = preview.albumsToDownload.find((a) =>
          a.tracksNeeded.some(
            (t) =>
              t.spotifyId === spotifyTrackId ||
              (t.title.toLowerCase() === trackTitle.toLowerCase() &&
                t.artist.toLowerCase() === spotifyArtist.toLowerCase()),
          ),
        );
      }

      // Strategy 4: Match by artist + album name similarity
      if (
        !albumToDownload &&
        spotifyArtist &&
        spotifyAlbum &&
        spotifyAlbum !== "Unknown Album"
      ) {
        const normalizedArtist = spotifyArtist.toLowerCase();
        const normalizedAlbum = spotifyAlbum.toLowerCase();
        albumToDownload = preview.albumsToDownload.find(
          (a) =>
            a.artistName.toLowerCase() === normalizedArtist &&
            a.albumName
              .toLowerCase()
              .includes(normalizedAlbum.substring(0, 10)),
        );
      }

      const albumForDisplay =
        spotifyAlbum && spotifyAlbum !== "Unknown Album"
          ? spotifyAlbum
          : albumToDownload?.albumName || spotifyAlbum;

      const actualAlbumMbid =
        resolvedMbid || albumToDownload?.albumMbid || null;

      return {
        artist: spotifyArtist,
        title: trackTitle,
        album: albumForDisplay,
        albumMbid: actualAlbumMbid,
        artistMbid: albumToDownload?.artistMbid || null,
        preMatchedTrackId: m.localTrack?.id || null,
        isrc: m.spotifyTrack.isrc || null,
      };
    });
  }

  async startImport(
    userId: string,
    spotifyPlaylistId: string,
    playlistName: string,
    albumMbidsToDownload: string[],
    preview: ImportPreview,
  ): Promise<ImportJob> {
    const jobId = `import_${Date.now()}_${Math.random()
      .toString(36)
      .substring(7)}`;

    const jobLogger = createPlaylistLogger(jobId);
    jobLoggers.set(jobId, jobLogger);

    jobLogger.logJobStart(playlistName, preview.summary.total, userId);
    jobLogger.info(`Playlist ID: ${spotifyPlaylistId}`);
    jobLogger.info(`Albums to download: ${albumMbidsToDownload.length}`);
    jobLogger.info(`Tracks already in library: ${preview.summary.inLibrary}`);

    const tracksFromDownloads = preview.albumsToDownload
      .filter((a) =>
        albumMbidsToDownload.includes(a.albumMbid || a.spotifyAlbumId),
      )
      .reduce((sum, a) => sum + a.tracksNeeded.length, 0);

    const pendingTracks = this.buildPendingTracks(preview);

    const job: ImportJob = {
      id: jobId,
      userId,
      spotifyPlaylistId,
      playlistName,
      status: "pending",
      progress: 0,
      albumsTotal: albumMbidsToDownload.length,
      albumsCompleted: 0,
      tracksMatched: preview.summary.inLibrary,
      tracksTotal: preview.summary.total,
      tracksDownloadable: tracksFromDownloads,
      createdPlaylistId: null,
      error: null,
      sourceUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      pendingTracks,
    };

    await saveImportJob(job);

    // Cache preview for the BullMQ worker to retrieve
    try {
      await redisClient.setex(
        `import:preview:${job.id}`,
        IMPORT_JOB_TTL,
        JSON.stringify(preview),
      );
    } catch (e: any) {
      logger.warn(`[Spotify Import] Failed to cache preview for job ${job.id}: ${e.message}`);
    }

    // Enqueue import job to BullMQ for crash-recoverable processing
    const { importQueue } = await import("../workers/queues");
    await importQueue.add("import", {
      importJobId: job.id,
      userId: job.userId,
      albumMbidsToDownload,
    }, {
      jobId: job.id,
    });

    jobLogger.info(`[Spotify Import] Enqueued job ${job.id} to BullMQ`);

    return job;
  }

  /**
   * Process the import: download albums through AcquisitionService, then create the playlist.
   */
  private async processImport(
    job: ImportJob,
    albumMbidsToDownload: string[],
    preview: ImportPreview,
  ): Promise<void> {
    const jobLogger = jobLoggers.get(job.id);
    let abortController: AbortController | undefined;

    try {
      // Guard: if cancelled between startImport() and here, abort
      if (job.status === "cancelled") {
        jobLogger?.info("[Spotify Import] Job cancelled before downloading started");
        return;
      }

      abortController = new AbortController();
      const { signal } = abortController;
      this.activeImportControllers.set(job.id, abortController);

      try {
        if (albumMbidsToDownload.length > 0) {
          job.status = "downloading";
          job.updatedAt = new Date();
          await saveImportJob(job);

          jobLogger?.logAlbumDownloadStart(albumMbidsToDownload.length);

          jobLogger?.info(
            `Processing ${albumMbidsToDownload.length} albums via AcquisitionService`,
          );

          // Process albums in parallel with concurrency limit from settings
          const settings = await getSystemSettings();
          const albumQueue = new PQueue({
            concurrency: settings?.soulseekConcurrentDownloads ?? 1,
          });

          signal.addEventListener('abort', () => { albumQueue.clear(); }, { once: true });

          const albumPromises = albumMbidsToDownload.map((albumIdentifier) =>
            albumQueue.add(async () => {
              // Find ALL matching album groups - multiple Spotify album editions
              // may resolve to the same MusicBrainz MBID (e.g., "The Fall of Math"
              // and "The Fall of Math (Deluxe Edition)"). Merge their tracksNeeded.
              const matchingAlbums = preview.albumsToDownload.filter(
                (a) =>
                  a.albumMbid === albumIdentifier ||
                  a.spotifyAlbumId === albumIdentifier,
              );
              if (matchingAlbums.length === 0) return;

              let album: AlbumToDownload;
              if (matchingAlbums.length === 1) {
                album = matchingAlbums[0];
              } else {
                // Merge tracksNeeded, deduplicate by title
                const seen = new Set<string>();
                const mergedTracks = matchingAlbums.flatMap((a) => a.tracksNeeded).filter((t) => {
                  const key = t.title.toLowerCase();
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                album = {
                  ...matchingAlbums[0],
                  tracksNeeded: mergedTracks,
                  trackCount: mergedTracks.length,
                };
                jobLogger?.debug(
                  `[Spotify Import] Merged ${matchingAlbums.length} album editions for "${album.albumName}" (${mergedTracks.length} unique tracks)`,
                );
              }

              try {
                const isUnknownAlbum =
                  album.albumName === "Unknown Album";

                jobLogger?.info(
                  `Album start: ${album.artistName} - ${album.albumName}${
                    album.albumMbid
                      ? ` [MBID: ${album.albumMbid}]`
                      : " [Unknown Album]"
                  } (tracksNeeded=${album.tracksNeeded.length})`,
                );

                jobLogger?.debug(
                  `[Spotify Import] Requesting: ${album.artistName} - ${album.albumName}`,
                );

                // Acquisition context for tracking
                const context = {
                  userId: job.userId,
                  spotifyImportJobId: job.id,
                  signal,
                };

                let result;

                if (isUnknownAlbum) {
                  // Unknown Album: Use track-based acquisition
                  jobLogger?.debug(
                    `[Spotify Import] Unknown Album detected - using track acquisition`,
                  );

                  const trackRequests = album.tracksNeeded.map((track) => ({
                    trackTitle: track.title,
                    artistName: track.artist,
                    albumTitle: album.albumName,
                  }));

                  const trackResults = await acquisitionService.acquireTracks(
                    trackRequests,
                    context,
                  );

                  const successCount = trackResults.filter(
                    (r) => r.success,
                  ).length;
                  const successThreshold = Math.ceil(trackRequests.length * 0.5);

                  result = {
                    success: successCount >= successThreshold,
                    tracksDownloaded: successCount,
                    tracksTotal: trackRequests.length,
                  };

                  if (result.success) {
                    jobLogger?.info(
                      `Unknown Album tracks success: ${album.artistName} - ${successCount}/${trackRequests.length} tracks`,
                    );
                  }
                } else {
                  // Regular album: Use album-based acquisition
                  result = await acquisitionService.acquireAlbum(
                    {
                      albumTitle: album.albumName,
                      artistName: album.artistName,
                      mbid: album.albumMbid || undefined,
                      requestedTracks: album.tracksNeeded.map((t) => ({
                        title: t.title,
                      })),
                    },
                    context,
                  );

                  if (result.success) {
                    jobLogger?.info(
                      `Album acquisition success: ${album.artistName} - ${album.albumName} via ${result.source}`,
                    );
                  }
                }

                if (!result.success) {
                  const errorMsg =
                    result.error || "No download sources available";
                  jobLogger?.debug(
                    `[Spotify Import] ✗ Failed: ${album.albumName} - ${errorMsg}`,
                  );
                  jobLogger?.logAlbumFailed(
                    album.albumName,
                    album.artistName,
                    errorMsg,
                  );
                }

                job.albumsCompleted++;
                job.progress = Math.round(
                  (job.albumsCompleted / job.albumsTotal) * 30,
                );
                job.updatedAt = new Date();
                await saveImportJob(job);

                jobLogger?.debug(
                  `Album done: ${album.artistName} - ${
                    album.albumName
                  } (success=${result.success ? "yes" : "no"})`,
                );
              } catch (error: any) {
                if (error?.name === 'AbortError' || signal.aborted) return;
                jobLogger?.error(
                  `[Spotify Import] Failed: ${album.artistName} - ${album.albumName}: ${error.message}`,
                );
                jobLogger?.logAlbumFailed(
                  album.albumName,
                  album.artistName,
                  error.message,
                );
              }
            }, { signal }),
          );

          // Wait for all album acquisitions to complete
          await Promise.all(albumPromises);

          jobLogger?.info(
            `Initial acquisition phase finished for ${albumMbidsToDownload.length} album(s). Checking completion state...`,
          );

          // Poll until the job is terminal: Soulseek downloads finish inline, Lidarr's via
          // webhook. Every 15 s for up to 30 min; the short sleeps keep the event loop
          // free for BullMQ's lock renewal.
          const POLL_INTERVAL_MS = 15_000;
          const MAX_WAIT_MS = 30 * 60 * 1000;
          const TERMINAL_STATES = ["completed", "failed", "cancelled", "scanning", "creating_playlist"];
          const pollStart = Date.now();

          while (true) {
            if (signal.aborted) {
              jobLogger?.info(`[Spotify Import] Job ${job.id}: aborted during completion poll`);
              return;
            }

            await this.checkImportCompletion(job.id);

            const currentJob = await getImportJob(job.id);
            if (!currentJob) {
              jobLogger?.error(`[Spotify Import] Job ${job.id}: not found during completion poll`);
              return;
            }

            if (TERMINAL_STATES.includes(currentJob.status)) {
              jobLogger?.info(`Import job ${job.id} handed off to next phase: ${currentJob.status}`);
              return;
            }

            if (Date.now() - pollStart > MAX_WAIT_MS) {
              jobLogger?.warn(`[Spotify Import] Job ${job.id}: timed out after 30 minutes, running final completion check`);
              await this.checkImportCompletion(job.id);
              return;
            }

            jobLogger?.debug(`[Spotify Import] Job ${job.id}: still ${currentJob.status}, polling again in 15s...`);
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          }
        }

        // No downloads needed - all tracks already in library
        await this.buildPlaylist(job);
      } finally {
        this.activeImportControllers.delete(job.id);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || abortController?.signal.aborted) {
        jobLogger?.info(`[Spotify Import] Job ${job.id}: import cancelled, returning cleanly`);
        return;
      }
      job.status = "failed";
      job.error = error.message;
      job.updatedAt = new Date();
      notifyImportFailed(job);
      throw error;
    }
  }

  /**
   * Check if all downloads for this import are complete (called by webhook handler)
   */
  async checkImportCompletion(importJobId: string): Promise<void> {
    logger.debug(
      `\n[Spotify Import] Checking completion for job ${importJobId}...`,
    );

    const job = await getImportJob(importJobId);
    if (!job) {
      logger.debug(`   Job not found`);
      jobLoggers.delete(importJobId);
      return;
    }

    // Guard: don't re-process if already past the download phase or still fetching (quick import)
    if (["completed", "failed", "cancelled", "scanning", "creating_playlist", "fetching"].includes(job.status)) {
      logger.debug(`   Job already in ${job.status} state, skipping`);
      return;
    }

    const jobLogger = jobLoggers.get(importJobId);

    // Download jobs carry this import's id in metadata.spotifyImportJobId
    const downloadJobs = await prisma.downloadJob.findMany({
      where: {
        metadata: {
          path: ["spotifyImportJobId"],
          equals: importJobId,
        },
      },
    });

    const total = downloadJobs.length;
    const completed = downloadJobs.filter(
      (j) => j.status === "completed",
    ).length;
    const failed = downloadJobs.filter((j) => j.status === "failed").length;
    const pending = total - completed - failed;

    if (total === 0 && job.albumsTotal > 0) {
      const message =
        "No download jobs were created for this import. This usually means the import preview did not include the selected albums.";
      logger.debug(`   ${message}`);
      jobLogger?.warn(message);

      job.status = "failed";
      job.error = message;
      job.updatedAt = new Date();
      await saveImportJob(job);
      notifyImportFailed(job);
      // Clean up job logger to prevent memory leak
      jobLoggers.delete(job.id);
      return;
    }

    logger.debug(
      `   Download status: ${completed}/${total} completed, ${failed} failed, ${pending} pending`,
    );
    jobLogger?.logDownloadProgress(completed, failed, pending);

    job.progress =
      total > 0
        ? 30 + Math.round((completed / total) * 40) // 30-70% for downloads
        : 30;
    job.updatedAt = new Date();

    if (pending > 0) {
      const oldestPending = downloadJobs
        .filter((j) => j.status === "pending" || j.status === "processing")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

      const waitTimeMs = oldestPending
        ? Date.now() - oldestPending.createdAt.getTime()
        : 0;
      const waitTimeMins = Math.round(waitTimeMs / 60000);

      // After 10 minutes of waiting, proceed anyway to avoid stuck jobs
      if (waitTimeMs < 600000) {
        // 10 minutes
        logger.debug(
          `   Still waiting for ${pending} downloads... (${waitTimeMins} min elapsed)`,
        );
        jobLogger?.info(`Waiting for Soulseek downloads to complete...`);
        await saveImportJob(job);
        return;
      }

      logger.debug(
        `   Timeout: ${pending} downloads still pending after ${waitTimeMins} minutes, proceeding anyway`,
      );
      jobLogger?.warn(
        `Download timeout: ${pending} pending after ${waitTimeMins}m, proceeding with available tracks`,
      );

      await prisma.downloadJob.updateMany({
        where: {
          metadata: {
            path: ["spotifyImportJobId"],
            equals: importJobId,
          },
          status: { in: ["pending", "processing"] },
        },
        data: {
          status: "failed",
          error: "Timed out waiting for download",
          completedAt: new Date(),
        },
      });
    }

    // All downloads finished (completed or failed)
    logger.debug(`   All downloads finished! Triggering library scan...`);
    jobLogger?.info(
      `All ${total} download jobs finished (${completed} completed, ${failed} failed)`,
    );

    const { requestScan } = await import("../workers/scanRequest");
    const scanResult = await requestScan({
      userId: job.userId,
      source: "spotify-import",
      spotifyImportJobId: importJobId,
    });

    jobLogger?.info(
      scanResult.queued
        ? `Queued library scan (bullJobId=${scanResult.jobId})`
        : `Library scan not re-queued: ${scanResult.reason}`,
    );

    job.status = "scanning";
    job.progress = 75;
    job.updatedAt = new Date();
    await saveImportJob(job);
  }

  /**
   * Build playlist after library scan completes (called by scan worker)
   */
  async buildPlaylistAfterScan(importJobId: string): Promise<void> {
    logger.debug(
      `\n[Spotify Import] Building playlist for job ${importJobId}...`,
    );

    const job = await getImportJob(importJobId);
    if (!job) {
      logger.debug(`   Job not found`);
      jobLoggers.delete(importJobId);
      return;
    }

    // Guard: job already reached a terminal state from a previous scan
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      logger.debug(`   Job already ${job.status}, skipping playlist build`);
      return;
    }

    await this.buildPlaylist(job);
  }

  /**
   * Internal: Build the playlist with matched tracks
   */
  private async buildPlaylist(job: ImportJob): Promise<void> {
    const jobLogger = jobLoggers.get(job.id);

    // Guard: playlist already created for this job
    if (job.createdPlaylistId) {
      jobLogger?.debug(`   Playlist already created: ${job.createdPlaylistId}, skipping`);
      return;
    }

    job.status = "creating_playlist";
    job.progress = 90;
    job.updatedAt = new Date();
    await saveImportJob(job);

    jobLogger?.logPlaylistCreationStart();
    jobLogger?.logTrackMatchingStart();

    // Verify pre-matched track ids
    const preMatchedIds = job.pendingTracks
      .map((t) => t.preMatchedTrackId)
      .filter((id): id is string => !!id);
    const verifiedPreMatched = preMatchedIds.length > 0
      ? new Map(
          (await prisma.track.findMany({
            where: { id: { in: preMatchedIds } },
            select: { id: true, title: true },
          })).map((t) => [t.id, t]),
        )
      : new Map<string, { id: string; title: string }>();

    // Library tracks of the relevant artists
    const allArtistFirstWords = [
      ...new Set(
        job.pendingTracks.map((t) => normalizeArtistName(t.artist).split(" ")[0]),
      ),
    ];
    type TrackWithRelations = {
      id: string;
      title: string;
      albumId: string;
      album: {
        title: string;
        artist: { name: string; normalizedName: string | null };
      };
    };
    const allLibraryTracks: TrackWithRelations[] = allArtistFirstWords.length > 0
      ? await prisma.track.findMany({
          where: tracksOfArtistsStartingWith(allArtistFirstWords),
          include: { album: { include: { artist: { select: { name: true, normalizedName: true } } } } },
        }) as TrackWithRelations[]
      : [];

    // Index by lowercase artist first-word for fast lookup
    const tracksByArtistWord = new Map<string, MatchCandidate[]>();
    for (const track of allLibraryTracks) {
      const artistName = track.album.artist.normalizedName || track.album.artist.name;
      const firstWord = artistName.toLowerCase().split(" ")[0];
      const existing = tracksByArtistWord.get(firstWord) || [];
      existing.push(toMatchCandidate(track));
      tracksByArtistWord.set(firstWord, existing);
    }

    // All artists, for debug logging
    const allArtists = await prisma.artist.findMany({
      where: {
        normalizedName: {
          in: allArtistFirstWords,
          mode: "insensitive",
        },
      },
      select: { name: true, normalizedName: true },
    });
    const artistExistsSet = new Set(
      allArtists.map((a) => (a.normalizedName || a.name).toLowerCase().split(" ")[0]),
    );

    // Matches by ISRC
    const pendingIsrcs = job.pendingTracks
      .filter((t) => t.isrc)
      .map((t) => t.isrc!);
    const isrcMatches = pendingIsrcs.length > 0
      ? new Map(
          (await prisma.track.findMany({
            where: { isrc: { in: pendingIsrcs }, album: { location: LIBRARY_LOCATION } },
            select: { id: true, isrc: true, title: true },
          })).map((t) => [t.isrc!, t]),
        )
      : new Map<string, { id: string; isrc: string; title: string }>();

    // Match all pending tracks against the pre-loaded library
    const matchedTrackIds: string[] = [];
    // Position of each matched track in the original Spotify order, the same
    // scale the pending tracks use.
    const matchedPositions = new Map<string, number>();
    let trackIndex = 0;
    const unmatchedForTitleOnly: Array<{
      pendingTrack: typeof job.pendingTracks[number];
      trackIndex: number;
      strippedTitle: string;
    }> = [];

    for (const pendingTrack of job.pendingTracks) {
      trackIndex++;

      // FAST PATH: pre-matched track ID
      if (pendingTrack.preMatchedTrackId) {
        const existingTrack = verifiedPreMatched.get(pendingTrack.preMatchedTrackId);
        if (existingTrack) {
          matchedTrackIds.push(existingTrack.id);
          if (!matchedPositions.has(existingTrack.id)) matchedPositions.set(existingTrack.id, trackIndex);
          jobLogger?.debug(
            `   ✓ Pre-matched: "${pendingTrack.title}" -> track ${existingTrack.id}`,
          );
          jobLogger?.logTrackMatch(
            trackIndex, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, existingTrack.id,
          );
          continue;
        }
      }

      // ISRC match (Strategy 0 - deterministic)
      if (pendingTrack.isrc) {
        const isrcMatch = isrcMatches.get(pendingTrack.isrc);
        if (isrcMatch) {
          matchedTrackIds.push(isrcMatch.id);
          if (!matchedPositions.has(isrcMatch.id)) matchedPositions.set(isrcMatch.id, trackIndex);
          jobLogger?.debug(`   ISRC match: "${pendingTrack.title}" -> ${isrcMatch.id}`);
          jobLogger?.logTrackMatch(trackIndex, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, isrcMatch.id);
          continue;
        }
      }

      const normalizedArtist = normalizeArtistName(pendingTrack.artist);
      const artistFirstWord = normalizedArtist.split(" ")[0];
      const strippedTitle = stripTrackSuffix(pendingTrack.title);
      const cleanedTitle = normalizeTrackTitle(pendingTrack.title);

      jobLogger?.log(`   Matching: "${pendingTrack.title}" by ${pendingTrack.artist}`);

      const candidates = tracksByArtistWord.get(artistFirstWord.toLowerCase()) || [];

      // The matching ladder lives in one place (services/trackMatching);
      // this path only decides the candidate pool (the artist-word bucket).
      const match = matchTrackToLibrary(
        { title: pendingTrack.title, artist: pendingTrack.artist },
        candidates,
      );

      if (match) {
        matchedTrackIds.push(match.candidate.id);
          if (!matchedPositions.has(match.candidate.id)) matchedPositions.set(match.candidate.id, trackIndex);
        jobLogger?.debug(
          `   ✓ Matched: "${pendingTrack.title}" -> track ${match.candidate.id} (${match.matchType} ${match.confidence}%)`,
        );
        jobLogger?.logTrackMatch(trackIndex, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, match.candidate.id);
      } else if (cleanedTitle.length >= MIN_TITLE_ONLY_LENGTH) {
        // Defer to Strategy 6 batch (title-only, no artist constraint)
        unmatchedForTitleOnly.push({ pendingTrack, trackIndex, strippedTitle });
      } else {
        const artistWord = artistFirstWord.toLowerCase();
        if (artistExistsSet.has(artistWord)) {
          jobLogger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist exists but track not found)`);
        } else {
          jobLogger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`);
        }
        jobLogger?.logTrackMatch(trackIndex, job.tracksTotal, pendingTrack.title, pendingTrack.artist, false);
      }
    }

    // Strategy 6: Title-only batch fallback for remaining unmatched tracks
    if (unmatchedForTitleOnly.length > 0) {
      jobLogger?.log(`   Strategy 6: Title-only batch search for ${unmatchedForTitleOnly.length} remaining tracks`);
      const titleSearchTerms = unmatchedForTitleOnly.map(
        (u) => u.strippedTitle.split(" ").slice(0, 4).join(" "),
      );
      const titleCandidateRows = await prisma.track.findMany({
        where: {
          OR: titleSearchTerms.map((term) => ({
            title: { contains: term, mode: "insensitive" as const },
          })),
        },
        include: { album: { include: { artist: { select: { name: true, normalizedName: true } } } } },
        take: 500,
      });
      const titleCandidates: MatchCandidate[] = titleCandidateRows.map(toMatchCandidate);

      for (const { pendingTrack, trackIndex: tIdx } of unmatchedForTitleOnly) {
        // Same ladder, pool widened to any artist (title-only fallback).
        const match = matchTrackToLibrary(
          { title: pendingTrack.title, artist: pendingTrack.artist },
          titleCandidates,
          { requireArtistMatch: false },
        );
        if (match) {
          matchedTrackIds.push(match.candidate.id);
          jobLogger?.log(
            `      Found via title-only match (${match.confidence}%): "${match.candidate.title}" by ${match.candidate.artistName}`,
          );
          jobLogger?.logTrackMatch(tIdx, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, match.candidate.id);
        } else {
          const artistWord = normalizeArtistName(pendingTrack.artist).split(" ")[0].toLowerCase();
          if (artistExistsSet.has(artistWord)) {
            jobLogger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist exists but track not found)`);
          } else {
            jobLogger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`);
          }
          jobLogger?.logTrackMatch(tIdx, job.tracksTotal, pendingTrack.title, pendingTrack.artist, false);
        }
      }
    }

    const uniqueTrackIds = Array.from(new Set(matchedTrackIds));
    if (uniqueTrackIds.length < matchedTrackIds.length) {
      const removed = matchedTrackIds.length - uniqueTrackIds.length;
      jobLogger?.debug(
        `   Removed ${removed} duplicate track references before playlist creation`,
      );
      jobLogger?.info(
        `Removed ${removed} duplicate track references before playlist creation`,
      );
    }

    jobLogger?.debug(
      `   Matched ${uniqueTrackIds.length}/${job.tracksTotal} tracks`,
    );
    jobLogger?.info(
      `Matched tracks after scan: ${uniqueTrackIds.length}/${job.tracksTotal}`,
    );
    const playlist = await prisma.playlist.create({
      data: {
        userId: job.userId,
        name: job.playlistName,
        isPublic: false,
        spotifyPlaylistId: job.spotifyPlaylistId,
        items:
          uniqueTrackIds.length > 0
            ? {
                create: uniqueTrackIds.map((trackId, index) => ({
                  trackId,
                  sort: index,
                  // Rank from the track's ORIGINAL Spotify position, the same
                  // scale the pending tracks use, so the two interleave into the
                  // playlist's real order rather than forming two sequences.
                  rank: rankForPosition(matchedPositions.get(trackId) ?? index),
                })),
              }
            : undefined,
      },
    });

    // Recalculate unmatched - tracks that weren't added to playlist
    const matchedTitlesNormalized = new Set<string>();
    for (const pendingTrack of job.pendingTracks) {
      const dbArtist = normalizeArtistName(pendingTrack.artist);
      const strippedTitle = stripTrackSuffix(pendingTrack.title);

      const found = await prisma.track.findFirst({
        where: {
          id: { in: uniqueTrackIds },
          title: {
            contains: strippedTitle.split(" ")[0],
            mode: "insensitive",
          },
          album: {
            artist: {
              normalizedName: {
                contains: dbArtist.split(" ")[0],
                mode: "insensitive",
              },
            },
          },
        },
      });

      if (found) {
        matchedTitlesNormalized.add(
          `${dbArtist}|${strippedTitle.toLowerCase()}`,
        );
      }
    }

    const pendingTracksToSave = job.pendingTracks
      .map((track, index) => ({ ...track, originalIndex: index }))
      .filter((track) => {
        const dbArtist = normalizeArtistName(track.artist);
        const strippedTitle = stripTrackSuffix(track.title).toLowerCase();
        return !matchedTitlesNormalized.has(
          `${dbArtist}|${strippedTitle}`,
        );
      });

    if (pendingTracksToSave.length > 0) {
      jobLogger?.debug(
        `   Saving ${pendingTracksToSave.length} pending tracks for future auto-matching`,
      );
      jobLogger?.debug(`   Fetching Deezer preview URLs for pending tracks...`);
      jobLogger?.info(`Saving pending tracks: ${pendingTracksToSave.length}`);

      // Fetch Deezer previews with concurrency limit to avoid overwhelming API
      const DEEZER_PREVIEW_CONCURRENCY = 5;
      const previewQueue = new PQueue({
        concurrency: DEEZER_PREVIEW_CONCURRENCY,
      });

      const pendingTracksWithPreviews = await Promise.all(
        pendingTracksToSave.map((track) =>
          previewQueue.add(async () => {
            let deezerPreviewUrl: string | null = null;
            try {
              deezerPreviewUrl = await deezerService.getTrackPreview(
                track.artist,
                track.title,
              );
            } catch {
              // Preview not critical, continue without it
            }
            return {
              ...track,
              deezerPreviewUrl,
            };
          }),
        ),
      );

      const previewsFound = pendingTracksWithPreviews.filter(
        (t) => t.deezerPreviewUrl,
      ).length;
      jobLogger?.debug(
        `   Found ${previewsFound}/${pendingTracksToSave.length} Deezer preview URLs`,
      );
      jobLogger?.info(
        `Pending previews found: ${previewsFound}/${pendingTracksToSave.length}`,
      );

      await prisma.playlistPendingTrack.createMany({
        data: pendingTracksWithPreviews.map((track) => ({
          playlistId: playlist.id,
          spotifyArtist: track.artist,
          spotifyTitle: track.title,
          spotifyAlbum: track.album,
          albumMbid: track.albumMbid,
          artistMbid: track.artistMbid,
          deezerPreviewUrl: track.deezerPreviewUrl,
          isrc: track.isrc || null,
          sort: track.originalIndex,
          rank: rankForPosition(track.originalIndex),
        })),
        skipDuplicates: true,
      });

      // Auto-retry: attempt per-track Soulseek download for unmatched tracks
      // This runs in the background - tracks will be reconciled on next scan
      this.autoRetryPendingTracks(job, pendingTracksToSave).catch((err) => {
        jobLogger?.debug(`Auto-retry error: ${err.message}`);
      });
    }

    job.createdPlaylistId = playlist.id;
    announcePlaylistChange(job.userId, playlist.id);
    job.tracksMatched = uniqueTrackIds.length;
    job.status = "completed";
    job.progress = 100;
    job.updatedAt = new Date();

    await saveImportJob(job);

    jobLogger?.debug(`[Spotify Import] Job ${job.id} completed:`);
    jobLogger?.debug(`   Playlist created: ${playlist.id}`);
    jobLogger?.debug(
      `   Tracks matched: ${matchedTrackIds.length}/${job.tracksTotal}`,
    );

    jobLogger?.logPlaylistCreated(
      playlist.id,
      matchedTrackIds.length,
      job.tracksTotal,
    );
    jobLogger?.logJobComplete(
      matchedTrackIds.length,
      job.tracksTotal,
      playlist.id,
    );

    try {
      await notificationService.notifyImportComplete(
        job.userId,
        job.playlistName,
        playlist.id,
        matchedTrackIds.length,
        job.tracksTotal,
      );
    } catch (notifError) {
      jobLogger?.error(`Failed to send import notification: ${notifError}`);
    }

    jobLoggers.delete(job.id);
  }

  /** Whether the user an import belongs to may start downloads (#238); a deleted user may not. */
  private async importerMayAcquire(userId: string): Promise<boolean> {
    const importer = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return importer !== null && (await mayAcquire(importer));
  }

  /**
   * Auto-retry unmatched tracks via per-track Soulseek search.
   * Runs in the background after playlist creation. Downloaded tracks
   * will be added to the playlist via reconcilePendingTracks on next scan.
   */
  private async autoRetryPendingTracks(
    job: ImportJob,
    pendingTracks: Array<{
      artist: string;
      title: string;
      album: string;
      albumMbid: string | null;
      artistMbid: string | null;
    }>,
  ): Promise<void> {
    const jobLogger = jobLoggers.get(job.id);

    // Searching and downloading is acquisition (#238); for anyone else the songs stay pending for an operator to retry.
    if (!(await this.importerMayAcquire(job.userId))) {
      jobLogger?.debug(`Auto-retry: this user may not start downloads; ${pendingTracks.length} song(s) stay pending`);
      return;
    }

    const { soulseekService } = await import("./soulseek");
    if (!soulseekService.isConnected()) {
      jobLogger?.debug(`Auto-retry: Soulseek not connected, skipping`);
      return;
    }

    const settings = await getSystemSettings();
    if (!settings?.musicPath) {
      jobLogger?.debug(`Auto-retry: No music path configured, skipping`);
      return;
    }

    jobLogger?.info(
      `Auto-retrying ${pendingTracks.length} unmatched track(s) via per-track search...`,
    );

    let downloadedCount = 0;

    for (const track of pendingTracks) {
      try {
        const searchResult = await soulseekService.searchTrack(
          track.artist,
          track.title,
          track.album !== "Unknown Album" ? track.album : undefined,
        );

        if (!searchResult.found || searchResult.allMatches.length === 0) {
          jobLogger?.debug(
            `Auto-retry: No results for "${track.title}" by ${track.artist}`,
          );
          continue;
        }

        const albumName =
          track.album !== "Unknown Album" ? track.album : track.artist;
        const result = await soulseekService.downloadBestMatch(
          track.artist,
          track.title,
          albumName,
          searchResult.allMatches,
          settings.musicPath,
        );

        if (result.success) {
          downloadedCount++;
          jobLogger?.info(
            `Auto-retry: Downloaded "${track.title}" by ${track.artist}`,
          );
        } else {
          jobLogger?.debug(
            `Auto-retry: Download failed for "${track.title}": ${result.error}`,
          );
        }
      } catch (err: any) {
        jobLogger?.debug(
          `Auto-retry: Error for "${track.title}": ${err.message}`,
        );
      }
    }

    if (downloadedCount > 0) {
      // Trigger library scan - reconcilePendingTracks will add them to the playlist
      const { requestScan } = await import("../workers/scanRequest");
      await requestScan({
        userId: job.userId,
        source: "retry-pending-track",
        priority: 1,
        removeOnComplete: true,
      });
      jobLogger?.info(
        `Auto-retry: ${downloadedCount}/${pendingTracks.length} track(s) downloaded, scan queued`,
      );
    } else {
      jobLogger?.debug(`Auto-retry: No tracks downloaded`);
    }
  }

  /**
   * Re-match pending tracks and add newly downloaded ones to the playlist
   */
  async refreshJobMatches(
    jobId: string,
  ): Promise<{ added: number; total: number }> {
    const jobLogger = jobLoggers.get(jobId);
    const job = await getImportJob(jobId);
    if (!job) {
      throw new Error("Import job not found");
    }
    if (!job.createdPlaylistId) {
      throw new Error("No playlist created for this job");
    }

    let added = 0;

    const existingItems = await prisma.playlistItem.findMany({
      where: { playlistId: job.createdPlaylistId },
      select: { trackId: true },
    });
    const existingTrackIds = new Set(existingItems.map((item) => item.trackId));

    const maxPosition = existingItems.length;
    let nextPosition = maxPosition;

    // Batch-load all candidate tracks matching any pending track's artist
    const uniqueArtists = [
      ...new Set(job.pendingTracks.map((t) => normalizeArtistName(t.artist))),
    ];
    const allCandidates = uniqueArtists.length > 0
      ? await prisma.track.findMany({
          where: {
            album: {
              artist: {
                normalizedName: { in: uniqueArtists },
              },
            },
          },
          include: { album: { include: { artist: true } } },
        })
      : [];

    // Index by normalized artist name for fast lookup
    const candidatesByArtist = new Map<string, typeof allCandidates>();
    for (const track of allCandidates) {
      const key = track.album.artist.normalizedName ?? "";
      const existing = candidatesByArtist.get(key) || [];
      existing.push(track);
      candidatesByArtist.set(key, existing);
    }

    // Match pending tracks in-memory
    const newPlaylistItems: { playlistId: string; trackId: string; sort: number; rank: string }[] = [];
    for (const pendingTrack of job.pendingTracks) {
      const candidates = candidatesByArtist.get(normalizeArtistName(pendingTrack.artist)) || [];

      const localTrack = candidates.find(
        (c) => c.title.toLowerCase() === pendingTrack.title.toLowerCase(),
      );

      if (localTrack && !existingTrackIds.has(localTrack.id)) {
        newPlaylistItems.push({
          playlistId: job.createdPlaylistId,
          trackId: localTrack.id,
          sort: nextPosition++,
          // rank is assigned below, once the count is known
          rank: "",
        });
        existingTrackIds.add(localTrack.id);
        added++;
      }
    }

    // Ranks come from allocateAppendRanks, not rankForPosition: this appends to a
    // playlist that may already hold native tracks, and position keys have a
    // different width ("000" < "C") that would land the batch ahead of them.
    if (newPlaylistItems.length > 0) {
      const ranks = await allocateAppendRanks(
        prisma,
        job.createdPlaylistId,
        newPlaylistItems.length,
      );
      await prisma.playlistItem.createMany({
        data: newPlaylistItems.map((item, i) => ({ ...item, rank: ranks[i] })),
      });
      announcePlaylistChange(job.userId, job.createdPlaylistId);
    }

    job.tracksMatched += added;
    job.updatedAt = new Date();
    await saveImportJob(job);

    jobLogger?.debug(
      `[Spotify Import] Refresh job ${jobId}: added ${added} newly downloaded tracks`,
    );
    jobLogger?.info(
      `Refresh: added ${added} newly downloaded track(s), totalMatchedNow=${job.tracksMatched}`,
    );

    return { added, total: job.tracksMatched };
  }

  /**
   * Get all jobs for a user
   */
  async getUserJobs(userId: string): Promise<ImportJob[]> {
    // Get from database to include jobs across restarts
    const dbJobs = await prisma.spotifyImportJob.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return dbJobs.map(toImportJob);
  }

  /**
   * Remove all DB and Redis artifacts for an import job.
   * Does NOT touch downloaded files on disk (those become part of the library).
   */
  private async cleanupImportArtifacts(jobId: string): Promise<void> {
    await prisma.downloadJob.deleteMany({
      where: {
        metadata: {
          path: ["spotifyImportJobId"],
          equals: jobId,
        },
      },
    });

    try {
      await prisma.spotifyImportJob.delete({ where: { id: jobId } });
    } catch (err: any) {
      // May already be deleted or not yet persisted
      if (err.code !== "P2025") throw err;
    }

    try {
      await redisClient.del(IMPORT_JOB_KEY(jobId));
      await redisClient.del(`import:preview:${jobId}`);
    } catch {
      // Non-critical
    }

    // Clean up job logger
    jobLoggers.delete(jobId);
  }

  /**
   * Cancel an import job.
   * Aborts all in-flight work and removes all DB/Redis traces of the import.
   */
  async cancelJob(jobId: string): Promise<{
    playlistCreated: boolean;
    playlistId: string | null;
    tracksMatched: number;
  }> {
    const job = await getImportJob(jobId);
    if (!job) {
      throw new Error("Import job not found");
    }

    const jobLogger = jobLoggers.get(jobId);
    jobLogger?.debug(`[Spotify Import] Cancelling job ${jobId}...`);
    jobLogger?.info(`Job cancelled by user`);

    // If already completed, nothing to undo
    if (job.status === "completed") {
      return {
        playlistCreated: !!job.createdPlaylistId,
        playlistId: job.createdPlaylistId || null,
        tracksMatched: job.tracksMatched,
      };
    }

    // If already cancelled or failed, just ensure cleanup
    if (job.status === "cancelled" || job.status === "failed") {
      await this.cleanupImportArtifacts(jobId);
      return { playlistCreated: false, playlistId: null, tracksMatched: 0 };
    }

    // Abort in-flight searches and downloads
    const controller = this.activeImportControllers.get(jobId);
    if (controller) controller.abort();

    // Emit cancelled SSE event before cleanup so frontend gets notified
    eventBus.emit({
      type: "import:progress",
      userId: job.userId,
      payload: {
        jobId: job.id,
        playlistName: job.playlistName,
        status: "cancelled",
        progress: 0,
        albumsTotal: job.albumsTotal,
        albumsCompleted: job.albumsCompleted,
        tracksMatched: 0,
        tracksTotal: job.tracksTotal,
        error: null,
      },
    });

    // Full cleanup -- remove all traces from DB and Redis
    await this.cleanupImportArtifacts(jobId);

    jobLogger?.info(`Import cancelled by user — all artifacts removed`);

    return {
      playlistCreated: false,
      playlistId: null,
      tracksMatched: 0,
    };
  }

  /** Add the pending tracks that now match the library: every playlist's after a scan, or one playlist's when named. */
  async reconcilePendingTracks(playlistId?: string): Promise<{
    playlistsUpdated: number;
    tracksAdded: number;
  }> {
    logger.debug(
      `\n[Spotify Import] Reconciling pending tracks across all playlists...`,
    );

    const allPendingTracks = await prisma.playlistPendingTrack.findMany({
      where: playlistId ? { playlistId } : {},
      include: {
        playlist: {
          select: {
            id: true,
            name: true,
            userId: true,
          },
        },
      },
      orderBy: [{ playlistId: "asc" }, { rank: "asc" }],
    });

    if (allPendingTracks.length === 0) {
      logger.debug(`   No pending tracks to reconcile`);
      return { playlistsUpdated: 0, tracksAdded: 0 };
    }

    logger.debug(
      `   Found ${allPendingTracks.length} pending tracks across playlists`,
    );

    let totalTracksAdded = 0;
    const playlistsWithAdditions = new Set<string>();
    const matchedPendingTrackIds: string[] = [];

    // Group by playlist for efficient processing
    const tracksByPlaylist = new Map<string, typeof allPendingTracks>();
    for (const pt of allPendingTracks) {
      const existing = tracksByPlaylist.get(pt.playlistId) || [];
      existing.push(pt);
      tracksByPlaylist.set(pt.playlistId, existing);
    }

    for (const [playlistId, pendingTracks] of tracksByPlaylist) {
      const maxSortResult = await prisma.playlistItem.aggregate({
        where: { playlistId },
        _max: { sort: true },
      });
      let nextSort = (maxSortResult._max.sort ?? -1) + 1;

      // Chained from the playlist's real last rank across both tables, matching
      // the key width addTracks emits.
      let nextRank = (
        await allocateAppendRanks(prisma, playlistId, 1)
      )[0];

      const existingItems = await prisma.playlistItem.findMany({
        where: { playlistId },
        select: { trackId: true },
      });
      const existingTrackIds = new Set(
        existingItems.map((item) => item.trackId),
      );

      for (const pendingTrack of pendingTracks) {
        const dbArtist = normalizeArtistName(pendingTrack.spotifyArtist);
        const artistFirstWord = dbArtist.split(" ")[0];

        // Same pool and ladder as the import itself (services/trackMatching).
        const artistCandidateRows = await prisma.track.findMany({
          where: tracksOfArtistsStartingWith([artistFirstWord]),
          include: { album: { include: { artist: true } } },
        });
        const artistCandidates: MatchCandidate[] = artistCandidateRows.map(toMatchCandidate);

        let match = matchTrackToLibrary(
          {
            title: pendingTrack.spotifyTitle,
            artist: pendingTrack.spotifyArtist,
          },
          artistCandidates,
        );

        // Title-only fallback, as in the import: any artist (compilations,
        // Various Artists), and only for titles long enough to be distinctive.
        if (!match && normalizeTrackTitle(pendingTrack.spotifyTitle).length >= MIN_TITLE_ONLY_LENGTH) {
          const strippedTitle = stripTrackSuffix(pendingTrack.spotifyTitle);
          const titleCandidateRows = await prisma.track.findMany({
            where: {
              title: { contains: strippedTitle.split(" ").slice(0, 4).join(" "), mode: "insensitive" },
            },
            include: { album: { include: { artist: true } } },
            take: 500,
          });
          const titleCandidates: MatchCandidate[] = titleCandidateRows.map(toMatchCandidate);
          match = matchTrackToLibrary(
            {
              title: pendingTrack.spotifyTitle,
              artist: pendingTrack.spotifyArtist,
            },
            titleCandidates,
            { requireArtistMatch: false },
          );
        }

        const localTrack = match
          ? { id: match.candidate.id, title: match.candidate.title }
          : null;

        if (localTrack && !existingTrackIds.has(localTrack.id)) {
          await prisma.playlistItem.create({
            data: {
              playlistId,
              trackId: localTrack.id,
              sort: nextSort++,
              rank: nextRank,
            },
          });
          nextRank = rankAfter(nextRank);

          existingTrackIds.add(localTrack.id);
          matchedPendingTrackIds.push(pendingTrack.id);
          totalTracksAdded++;
          playlistsWithAdditions.add(playlistId);

          logger.debug(
            `   ✓ Matched: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`,
          );
        }
      }
    }

    if (matchedPendingTrackIds.length > 0) {
      await prisma.playlistPendingTrack.deleteMany({
        where: { id: { in: matchedPendingTrackIds } },
      });
    }

    if (playlistsWithAdditions.size > 0) {
      const { notificationService } = await import("./notificationService");

      for (const playlistId of playlistsWithAdditions) {
        const playlist = await prisma.playlist.findUnique({
          where: { id: playlistId },
          select: { id: true, name: true, userId: true },
        });

        if (playlist) {
          announcePlaylistChange(playlist.userId, playlist.id);
          const tracksAddedToPlaylist = matchedPendingTrackIds.filter((id) =>
            allPendingTracks.find(
              (pt) => pt.id === id && pt.playlistId === playlistId,
            ),
          ).length;

          await notificationService.create({
            userId: playlist.userId,
            type: "playlist_ready",
            title: "Playlist Updated",
            message: `${tracksAddedToPlaylist} new track${
              tracksAddedToPlaylist !== 1 ? "s" : ""
            } added to "${playlist.name}"`,
            metadata: {
              playlistId: playlist.id,
              tracksAdded: tracksAddedToPlaylist,
            },
          });
        }
      }
    }

    logger.debug(
      `   Reconciliation complete: ${totalTracksAdded} tracks added to ${playlistsWithAdditions.size} playlists`,
    );

    return {
      playlistsUpdated: playlistsWithAdditions.size,
      tracksAdded: totalTracksAdded,
    };
  }

  /**
   * Start a background preview job and return the job ID immediately.
   * Progress and completion are broadcast via SSE (preview:progress / preview:complete).
   */
  async startPreviewJob(url: string, userId: string): Promise<{ jobId: string }> {
    const jobId = randomUUID();

    (async () => {
      try {
        eventBus.emit({
          type: "preview:progress",
          userId,
          payload: { jobId, phase: "fetching", message: "Fetching playlist..." },
        });

        const emitFetchProgress = (fetched: number, total: number) => {
          eventBus.emit({
            type: "preview:progress",
            userId,
            payload: { jobId, phase: "fetching", message: `Fetching tracks: ${fetched.toLocaleString()} of ${total.toLocaleString()}...` },
          });
        };

        let preview: ImportPreview;
        if (url.includes("deezer.com")) {
          const deezerMatch = url.match(/playlist[\/:](\d+)/);
          if (!deezerMatch) throw new Error("Invalid Deezer playlist URL");
          const deezerPlaylist = await withRetry(() => deezerService.getPlaylist(deezerMatch[1], emitFetchProgress));
          if (!deezerPlaylist) throw new Error("Deezer playlist not found");

          eventBus.emit({
            type: "preview:progress",
            userId,
            payload: { jobId, phase: "matching", message: "Matching tracks to library..." },
          });

          preview = await this.generatePreviewFromDeezer(deezerPlaylist);
        } else if (this.isExternalPlatformUrl(url)) {
          eventBus.emit({
            type: "preview:progress",
            userId,
            payload: { jobId, phase: "matching", message: "Resolving tracks via song.link..." },
          });

          preview = await this.generatePreviewFromExternalPlatform(url);
        } else {
          const emitMatchingStart = () => {
            eventBus.emit({
              type: "preview:progress",
              userId,
              payload: { jobId, phase: "matching", message: "Matching tracks to library..." },
            });
          };

          preview = await this.generatePreview(url, emitFetchProgress, emitMatchingStart);
        }

        await redisClient.setex(
          PREVIEW_JOB_KEY(jobId),
          PREVIEW_JOB_TTL,
          JSON.stringify({ status: "completed", preview, userId }),
        ).catch((e) => logger.error("[Preview Job] Failed to persist result to Redis:", e));

        eventBus.emit({
          type: "preview:complete",
          userId,
          payload: { jobId, preview },
        });
      } catch (error: any) {
        logger.error("[Preview Job] Failed:", error);
        const isNetworkError = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(error.code);
        const userMessage = isNetworkError
            ? "Service temporarily unavailable. Please try again in a moment."
            : (error.message || "Import failed");
        await redisClient.setex(
          PREVIEW_JOB_KEY(jobId),
          PREVIEW_JOB_TTL,
          JSON.stringify({ status: "failed", error: userMessage, userId }),
        ).catch((e) => logger.error("[Preview Job] Failed to persist error state to Redis:", e));
        eventBus.emit({
          type: "preview:complete",
          userId,
          payload: { jobId, error: userMessage },
        });
      }
    })().catch((e) => logger.error("[Preview Job] Unhandled:", e));

    return { jobId };
  }

  /**
   * Retrieve a stored preview result from Redis.
   */
  async getPreviewResult(jobId: string): Promise<{ status: string; preview?: ImportPreview; error?: string; userId?: string } | null> {
    try {
      const raw = await redisClient.get(PREVIEW_JOB_KEY(jobId));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      // A failed cache read counts as no preview yet.
      return null;
    }
  }

  /**
   * Import an M3U playlist, matching entries by file path, then filename, then
   * exact EXTINF artist and title, then fuzzy metadata (token_set_ratio >= 80).
   */
  async importFromM3U(
    userId: string,
    playlistName: string,
    entries: M3UEntry[],
  ): Promise<{ playlistId: string; matched: number; unmatched: number; total: number }> {
    const musicRoot = process.env.MUSIC_PATH || "/music";
    const matchedTrackIds: string[] = [];
    const unmatchedEntries: M3UEntry[] = [];

    for (const entry of entries) {
      let track: { id: string } | null = null;

      // Tier 1: File path match
      // DB stores paths relative to musicRoot (e.g. "Artist/Album/track.flac")
      // M3U may have absolute paths like "/music/Artist/Album/track.flac"
      let relativePath = entry.filePath;
      const musicPrefix = musicRoot.endsWith("/") ? musicRoot : musicRoot + "/";
      if (relativePath.startsWith(musicPrefix)) {
        relativePath = relativePath.slice(musicPrefix.length);
      } else if (relativePath.startsWith("/")) {
        // Try stripping any leading /music/ variant
        const stripped = relativePath.replace(/^\/music\/?/, "");
        if (stripped !== relativePath) {
          relativePath = stripped;
        }
      }

      track = await prisma.track.findFirst({
        where: { filePath: relativePath },
        select: { id: true },
      });

      // Also try the original path as-is (in case DB stores absolute paths)
      if (!track && relativePath !== entry.filePath) {
        track = await prisma.track.findFirst({
          where: { filePath: entry.filePath },
          select: { id: true },
        });
      }

      // Tier 2: Filename match (basename without extension)
      if (!track) {
        const basename = path.basename(entry.filePath, path.extname(entry.filePath));
        if (basename.length >= 3) {
          track = await prisma.track.findFirst({
            where: { filePath: { endsWith: `/${basename}${path.extname(entry.filePath)}` } },
            select: { id: true },
          });
        }
      }

      // Tier 3: Exact metadata match (artist + title from EXTINF)
      if (!track && entry.artist && entry.title) {
        track = await prisma.track.findFirst({
          where: {
            title: { equals: entry.title, mode: "insensitive" },
            album: {
              artist: {
                name: { equals: entry.artist, mode: "insensitive" },
              },
            },
          },
          select: { id: true },
        });

        // Also try with normalizedName
        if (!track) {
          const dbArtist = normalizeArtistName(entry.artist);
          track = await prisma.track.findFirst({
            where: {
              title: { equals: entry.title, mode: "insensitive" },
              album: {
                artist: {
                  normalizedName: dbArtist,
                },
              },
            },
            select: { id: true },
          });
        }
      }

      // Tier 4: Fuzzy metadata match (fuzzball >= 80 threshold)
      if (!track && entry.artist && entry.title) {
        const dbArtist = normalizeArtistName(entry.artist);
        const firstWord = dbArtist.split(" ")[0];
        if (firstWord.length >= 3) {
          const candidates = await prisma.track.findMany({
            where: {
              album: {
                artist: {
                  normalizedName: { contains: firstWord },
                },
              },
            },
            include: {
              album: { include: { artist: { select: { name: true } } } },
            },
            take: 50,
          });

          let bestMatch: { id: string } | null = null;
          let bestScore = 0;

          for (const candidate of candidates) {
            const titleScore = fuzz.token_set_ratio(
              normalizeString(entry.title),
              normalizeString(candidate.title),
            );
            const artistScore = fuzz.token_set_ratio(
              normalizeString(entry.artist),
              normalizeString(candidate.album.artist.name),
            );
            const combined = titleScore * 0.6 + artistScore * 0.4;

            if (combined > bestScore && combined >= 80) {
              bestScore = combined;
              bestMatch = { id: candidate.id };
            }
          }

          track = bestMatch;
        }
      }

      if (track) {
        matchedTrackIds.push(track.id);
      } else {
        unmatchedEntries.push(entry);
      }
    }

    // Deduplicate
    const uniqueTrackIds = [...new Set(matchedTrackIds)];

    const playlist = await prisma.playlist.create({
      data: {
        userId,
        name: playlistName,
        isPublic: false,
        items:
          uniqueTrackIds.length > 0
            ? {
                create: uniqueTrackIds.map((trackId, index) => ({
                  trackId,
                  sort: index,
                  rank: rankForPosition(index),
                })),
              }
            : undefined,
      },
    });

    logger.info(
      `[M3U Import] Created playlist "${playlistName}" (${playlist.id}): ${uniqueTrackIds.length}/${entries.length} matched`,
    );
    announcePlaylistChange(userId, playlist.id);

    return {
      playlistId: playlist.id,
      matched: uniqueTrackIds.length,
      unmatched: unmatchedEntries.length,
      total: entries.length,
    };
  }

  /**
   * Process an import job from the BullMQ worker.
   * Loads the job and cached preview from Redis/DB, then delegates to processImport.
   */
  async processImportFromQueue(importJobId: string, albumMbidsToDownload: string[]): Promise<void> {
    const job = await getImportJob(importJobId);
    if (!job) throw new Error(`Import job ${importJobId} not found`);

    // Retrieve cached preview from Redis
    let preview: ImportPreview | null = null;
    try {
      const cached = await redisClient.get(`import:preview:${importJobId}`);
      if (cached) preview = JSON.parse(cached);
    } catch (e: any) {
      logger.warn(`[Spotify Import] Failed to read preview cache for job ${importJobId}: ${e.message}`);
    }

    if (!preview) {
      throw new Error(`Preview not found for import job ${importJobId}`);
    }

    const jobLogger = createPlaylistLogger(importJobId);
    jobLoggers.set(importJobId, jobLogger);

    try {
      // Permission was checked when the import was queued; it may have been withdrawn since (#238).
      let albums = albumMbidsToDownload;
      if (albums.length > 0 && !(await this.importerMayAcquire(job.userId))) {
        jobLogger.info(`[Spotify Import] Downloads are no longer allowed for this user; importing without the ${albums.length} album(s)`);
        albums = [];
        job.albumsTotal = 0;
      }
      await this.processImport(job, albums, preview);
    } finally {
      jobLoggers.delete(importJobId);
    }
  }

  /**
   * Quick import: skip preview, enqueue everything for background processing.
   * Returns immediately with a jobId.
   */
  async quickImport(
    url: string,
    userId: string,
    playlistName?: string,
  ): Promise<{ jobId: string }> {
    // Normalize URL for dedup (strip query params, trailing slashes, keep host)
    let normalizedUrl: string;
    try {
      const parsed = new URL(url);
      normalizedUrl = parsed.host + parsed.pathname.replace(/\/+$/, "");
    } catch {
      normalizedUrl = url;
    }

    const existingJobs = await this.getUserJobs(userId);
    const activeStatuses = ["pending", "fetching", "downloading", "scanning", "creating_playlist"];
    const activeJob = existingJobs.find(
      (j) => activeStatuses.includes(j.status) && j.sourceUrl === normalizedUrl,
    );
    if (activeJob) {
      return { jobId: activeJob.id };
    }

    const jobId = `import_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Fetch the real playlist name if not provided (lightweight API call)
    let resolvedName = playlistName;
    if (!resolvedName) {
      try {
        if (url.includes("deezer.com")) {
          const deezerMatch = url.match(/playlist[\/:](\d+)/);
          if (deezerMatch) {
            resolvedName = await deezerService.getPlaylistName(deezerMatch[1]) ?? undefined;
          }
        } else if (url.includes("spotify.com")) {
          resolvedName = await spotifyService.getPlaylistName(url) ?? undefined;
        }
      } catch {
        // Non-critical -- fall back to hint
      }
    }

    const job: ImportJob = {
      id: jobId,
      userId,
      spotifyPlaylistId: "",
      playlistName: resolvedName || extractPlaylistHint(url),
      status: "pending",
      progress: 0,
      albumsTotal: 0,
      albumsCompleted: 0,
      tracksMatched: 0,
      tracksTotal: 0,
      tracksDownloadable: 0,
      createdPlaylistId: null,
      error: null,
      sourceUrl: normalizedUrl,
      createdAt: new Date(),
      updatedAt: new Date(),
      pendingTracks: [],
    };

    await saveImportJob(job);

    const { importQueue } = await import("../workers/queues");
    await importQueue.add("import", {
      importJobId: jobId,
      userId,
      quickImport: true,
      url,
      playlistName,
    }, {
      jobId,
    });

    logger.info(`[Quick Import] Enqueued job ${jobId} for ${url}`);
    return { jobId };
  }

  /**
   * Process a quick import from the BullMQ worker.
   * Fetches playlist, matches library, auto-selects all downloadable albums,
   * then delegates to processImport().
   */
  async processQuickImportFromQueue(
    importJobId: string,
    url: string,
    playlistNameOverride?: string,
  ): Promise<void> {
    const job = await getImportJob(importJobId);
    if (!job) throw new Error(`Import job ${importJobId} not found`);

    const jobLogger = createPlaylistLogger(importJobId);
    jobLoggers.set(importJobId, jobLogger);

    try {
      job.status = "fetching";
      await saveImportJob(job);

      jobLogger.info(`[Quick Import] Fetching playlist from ${url}`);

      let preview: ImportPreview;
      if (url.includes("deezer.com")) {
        const deezerMatch = url.match(/playlist[\/:](\d+)/);
        if (!deezerMatch) throw new Error("Invalid Deezer playlist URL");
        const deezerPlaylist = await withRetry(() => deezerService.getPlaylist(deezerMatch[1]));
        if (!deezerPlaylist) throw new Error("Deezer playlist not found");
        preview = await this.generatePreviewFromDeezer(deezerPlaylist);
      } else if (this.isExternalPlatformUrl(url)) {
        preview = await this.generatePreviewFromExternalPlatform(url);
      } else {
        preview = await this.generatePreview(url);
      }

      // Re-read from DB to detect cancellation during the fetch phase
      const freshJob = await getImportJob(importJobId);
      if (!freshJob || freshJob.status === "cancelled") {
        jobLogger.info("[Quick Import] Job cancelled during fetch phase");
        return;
      }

      const resolvedName = playlistNameOverride || preview.playlist.name;
      job.playlistName = resolvedName;
      job.spotifyPlaylistId = preview.playlist.id;
      job.tracksTotal = preview.summary.total;
      job.tracksMatched = preview.summary.inLibrary;
      job.status = "downloading";
      await saveImportJob(job);

      jobLogger.info(`[Quick Import] Playlist: "${resolvedName}" (${preview.summary.total} tracks)`);
      jobLogger.info(`[Quick Import] Already in library: ${preview.summary.inLibrary}, downloadable: ${preview.summary.downloadable}`);

      // Every downloadable album is selected, if this user may start downloads; otherwise the playlist is only
      // matched against the library.
      const albumMbidsToDownload = (await this.importerMayAcquire(job.userId))
        ? preview.albumsToDownload.map((a) => a.albumMbid || a.spotifyAlbumId)
        : [];

      if (albumMbidsToDownload.length === 0) {
        jobLogger.info(`[Quick Import] No albums to download, creating playlist from matched tracks`);
      }

      const tracksFromDownloads = preview.albumsToDownload.reduce(
        (sum, a) => sum + a.tracksNeeded.length, 0,
      );

      const pendingTracks = this.buildPendingTracks(preview);

      // Update job fully before handing off to processImport
      job.albumsTotal = albumMbidsToDownload.length;
      job.tracksDownloadable = tracksFromDownloads;
      job.pendingTracks = pendingTracks;
      await saveImportJob(job);

      // Cache preview for processImport
      try {
        await redisClient.setex(
          `import:preview:${job.id}`,
          IMPORT_JOB_TTL,
          JSON.stringify(preview),
        );
      } catch (e: any) {
        logger.warn(`[Quick Import] Failed to cache preview: ${e.message}`);
      }

      await this.processImport(job, albumMbidsToDownload, preview);
    } finally {
      jobLoggers.delete(importJobId);
    }
  }

  /**
   * Mark an import job as failed (used by the BullMQ worker's failed handler)
   * and tell the user. A job that matched nothing is removed; one that matched
   * some tracks is kept so the user can see what happened.
   */
  async markJobFailed(importJobId: string, errorMessage: string): Promise<void> {
    const job = await getImportJob(importJobId);
    if (!job) return;
    job.error = errorMessage;
    notifyImportFailed(job);

    const hasMatchedTracks = (job.pendingTracks || []).some(
      (t) => t.preMatchedTrackId,
    );

    if (!hasMatchedTracks) {
      logger.info(
        `[Spotify Import] Job ${importJobId} failed with zero matched tracks, cleaning up`,
      );

      eventBus.emit({
        type: "import:progress",
        userId: job.userId,
        payload: {
          jobId: job.id,
          playlistName: job.playlistName,
          status: "failed",
          progress: 0,
          albumsTotal: job.albumsTotal,
          albumsCompleted: job.albumsCompleted,
          tracksMatched: 0,
          tracksTotal: job.tracksTotal,
          error: errorMessage,
        },
      });

      await this.cleanupImportArtifacts(importJobId);
      return;
    }

    job.status = "failed";
    job.updatedAt = new Date();
    await saveImportJob(job);
  }
}

export const spotifyImportService = new SpotifyImportService();
