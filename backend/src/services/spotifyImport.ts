import { randomUUID } from "crypto";
import path from "path";
import { withRetry } from "../utils/async";
import pLimit from "p-limit";
import * as fuzz from "fuzzball";
import { spotifyService, SpotifyTrack, SpotifyPlaylist } from "./spotify";
import { logger } from "../utils/logger";
import { musicBrainzService } from "./musicbrainz";
import { deezerService } from "./deezer";
import {
  createPlaylistLogger,
  logPlaylistEvent,
} from "../utils/playlistLogger";
import { notificationService } from "./notificationService";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import PQueue from "p-queue";
import { acquisitionService } from "./acquisitionService";
import { extractPrimaryArtist, normalizeArtistName } from "../utils/artistNormalization";
import { trackIdentityService } from "./trackIdentity";
import { songLinkService } from "./songlink";
import { eventBus } from "./eventBus";
import { extractPlaylist as ytdlpExtractPlaylist } from "./ytdlp";
import { M3UEntry } from "./m3uParser";
import {
  normalizeString,
  normalizeApostrophes,
  stripTrackSuffix,
  normalizeTrackTitle,
  normalizeAlbumForMatching,
  stringSimilarity,
} from "../utils/normalization";

// Store loggers for each job
const jobLoggers = new Map<string, ReturnType<typeof createPlaylistLogger>>();

/**
 * Spotify Import Service
 *
 * Handles matching Spotify tracks to local library and managing imports
 */

export interface MatchedTrack {
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

export interface AlbumToDownload {
  spotifyAlbumId: string;
  albumName: string;
  artistName: string;
  artistMbid: string | null;
  albumMbid: string | null;
  coverUrl: string | null;
  trackCount: number;
  tracksNeeded: SpotifyTrack[];
}

export interface ImportPreview {
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

export interface ImportJob {
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
    | "matching_tracks"
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

// Redis key pattern for import jobs
const IMPORT_JOB_KEY = (id: string) => `import:job:${id}`;
const IMPORT_JOB_TTL = 24 * 60 * 60; // 24 hours

// Redis key pattern for preview jobs
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
  // Save to database for durability
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

  // Save to Redis for cross-process sharing
  try {
    await redisClient.setEx(
      IMPORT_JOB_KEY(job.id),
      IMPORT_JOB_TTL,
      JSON.stringify(job),
    );
  } catch (error) {
    logger?.warn(`⚠️  Failed to cache import job ${job.id} in Redis:`, error);
    // Continue - Redis is optional, DB is source of truth
  }

  // Emit SSE event for real-time frontend updates
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

/**
 * Get import job from Redis cache or database
 * Redis provides cross-process sharing between API and worker processes
 */
async function getImportJob(importJobId: string): Promise<ImportJob | null> {
  // Try Redis cache first (shared across all processes)
  try {
    const cached = await redisClient.get(IMPORT_JOB_KEY(importJobId));
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    logger?.warn(
      `⚠️  Failed to read import job ${importJobId} from Redis:`,
      error,
    );
    // Fall through to DB
  }

  // Load from database as fallback
  const dbJob = await prisma.spotifyImportJob.findUnique({
    where: { id: importJobId },
  });

  if (!dbJob) return null;

  // Convert database job to ImportJob format
  const job: ImportJob = {
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

  // Populate Redis for next time
  try {
    await redisClient.setEx(
      IMPORT_JOB_KEY(importJobId),
      IMPORT_JOB_TTL,
      JSON.stringify(job),
    );
  } catch (error) {
    logger?.warn(
      `⚠️  Failed to cache import job ${importJobId} in Redis:`,
      error,
    );
    // Continue - Redis is optional
  }

  return job;
}

class SpotifyImportService {
  private activeImportControllers = new Map<string, AbortController>();

  /**
   * Match a Spotify track to the local library
   *
   * Matching strategies (in order):
   * 1. Exact match: artist + album + title (case-insensitive)
   * 2. Normalized album match: artist + normalized album + title
   * 3. Artist + title only: for "Unknown Album" or when album match fails
   * 4. Fuzzy match: similarity-based matching across all tracks by artist
   */
  private async matchTrack(spotifyTrack: SpotifyTrack): Promise<MatchedTrack> {
    const normalizedTitle = normalizeString(spotifyTrack.title);
    const normalizedArtist = normalizeString(spotifyTrack.artist);
    // For DB lookups against normalizedName field (preserves punctuation like R.E.M.)
    const dbNormalizedArtist = normalizeArtistName(spotifyTrack.artist);
    const cleanedTrackTitle = normalizeTrackTitle(spotifyTrack.title);

    // Extract primary artist for better matching (handles "Artist feat. Someone")
    const primaryArtist = extractPrimaryArtist(spotifyTrack.artist);
    // Use normalizeArtistName to match DB storage format (preserves punctuation like R.E.M.)
    const normalizedPrimaryArtist = normalizeArtistName(primaryArtist);

    // Normalize album title (strip edition/remaster suffixes)
    const cleanedAlbum = normalizeAlbumForMatching(spotifyTrack.album);
    const isUnknownAlbum =
      spotifyTrack.album === "Unknown Album" || !spotifyTrack.album;

    // Strategy 0: ISRC match (deterministic -- same recording, guaranteed match)
    if (spotifyTrack.isrc) {
      const isrcMatch = await prisma.track.findFirst({
        where: {
          isrc: spotifyTrack.isrc,
          album: { location: "LIBRARY" },
        },
        include: { album: { include: { artist: true } } },
      });
      if (isrcMatch) {
        return {
          spotifyTrack,
          localTrack: {
            id: isrcMatch.id,
            title: isrcMatch.title,
            albumId: isrcMatch.albumId,
            albumTitle: isrcMatch.album.title,
            artistName: isrcMatch.album.artist.name,
          },
          matchType: "exact",
          matchConfidence: 100,
        };
      }
    }

    // Strategy 1: Exact match by primary artist + album + title
    let exactMatch = await prisma.track.findFirst({
      where: {
        album: {
          artist: {
            normalizedName: normalizedPrimaryArtist,
          },
          title: {
            mode: "insensitive",
            equals: spotifyTrack.album,
          },
        },
        title: {
          mode: "insensitive",
          equals: spotifyTrack.title,
        },
      },
      include: {
        album: {
          include: {
            artist: true,
          },
        },
      },
    });

    // Strategy 1b: Try with full artist name if primary artist didn't match
    if (!exactMatch && primaryArtist !== spotifyTrack.artist) {
      exactMatch = await prisma.track.findFirst({
        where: {
          album: {
            artist: {
              normalizedName: dbNormalizedArtist,
            },
            title: {
              mode: "insensitive",
              equals: spotifyTrack.album,
            },
          },
          title: {
            mode: "insensitive",
            equals: spotifyTrack.title,
          },
        },
        include: {
          album: {
            include: {
              artist: true,
            },
          },
        },
      });
    }

    if (exactMatch) {
      return {
        spotifyTrack,
        localTrack: {
          id: exactMatch.id,
          title: exactMatch.title,
          albumId: exactMatch.albumId,
          albumTitle: exactMatch.album.title,
          artistName: exactMatch.album.artist.name,
        },
        matchType: "exact",
        matchConfidence: 100,
      };
    }

    // Strategy 2: Normalized album match (handles "Album (Deluxe Edition)" vs "Album")
    // Only try if album is not unknown and differs from cleaned version
    if (!isUnknownAlbum && cleanedAlbum !== spotifyTrack.album) {
      let normalizedAlbumMatch = await prisma.track.findFirst({
        where: {
          album: {
            artist: {
              normalizedName: normalizedPrimaryArtist,
            },
            title: {
              mode: "insensitive",
              startsWith: cleanedAlbum,
            },
          },
          title: {
            mode: "insensitive",
            equals: spotifyTrack.title,
          },
        },
        include: {
          album: {
            include: {
              artist: true,
            },
          },
        },
      });

      // Also try: DB album starts with Spotify album (handles Spotify having shorter name)
      if (!normalizedAlbumMatch) {
        // Get all albums by this artist and check if any starts with the cleaned album name
        const artistAlbums = await prisma.album.findMany({
          where: {
            artist: {
              normalizedName: normalizedPrimaryArtist,
            },
          },
          include: {
            tracks: true,
            artist: true,
          },
        });

        for (const album of artistAlbums) {
          const dbAlbumCleaned = normalizeAlbumForMatching(album.title);
          // Check if album names match after normalization
          if (
            dbAlbumCleaned.toLowerCase() === cleanedAlbum.toLowerCase() ||
            dbAlbumCleaned
              .toLowerCase()
              .startsWith(cleanedAlbum.toLowerCase()) ||
            cleanedAlbum.toLowerCase().startsWith(dbAlbumCleaned.toLowerCase())
          ) {
            // Find matching track in this album
            const matchingTrack = album.tracks.find(
              (t) =>
                t.title.toLowerCase() === spotifyTrack.title.toLowerCase() ||
                normalizeTrackTitle(t.title) === cleanedTrackTitle,
            );
            if (matchingTrack) {
              return {
                spotifyTrack,
                localTrack: {
                  id: matchingTrack.id,
                  title: matchingTrack.title,
                  albumId: album.id,
                  albumTitle: album.title,
                  artistName: album.artist.name,
                },
                matchType: "exact",
                matchConfidence: 95,
              };
            }
          }
        }
      }

      if (normalizedAlbumMatch) {
        return {
          spotifyTrack,
          localTrack: {
            id: normalizedAlbumMatch.id,
            title: normalizedAlbumMatch.title,
            albumId: normalizedAlbumMatch.albumId,
            albumTitle: normalizedAlbumMatch.album.title,
            artistName: normalizedAlbumMatch.album.artist.name,
          },
          matchType: "exact",
          matchConfidence: 95,
        };
      }
    }

    // Strategy 3: Artist + title match (ignores album - for "Unknown Album" tracks)
    // This catches tracks where the album metadata is missing from Spotify/Deezer
    const artistTitleMatches = await prisma.track.findMany({
      where: {
        album: {
          artist: {
            normalizedName: normalizedPrimaryArtist,
          },
        },
        OR: [
          { title: { mode: "insensitive", equals: spotifyTrack.title } },
          { title: { mode: "insensitive", equals: cleanedTrackTitle } },
        ],
      },
      include: {
        album: {
          include: {
            artist: true,
          },
        },
      },
      take: 10,
    });

    // Also try with full artist name
    if (
      artistTitleMatches.length === 0 &&
      primaryArtist !== spotifyTrack.artist
    ) {
      const fullArtistMatches = await prisma.track.findMany({
        where: {
          album: {
            artist: {
              normalizedName: dbNormalizedArtist,
            },
          },
          OR: [
            { title: { mode: "insensitive", equals: spotifyTrack.title } },
            { title: { mode: "insensitive", equals: cleanedTrackTitle } },
          ],
        },
        include: {
          album: {
            include: {
              artist: true,
            },
          },
        },
        take: 10,
      });
      artistTitleMatches.push(...fullArtistMatches);
    }

    if (artistTitleMatches.length > 0) {
      // If we have an album hint (not Unknown), prefer tracks from matching album
      if (!isUnknownAlbum) {
        const albumMatch = artistTitleMatches.find((t) => {
          const dbAlbumCleaned = normalizeAlbumForMatching(
            t.album.title,
          ).toLowerCase();
          const spotifyAlbumCleaned = cleanedAlbum.toLowerCase();
          return (
            dbAlbumCleaned === spotifyAlbumCleaned ||
            dbAlbumCleaned.includes(spotifyAlbumCleaned) ||
            spotifyAlbumCleaned.includes(dbAlbumCleaned)
          );
        });
        if (albumMatch) {
          return {
            spotifyTrack,
            localTrack: {
              id: albumMatch.id,
              title: albumMatch.title,
              albumId: albumMatch.albumId,
              albumTitle: albumMatch.album.title,
              artistName: albumMatch.album.artist.name,
            },
            matchType: "exact",
            matchConfidence: 90,
          };
        }
      }

      // Return first match (artist + title matched)
      const match = artistTitleMatches[0];
      return {
        spotifyTrack,
        localTrack: {
          id: match.id,
          title: match.title,
          albumId: match.albumId,
          albumTitle: match.album.title,
          artistName: match.album.artist.name,
        },
        matchType: isUnknownAlbum ? "fuzzy" : "exact",
        matchConfidence: isUnknownAlbum ? 85 : 90,
      };
    }

    // Strategy 4: Fuzzy match by primary artist + title (any album)
    // Use multiple search strategies for better coverage
    let fuzzyMatches: any[] = [];

    // 4a: Search by first word of artist (original strategy)
    const firstWord = normalizedPrimaryArtist.split(" ")[0];
    if (firstWord.length >= 3) {
      fuzzyMatches = await prisma.track.findMany({
        where: {
          album: {
            artist: {
              normalizedName: {
                contains: firstWord,
              },
            },
          },
        },
        include: {
          album: {
            include: {
              artist: true,
            },
          },
        },
        take: 50,
      });
    }

    // 4b: For single-word artist names or if no matches, try startsWith
    if (fuzzyMatches.length === 0) {
      fuzzyMatches = await prisma.track.findMany({
        where: {
          album: {
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
        include: {
          album: {
            include: {
              artist: true,
            },
          },
        },
        take: 50,
      });
    }

    // 4c: Fallback - try with full artist name
    if (fuzzyMatches.length === 0 && primaryArtist !== spotifyTrack.artist) {
      const fullArtistFirstWord = dbNormalizedArtist.split(" ")[0];
      if (fullArtistFirstWord.length >= 3) {
        fuzzyMatches = await prisma.track.findMany({
          where: {
            album: {
              artist: {
                normalizedName: {
                  contains: fullArtistFirstWord,
                },
              },
            },
          },
          include: {
            album: {
              include: {
                artist: true,
              },
            },
          },
          take: 50,
        });
      }
    }

    let bestMatch: any = null;
    let bestScore = 0;

    for (const track of fuzzyMatches) {
      // Use cleaned titles for comparison (strips "- 2011 Remaster", etc.)
      const titleSim = stringSimilarity(
        cleanedTrackTitle,
        normalizeTrackTitle(track.title),
      );
      // Compare against primary artist for better matching
      const artistSim = stringSimilarity(
        normalizedPrimaryArtist,
        normalizeString(track.album.artist.name),
      );

      // Weight: title 60%, artist 40%
      const score = titleSim * 0.6 + artistSim * 0.4;

      if (score > bestScore && score >= 70) {
        bestScore = score;
        bestMatch = track;
      }
    }

    if (bestMatch) {
      return {
        spotifyTrack,
        localTrack: {
          id: bestMatch!.id,
          title: bestMatch!.title,
          albumId: bestMatch!.albumId,
          albumTitle: bestMatch!.album.title,
          artistName: bestMatch!.album.artist.name,
        },
        matchType: "fuzzy",
        matchConfidence: Math.round(bestScore),
      };
    }

    return {
      spotifyTrack,
      localTrack: null,
      matchType: "none",
      matchConfidence: 0,
    };
  }

  /**
   * Look up album info from MusicBrainz for downloading
   */
  private async findAlbumMbid(
    artistName: string,
    albumName: string,
  ): Promise<{ artistMbid: string | null; albumMbid: string | null }> {
    try {
      // Search for artist first
      const artists = await musicBrainzService.searchArtist(artistName, 5);
      if (!artists || artists.length === 0) {
        return { artistMbid: null, albumMbid: null };
      }

      // Find best matching artist
      let bestArtist = artists[0];
      for (const artist of artists) {
        if (normalizeString(artist.name) === normalizeString(artistName)) {
          bestArtist = artist;
          break;
        }
      }

      const artistMbid = bestArtist.id;

      // Search for album by this artist
      const releaseGroups =
        await musicBrainzService.getReleaseGroups(artistMbid);

      for (const rg of releaseGroups || []) {
        if (stringSimilarity(rg.title, albumName) >= 80) {
          return { artistMbid, albumMbid: rg.id };
        }
      }

      return { artistMbid, albumMbid: null };
    } catch (error) {
      logger?.error("MusicBrainz lookup error:", error);
      return { artistMbid: null, albumMbid: null };
    }
  }

  /**
   * Enrich tracks with "Unknown Album" by looking up each track in MusicBrainz
   * This happens BEFORE album grouping so tracks get grouped by their actual albums
   *
   * @param tracks - Array of SpotifyTrack objects (mutated in place)
   * @param logPrefix - Prefix for log messages
   * @returns Stats about resolution success
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

    logger?.info(
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
          logger?.debug(
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

        try {
          logger?.debug(
            `${logPrefix} Looking up: "${track.title}" by ${track.artist}...`,
          );

          const recordingInfo = await musicBrainzService.searchRecording(
            normalizedTitle,
            track.artist,
          );

          if (recordingInfo && recordingInfo.albumName) {
            const result = {
              albumName: recordingInfo.albumName,
              albumId: recordingInfo.albumMbid,
              albumMbid: recordingInfo.albumMbid,
            };
            return { track, cacheKey, result, status: "resolved" as const };
          } else {
            return { track, cacheKey, result: null, status: "failed" as const };
          }
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger?.error(
            `${logPrefix} Error resolving "${track.title}": ${errorMsg}`,
          );
          return { track, cacheKey, result: null, status: "failed" as const };
        }
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
        logger?.info(
          `${logPrefix} Resolved: "${track.title}" -> "${result.albumName}"`,
        );
      } else {
        resolutionCache.set(cacheKey, null);
        failed++;
        logger?.debug(
          `${logPrefix} Could not resolve: "${track.title}" by ${track.artist}`,
        );
      }
    }

    logger?.info(
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
    const lidarrEnabled = !!(previewSettings?.lidarrEnabled && previewSettings?.lidarrUrl && previewSettings?.lidarrApiKey);

    // PHASE 0: Early MusicBrainz resolution for "Unknown Album" tracks
    // This MUST happen BEFORE grouping so tracks get grouped by actual albums
    // Only needed when Lidarr is configured (Soulseek searches by text, not MBID)
    const unknownCount = tracks.filter(
      (t) => t.album === "Unknown Album",
    ).length;

    if (unknownCount > 0 && lidarrEnabled) {
      logger?.info(
        `${logPrefix} Found ${unknownCount} tracks with Unknown Album, attempting MusicBrainz resolution...`,
      );
      try {
        await this.enrichUnknownAlbumsViaMusicBrainz(tracks, logPrefix);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger?.error(
          `${logPrefix} MusicBrainz enrichment failed: ${errorMsg}`,
        );
        // Continue with original tracks - graceful degradation
      }

      // Log remaining unknown after resolution
      const stillUnknown = tracks.filter(
        (t) => t.album === "Unknown Album",
      ).length;
      if (stillUnknown > 0) {
        logger?.info(
          `${logPrefix} ${stillUnknown} tracks still have Unknown Album after MusicBrainz resolution`,
        );
      }
    } else if (unknownCount > 0) {
      logger?.info(
        `${logPrefix} Skipping MusicBrainz resolution for ${unknownCount} Unknown Album tracks (Lidarr not configured)`,
      );
    }

    // Phase 1: Parallel DB lookups (matchTrack is DB-only, safe to parallelise).
    // Capped at 8 concurrent queries to avoid exhausting the Prisma connection pool
    // on large playlists. Promise.all preserves insertion order so matchedTracks[i]
    // corresponds to tracks[i].
    const matchLimit = pLimit(8);
    const matchedTracks: MatchedTrack[] = await Promise.all(
      tracks.map((track) => matchLimit(() => this.matchTrack(track))),
    );

    // Fire-and-forget: store ISRCs on matched tracks
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const matched = matchedTracks[i];
      if (track.isrc && matched.localTrack) {
        trackIdentityService.storeIsrc(
          matched.localTrack.id,
          track.isrc,
          "spotify",
        ).catch(() => {});
      }
    }

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

        logger?.debug(`\n${logPrefix} ========================================`);
        logger?.debug(
          `${logPrefix} Looking up: "${artistName}" - "${albumName}"`,
        );

        if (lidarrEnabled) {
          const wasMbResolved = firstTrack.albumId?.startsWith("mbid:");
          const preResolvedMbid = wasMbResolved
            ? firstTrack.albumId!.replace("mbid:", "")
            : null;

          if (preResolvedMbid) {
            albumMbid = preResolvedMbid;
            logger?.debug(`${logPrefix} Using pre-resolved MBID: ${albumMbid}`);
            const artists = await musicBrainzService.searchArtist(artistName, 1);
            if (artists && artists.length > 0) {
              artistMbid = artists[0].id;
            }
          } else if (albumName && albumName !== "Unknown Album") {
            const normalizedAlbumName = stripTrackSuffix(albumName);
            const wasNormalized = normalizedAlbumName !== albumName;

            logger?.debug(
              `${logPrefix} Searching for album "${albumName}" by ${artistName}...`,
            );
            if (wasNormalized) {
              logger?.debug(
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
              logger?.debug(
                `${logPrefix} ✓ Found album directly: "${albumName}" (MBID: ${albumMbid})`,
              );
            }
          }

          if (!albumMbid) {
            logger?.debug(
              `${logPrefix} Album not found, trying track-based search...`,
            );
            for (const track of albumTracks) {
              const normalizedTrackTitle = stripTrackSuffix(track.title);
              const wasNormalized = normalizedTrackTitle !== track.title;

              logger?.debug(
                `${logPrefix}   Searching for track "${track.title}"...`,
              );
              if (wasNormalized) {
                logger?.debug(
                  `${logPrefix}     → Normalized to: "${normalizedTrackTitle}"`,
                );
              }

              const recordingInfo = await musicBrainzService.searchRecording(
                normalizedTrackTitle,
                artistName,
              );

              if (recordingInfo) {
                resolvedAlbumName = recordingInfo.albumName;
                artistMbid = recordingInfo.artistMbid;
                albumMbid = recordingInfo.albumMbid;

                logger?.debug(
                  `${logPrefix} ✓ Found via track: "${resolvedAlbumName}" (MBID: ${albumMbid})`,
                );
                break;
              }
            }
          }

          if (!albumMbid) {
            logger?.debug(
              `${logPrefix} ✗ Could not find album MBID for ${artistName} - "${resolvedAlbumName}"`,
            );
          }
        } else {
          logger?.info(
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

        logger?.debug(`${logPrefix} Download strategy:`);
        if (albumMbid) {
          logger?.debug(`   Will request album from Lidarr/Soulseek:`);
          logger?.debug(
            `   Artist: "${artistName}" (MBID: ${artistMbid || "NONE"})`,
          );
          logger?.debug(`   Album: "${resolvedAlbumName}" (MBID: ${albumMbid})`);
        } else {
          logger?.debug(
            `   Will request individual tracks via Soulseek (no MBID):`,
          );
          logger?.debug(`   Artist: "${artistName}"`);
          logger?.debug(
            `   Tracks: ${albumTracks.map((t) => `"${t.title}"`).join(", ")}`,
          );
        }
        logger?.debug(`${logPrefix} ========================================\n`);

        return albumToDownload;
      }),
    );

    const inLibrary = matchedTracks.filter((m) => m.localTrack !== null).length;

    // All albums are now downloadable via Soulseek (either album-based with MBID or track-based without)
    const downloadableAlbums = albumsToDownload;

    // No albums are truly "not found" since Soulseek can search for any track
    const notFoundAlbums: AlbumToDownload[] = [];

    const downloadable = downloadableAlbums.reduce(
      (sum, a) => sum + a.tracksNeeded.length,
      0,
    );
    const notFound = notFoundAlbums.reduce(
      (sum, a) => sum + a.tracksNeeded.length,
      0,
    );

    const withMbid = albumsToDownload.filter(a => a.albumMbid).length;
    const withoutMbid = albumsToDownload.length - withMbid;
    logger?.info(
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
        notFound,
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
    // Clear any stale null cache entries before processing
    // This ensures we retry previously failed lookups
    await musicBrainzService.clearStaleRecordingCaches();

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
    // Clear any stale null cache entries before processing
    await musicBrainzService.clearStaleRecordingCaches();

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

    logger?.info(
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
            } catch {}
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
            coverUrl: coverUrl,
          });
        }),
      ),
    );

    // Sort by original track order
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
    // Validate userId to prevent NaN/invalid values from entering the system
    if (
      !userId ||
      typeof userId !== "string" ||
      userId === "NaN" ||
      userId === "undefined" ||
      userId === "null"
    ) {
      logger?.error(
        `[Spotify Import] Invalid userId provided to startImport: ${JSON.stringify(
          {
            userId,
            typeofUserId: typeof userId,
            playlistName,
          },
        )}`,
      );
      throw new Error(`Invalid userId provided: ${userId}`);
    }

    const jobId = `import_${Date.now()}_${Math.random()
      .toString(36)
      .substring(7)}`;

    // Create dedicated logger for this job
    const jobLogger = createPlaylistLogger(jobId);
    jobLoggers.set(jobId, jobLogger);

    jobLogger.logJobStart(playlistName, preview.summary.total, userId);
    jobLogger?.info(`Playlist ID: ${spotifyPlaylistId}`);
    jobLogger?.info(`Albums to download: ${albumMbidsToDownload.length}`);
    jobLogger?.info(`Tracks already in library: ${preview.summary.inLibrary}`);

    // Calculate tracks that will come from downloads
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

    // Save to database and memory cache
    await saveImportJob(job);

    // Cache preview for the BullMQ worker to retrieve
    try {
      await redisClient.setEx(
        `import:preview:${job.id}`,
        IMPORT_JOB_TTL,
        JSON.stringify(preview),
      );
    } catch (e: any) {
      logger?.warn(`[Spotify Import] Failed to cache preview for job ${job.id}: ${e.message}`);
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

    jobLogger?.info(`[Spotify Import] Enqueued job ${job.id} to BullMQ`);

    return job;
  }

  /**
   * Process the import (download albums, create playlist)
   * Now uses AcquisitionService for unified download handling
   */
  private async processImport(
    job: ImportJob,
    albumMbidsToDownload: string[],
    preview: ImportPreview,
  ): Promise<void> {
    const logger = jobLoggers.get(job.id);
    let abortController: AbortController | undefined;

    try {
      // Guard: if cancelled between startImport() and here, abort
      if (job.status === "cancelled") {
        logger?.info("[Spotify Import] Job cancelled before downloading started");
        return;
      }

      // Create AbortController for cancellation support
      abortController = new AbortController();
      const { signal } = abortController;
      this.activeImportControllers.set(job.id, abortController);

      try {
        // Phase 1: Download albums using AcquisitionService
        if (albumMbidsToDownload.length > 0) {
          job.status = "downloading";
          job.updatedAt = new Date();
          await saveImportJob(job);

          logger?.logAlbumDownloadStart(albumMbidsToDownload.length);

          logger?.info(
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
                logger?.debug(
                  `[Spotify Import] Merged ${matchingAlbums.length} album editions for "${album.albumName}" (${mergedTracks.length} unique tracks)`,
                );
              }

              try {
                const isUnknownAlbum =
                  album.albumName === "Unknown Album";

                logger?.info(
                  `Album start: ${album.artistName} - ${album.albumName}${
                    album.albumMbid
                      ? ` [MBID: ${album.albumMbid}]`
                      : " [Unknown Album]"
                  } (tracksNeeded=${album.tracksNeeded.length})`,
                );

                logger?.debug(
                  `[Spotify Import] Requesting: ${album.artistName} - ${album.albumName}`,
                );

                // Validate userId before creating acquisition context
                if (
                  !job.userId ||
                  typeof job.userId !== "string" ||
                  job.userId === "NaN" ||
                  job.userId === "undefined" ||
                  job.userId === "null"
                ) {
                  logger?.error(
                    `[Spotify Import] Invalid userId in job: ${JSON.stringify({
                      jobId: job.id,
                      userId: job.userId,
                      typeofUserId: typeof job.userId,
                    })}`,
                  );
                  throw new Error(`Invalid userId in import job: ${job.userId}`);
                }

                // Acquisition context for tracking
                const context = {
                  userId: job.userId,
                  spotifyImportJobId: job.id,
                  signal,
                };

                let result;

                if (isUnknownAlbum) {
                  // Unknown Album: Use track-based acquisition
                  logger?.debug(
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

                  // Check if at least 50% succeeded
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
                    logger?.info(
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
                    logger?.info(
                      `Album acquisition success: ${album.artistName} - ${album.albumName} via ${result.source}`,
                    );
                  }
                }

                if (!result.success) {
                  const errorMsg =
                    result.error || "No download sources available";
                  logger?.debug(
                    `[Spotify Import] ✗ Failed: ${album.albumName} - ${errorMsg}`,
                  );
                  logger?.logAlbumFailed(
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

                logger?.debug(
                  `Album done: ${album.artistName} - ${
                    album.albumName
                  } (success=${result.success ? "yes" : "no"})`,
                );
              } catch (error: any) {
                if (error?.name === 'AbortError' || signal.aborted) return;
                logger?.error(
                  `[Spotify Import] Failed: ${album.artistName} - ${album.albumName}: ${error.message}`,
                );
                logger?.logAlbumFailed(
                  album.albumName,
                  album.artistName,
                  error.message,
                );
              }
            }, { signal }),
          );

          // Wait for all album acquisitions to complete
          await Promise.all(albumPromises);

          logger?.info(
            `Initial acquisition phase finished for ${albumMbidsToDownload.length} album(s). Checking completion state...`,
          );

          // Poll checkImportCompletion until the job reaches a terminal state.
          // In-process Soulseek downloads complete inline, but Lidarr downloads
          // finish asynchronously via webhook. Poll every 15s, timeout at 30min.
          // BullMQ auto-renews the lock every lockDuration/2 (5 min) as long as
          // the event loop is responsive. The 15s sleep between polls ensures this.
          const POLL_INTERVAL_MS = 15_000;
          const MAX_WAIT_MS = 30 * 60 * 1000;
          const TERMINAL_STATES = ["completed", "failed", "cancelled", "scanning", "creating_playlist"];
          const pollStart = Date.now();

          while (true) {
            if (signal.aborted) {
              logger?.info(`[Spotify Import] Job ${job.id}: aborted during completion poll`);
              return;
            }

            await this.checkImportCompletion(job.id);

            const currentJob = await getImportJob(job.id);
            if (!currentJob) {
              logger?.error(`[Spotify Import] Job ${job.id}: not found during completion poll`);
              return;
            }

            if (TERMINAL_STATES.includes(currentJob.status)) {
              logger?.info(`Import job ${job.id} handed off to next phase: ${currentJob.status}`);
              return;
            }

            if (Date.now() - pollStart > MAX_WAIT_MS) {
              logger?.warn(`[Spotify Import] Job ${job.id}: timed out after 30 minutes, running final completion check`);
              await this.checkImportCompletion(job.id);
              return;
            }

            logger?.debug(`[Spotify Import] Job ${job.id}: still ${currentJob.status}, polling again in 15s...`);
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          }
        }

        // No downloads needed - all tracks already in library
        // Create playlist immediately
        await this.buildPlaylist(job);
      } finally {
        this.activeImportControllers.delete(job.id);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || abortController?.signal.aborted) {
        logger?.info(`[Spotify Import] Job ${job.id}: import cancelled, returning cleanly`);
        return;
      }
      job.status = "failed";
      job.error = error.message;
      job.updatedAt = new Date();
      throw error;
    }
  }

  /**
   * Check if all downloads for this import are complete (called by webhook handler)
   */
  async checkImportCompletion(importJobId: string): Promise<void> {
    logger?.debug(
      `\n[Spotify Import] Checking completion for job ${importJobId}...`,
    );

    const job = await getImportJob(importJobId);
    if (!job) {
      logger?.debug(`   Job not found`);
      jobLoggers.delete(importJobId);
      return;
    }

    // Guard: don't re-process if already past the download phase or still fetching (quick import)
    if (["completed", "failed", "cancelled", "scanning", "creating_playlist", "fetching"].includes(job.status)) {
      logger?.debug(`   Job already in ${job.status} state, skipping`);
      return;
    }

    const jobLogger = jobLoggers.get(importJobId);

    // Check download jobs for this import
    // NOTE: Jobs are created with auto-generated CUIDs, not prefixed IDs
    // The spotifyImportJobId is stored in metadata.spotifyImportJobId
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
      logger?.debug(`   ${message}`);
      jobLogger?.warn(message);

      job.status = "failed";
      job.error = message;
      job.updatedAt = new Date();
      await saveImportJob(job);
      // Clean up job logger to prevent memory leak
      jobLoggers.delete(job.id);
      return;
    }

    logger?.debug(
      `   Download status: ${completed}/${total} completed, ${failed} failed, ${pending} pending`,
    );
    jobLogger?.logDownloadProgress(completed, failed, pending);

    // Update progress
    job.progress =
      total > 0
        ? 30 + Math.round((completed / total) * 40) // 30-70% for downloads
        : 30;
    job.updatedAt = new Date();

    if (pending > 0) {
      // Check how long we've been waiting for these downloads
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
        logger?.debug(
          `   Still waiting for ${pending} downloads... (${waitTimeMins} min elapsed)`,
        );
        jobLogger?.info(`Waiting for Soulseek downloads to complete...`);
        await saveImportJob(job);
        return;
      }

      logger?.debug(
        `   Timeout: ${pending} downloads still pending after ${waitTimeMins} minutes, proceeding anyway`,
      );
      jobLogger?.warn(
        `Download timeout: ${pending} pending after ${waitTimeMins}m, proceeding with available tracks`,
      );

      // Mark stale pending jobs as failed
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
    logger?.debug(`   All downloads finished! Triggering library scan...`);
    jobLogger?.info(
      `All ${total} download jobs finished (${completed} completed, ${failed} failed)`,
    );

    // Trigger library scan to import the new files
    const { scanQueue } = await import("../workers/queues");
    const scanJob = await scanQueue.add("scan", {
      userId: job.userId,
      source: "spotify-import",
      spotifyImportJobId: importJobId,
    });

    jobLogger?.info(
      `Queued library scan (bullJobId=${scanJob.id ?? "unknown"})`,
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
    logger?.debug(
      `\n[Spotify Import] Building playlist for job ${importJobId}...`,
    );

    const job = await getImportJob(importJobId);
    if (!job) {
      logger?.debug(`   Job not found`);
      jobLoggers.delete(importJobId);
      return;
    }

    // Guard: job already reached a terminal state from a previous scan
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      logger?.debug(`   Job already ${job.status}, skipping playlist build`);
      return;
    }

    await this.buildPlaylist(job);
  }

  /**
   * Internal: Build the playlist with matched tracks
   */
  private async buildPlaylist(job: ImportJob): Promise<void> {
    const logger = jobLoggers.get(job.id);

    // Guard: playlist already created for this job
    if (job.createdPlaylistId) {
      logger?.debug(`   Playlist already created: ${job.createdPlaylistId}, skipping`);
      return;
    }

    job.status = "creating_playlist";
    job.progress = 90;
    job.updatedAt = new Date();
    await saveImportJob(job);

    logger?.logPlaylistCreationStart();
    logger?.logTrackMatchingStart();

    // --- Batch pre-load: verify pre-matched track IDs ---
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

    // --- Batch pre-load: all library tracks for relevant artists ---
    const allArtistFirstWords = [
      ...new Set(
        job.pendingTracks.map((t) => normalizeArtistName(t.artist).split(" ")[0]),
      ),
    ];
    type TrackWithRelations = Awaited<ReturnType<typeof prisma.track.findMany>>[number] & {
      album: { artist: { name: string; normalizedName: string | null } };
    };
    const allLibraryTracks: TrackWithRelations[] = allArtistFirstWords.length > 0
      ? await prisma.track.findMany({
          where: {
            album: {
              artist: {
                normalizedName: {
                  in: allArtistFirstWords,
                  mode: "insensitive",
                },
              },
            },
          },
          include: { album: { include: { artist: { select: { name: true, normalizedName: true } } } } },
        }) as TrackWithRelations[]
      : [];

    // Index by lowercase artist first-word for fast lookup
    const tracksByArtistWord = new Map<string, TrackWithRelations[]>();
    for (const track of allLibraryTracks) {
      const artistName = track.album.artist.normalizedName || track.album.artist.name;
      const firstWord = artistName.toLowerCase().split(" ")[0];
      const existing = tracksByArtistWord.get(firstWord) || [];
      existing.push(track);
      tracksByArtistWord.set(firstWord, existing);
    }

    // --- Batch pre-load: all artists (for debug logging) ---
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

    // --- Batch pre-load: ISRC-based matches ---
    const pendingIsrcs = job.pendingTracks
      .filter((t) => t.isrc)
      .map((t) => t.isrc!);
    const isrcMatches = pendingIsrcs.length > 0
      ? new Map(
          (await prisma.track.findMany({
            where: { isrc: { in: pendingIsrcs }, album: { location: "LIBRARY" } },
            select: { id: true, isrc: true, title: true },
          })).map((t) => [t.isrc!, t]),
        )
      : new Map<string, { id: string; isrc: string; title: string }>();

    // Match all pending tracks against the pre-loaded library
    const matchedTrackIds: string[] = [];
    let trackIndex = 0;
    const unmatchedForTitleOnly: Array<{
      pendingTrack: typeof job.pendingTracks[number];
      trackIndex: number;
      cleanedTitle: string;
      strippedTitle: string;
    }> = [];

    for (const pendingTrack of job.pendingTracks) {
      trackIndex++;

      // FAST PATH: pre-matched track ID
      if (pendingTrack.preMatchedTrackId) {
        const existingTrack = verifiedPreMatched.get(pendingTrack.preMatchedTrackId);
        if (existingTrack) {
          matchedTrackIds.push(existingTrack.id);
          logger?.debug(
            `   ✓ Pre-matched: "${pendingTrack.title}" -> track ${existingTrack.id}`,
          );
          logger?.logTrackMatch(
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
          logger?.debug(`   ISRC match: "${pendingTrack.title}" -> ${isrcMatch.id}`);
          logger?.logTrackMatch(trackIndex, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, isrcMatch.id);
          continue;
        }
      }

      const normalizedArtist = normalizeArtistName(pendingTrack.artist);
      const artistFirstWord = normalizedArtist.split(" ")[0];
      const strippedTitle = stripTrackSuffix(pendingTrack.title);
      const normalizedTitle = normalizeApostrophes(pendingTrack.title);
      const cleanedTitle = normalizeTrackTitle(pendingTrack.title);

      logger?.log(`   Matching: "${pendingTrack.title}" by ${pendingTrack.artist}`);

      // Get candidates for this artist from pre-loaded index
      const candidates = tracksByArtistWord.get(artistFirstWord.toLowerCase()) || [];

      let localTrack: TrackWithRelations | null = null;

      // Strategy 1: Exact title match (case-insensitive)
      localTrack = candidates.find(
        (c) => c.title.toLowerCase() === normalizedTitle.toLowerCase(),
      ) || null;

      // Strategy 2: Stripped title match
      if (!localTrack && strippedTitle !== normalizedTitle) {
        logger?.log(`   Strategy 2: Stripped title "${strippedTitle}"`);
        localTrack = candidates.find(
          (c) => c.title.toLowerCase() === strippedTitle.toLowerCase(),
        ) || null;
      }

      // Strategy 3: Contains + similarity/containment
      if (!localTrack && strippedTitle.length >= 5) {
        const searchTerm = strippedTitle.split(" ").slice(0, 4).join(" ").toLowerCase();
        logger?.log(`   Strategy 3: Contains search for "${searchTerm}"`);
        for (const candidate of candidates) {
          if (!candidate.title.toLowerCase().includes(searchTerm)) continue;
          const candidateNormalized = normalizeTrackTitle(candidate.title);
          const sim = stringSimilarity(cleanedTitle, candidateNormalized);
          if (sim >= 80) {
            localTrack = candidate;
            logger?.log(`      Found via contains+similarity (${sim.toFixed(0)}%)`);
            break;
          }
          const spotifyNorm = cleanedTitle.toLowerCase();
          const libraryNorm = candidateNormalized.toLowerCase();
          if (libraryNorm.startsWith(spotifyNorm) || spotifyNorm.startsWith(libraryNorm)) {
            localTrack = candidate;
            logger?.log(`      Found via containment match`);
            break;
          }
        }
      }

      // Strategy 3.5: Fuzzy artist+title scoring
      if (!localTrack) {
        logger?.log(`   Strategy 3.5: Fuzzy artist+title matching`);
        for (const candidate of candidates) {
          const titleSim = stringSimilarity(cleanedTitle, normalizeTrackTitle(candidate.title));
          const artistSim = stringSimilarity(pendingTrack.artist, candidate.album.artist.name);
          const score = titleSim * 0.6 + artistSim * 0.4;
          if (score >= 70) {
            localTrack = candidate;
            logger?.debug(`      (preview-style match: ${score.toFixed(0)}%)`);
            break;
          }
        }
      }

      // Strategy 4: StartsWith match
      if (!localTrack && strippedTitle.length > 10) {
        logger?.log(`   Strategy 4: StartsWith search`);
        const prefix = strippedTitle.substring(0, Math.min(20, strippedTitle.length)).toLowerCase();
        const match = candidates.find((c) => c.title.toLowerCase().startsWith(prefix));
        if (match) {
          const dbTitleNormalized = normalizeTrackTitle(match.title);
          if (stringSimilarity(cleanedTitle, dbTitleNormalized) >= 70) {
            localTrack = match;
            logger?.log(`      Found via startsWith`);
          }
        }
      }

      // Strategy 5: Fuzzy scoring (last resort with artist constraint)
      if (!localTrack) {
        logger?.log(`   Strategy 5: Fuzzy search (last resort)`);
        let bestMatch: TrackWithRelations | null = null;
        let bestScore = 0;
        for (const candidate of candidates) {
          const titleScore = stringSimilarity(cleanedTitle, normalizeTrackTitle(candidate.title));
          const artistScore = stringSimilarity(normalizeString(pendingTrack.artist), normalizeString(candidate.album.artist.name));
          const combinedScore = titleScore * 0.7 + artistScore * 0.3;
          if (combinedScore > bestScore && combinedScore >= 65) {
            bestScore = combinedScore;
            bestMatch = candidate;
          }
        }
        if (bestMatch) {
          localTrack = bestMatch;
          logger?.debug(
            `      (fuzzy match: score ${bestScore.toFixed(0)}% with "${bestMatch.title}" by ${bestMatch.album.artist.name})`,
          );
        }
      }

      if (localTrack) {
        matchedTrackIds.push(localTrack.id);
        logger?.debug(`   ✓ Matched: "${pendingTrack.title}" -> track ${localTrack.id}`);
        logger?.logTrackMatch(trackIndex, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, localTrack.id);
      } else if (cleanedTitle.length >= 10) {
        // Defer to Strategy 6 batch (title-only, no artist constraint)
        unmatchedForTitleOnly.push({ pendingTrack, trackIndex, cleanedTitle, strippedTitle });
      } else {
        const artistWord = artistFirstWord.toLowerCase();
        if (artistExistsSet.has(artistWord)) {
          logger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist exists but track not found)`);
        } else {
          logger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`);
        }
        logger?.logTrackMatch(trackIndex, job.tracksTotal, pendingTrack.title, pendingTrack.artist, false);
      }
    }

    // Strategy 6: Title-only batch fallback for remaining unmatched tracks
    if (unmatchedForTitleOnly.length > 0) {
      logger?.log(`   Strategy 6: Title-only batch search for ${unmatchedForTitleOnly.length} remaining tracks`);
      const titleSearchTerms = unmatchedForTitleOnly.map(
        (u) => u.strippedTitle.split(" ").slice(0, 4).join(" "),
      );
      const titleCandidates = await prisma.track.findMany({
        where: {
          OR: titleSearchTerms.map((term) => ({
            title: { contains: term, mode: "insensitive" as const },
          })),
        },
        include: { album: { include: { artist: { select: { name: true, normalizedName: true } } } } },
        take: 500,
      });

      for (const { pendingTrack, trackIndex: tIdx, cleanedTitle } of unmatchedForTitleOnly) {
        let bestTitleMatch: typeof titleCandidates[number] | null = null;
        let bestTitleScore = 0;
        for (const candidate of titleCandidates) {
          const titleScore = stringSimilarity(cleanedTitle, normalizeTrackTitle(candidate.title));
          if (titleScore > bestTitleScore && titleScore >= 85) {
            bestTitleScore = titleScore;
            bestTitleMatch = candidate;
          }
        }
        if (bestTitleMatch) {
          matchedTrackIds.push(bestTitleMatch.id);
          logger?.log(
            `      Found via title-only match (${bestTitleScore.toFixed(0)}%): "${bestTitleMatch.title}" by ${bestTitleMatch.album.artist.name}`,
          );
          logger?.logTrackMatch(tIdx, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, bestTitleMatch.id);
        } else {
          const artistWord = normalizeArtistName(pendingTrack.artist).split(" ")[0].toLowerCase();
          if (artistExistsSet.has(artistWord)) {
            logger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist exists but track not found)`);
          } else {
            logger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`);
          }
          logger?.logTrackMatch(tIdx, job.tracksTotal, pendingTrack.title, pendingTrack.artist, false);
        }
      }
    }

    const uniqueTrackIds = Array.from(new Set(matchedTrackIds));
    if (uniqueTrackIds.length < matchedTrackIds.length) {
      const removed = matchedTrackIds.length - uniqueTrackIds.length;
      logger?.debug(
        `   Removed ${removed} duplicate track references before playlist creation`,
      );
      logger?.info(
        `Removed ${removed} duplicate track references before playlist creation`,
      );
    }

    logger?.debug(
      `   Matched ${uniqueTrackIds.length}/${job.tracksTotal} tracks`,
    );
    logger?.info(
      `Matched tracks after scan: ${uniqueTrackIds.length}/${job.tracksTotal}`,
    );
    // Create the playlist with Spotify metadata
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

      // Check if this track was matched by looking for it in the created items
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

    // Save pending tracks that weren't matched
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
      logger?.debug(
        `   Saving ${pendingTracksToSave.length} pending tracks for future auto-matching`,
      );
      logger?.debug(`   Fetching Deezer preview URLs for pending tracks...`);
      logger?.info(`Saving pending tracks: ${pendingTracksToSave.length}`);

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
            } catch (e) {
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
      logger?.debug(
        `   Found ${previewsFound}/${pendingTracksToSave.length} Deezer preview URLs`,
      );
      logger?.info(
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
        })),
        skipDuplicates: true,
      });

      // Auto-retry: attempt per-track Soulseek download for unmatched tracks
      // This runs in the background - tracks will be reconciled on next scan
      this.autoRetryPendingTracks(job, pendingTracksToSave).catch((err) => {
        logger?.debug(`Auto-retry error: ${err.message}`);
      });
    }

    job.createdPlaylistId = playlist.id;
    job.tracksMatched = uniqueTrackIds.length;
    job.status = "completed";
    job.progress = 100;
    job.updatedAt = new Date();

    // Fire-and-forget genre enrichment for matched tracks with ISRCs
    this.enrichMatchedTrackGenres(job).catch((err) =>
      logger?.warn(`Genre enrichment failed: ${err.message}`),
    );

    await saveImportJob(job);

    logger?.debug(`[Spotify Import] Job ${job.id} completed:`);
    logger?.debug(`   Playlist created: ${playlist.id}`);
    logger?.debug(
      `   Tracks matched: ${matchedTrackIds.length}/${job.tracksTotal}`,
    );

    logger?.logPlaylistCreated(
      playlist.id,
      matchedTrackIds.length,
      job.tracksTotal,
    );
    logger?.logJobComplete(
      matchedTrackIds.length,
      job.tracksTotal,
      playlist.id,
    );

    // Send notification about import completion
    try {
      await notificationService.notifyImportComplete(
        job.userId,
        job.playlistName,
        playlist.id,
        matchedTrackIds.length,
        job.tracksTotal,
      );
    } catch (notifError) {
      logger?.error(`Failed to send import notification: ${notifError}`);
    }

    // Clean up job logger to prevent memory leak
    jobLoggers.delete(job.id);
  }

  private async enrichMatchedTrackGenres(job: ImportJob): Promise<void> {
    const logger = jobLoggers.get(job.id);

    const tracksWithIsrc = await prisma.track.findMany({
      where: {
        isrc: { not: null },
        trackGenres: { none: {} },
        playlistItems: job.createdPlaylistId
          ? { some: { playlistId: job.createdPlaylistId } }
          : undefined,
      },
      select: { id: true, isrc: true, title: true },
      take: 200,
    });

    if (tracksWithIsrc.length === 0) return;
    logger?.debug(
      `Enriching genres for ${tracksWithIsrc.length} tracks via MusicBrainz ISRC`,
    );

    let enriched = 0;
    for (const track of tracksWithIsrc) {
      try {
        const recording = await musicBrainzService.lookupByIsrc(track.isrc!);
        if (!recording) continue;

        const genreData = await musicBrainzService.getRecordingGenres(
          recording.recordingId,
        );
        if (!genreData || genreData.genres.length === 0) continue;

        const topGenres = genreData.genres
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
          .map((g) => g.name);

        await trackIdentityService.populateTrackGenres(track.id, topGenres);

        const existingTrack = await prisma.track.findUnique({
          where: { id: track.id },
          select: { lastfmTags: true },
        });
        if (
          existingTrack &&
          existingTrack.lastfmTags.length === 0 &&
          genreData.tags.length > 0
        ) {
          const moodTags = genreData.tags
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map((t) => t.name);
          await prisma.track.update({
            where: { id: track.id },
            data: { lastfmTags: moodTags },
          });
        }

        enriched++;
      } catch {
        // Non-fatal -- continue with next track
      }
    }

    logger?.debug(
      `Genre enrichment complete: ${enriched}/${tracksWithIsrc.length} tracks enriched`,
    );
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
    const logger = jobLoggers.get(job.id);

    const { soulseekService } = await import("./soulseek");
    if (!soulseekService.isConnected()) {
      logger?.debug(`Auto-retry: Soulseek not connected, skipping`);
      return;
    }

    const settings = await getSystemSettings();
    if (!settings?.musicPath) {
      logger?.debug(`Auto-retry: No music path configured, skipping`);
      return;
    }

    logger?.info(
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
          logger?.debug(
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
          settings.downloadPath || settings.musicPath,
        );

        if (result.success) {
          downloadedCount++;
          logger?.info(
            `Auto-retry: Downloaded "${track.title}" by ${track.artist}`,
          );
        } else {
          logger?.debug(
            `Auto-retry: Download failed for "${track.title}": ${result.error}`,
          );
        }
      } catch (err: any) {
        logger?.debug(
          `Auto-retry: Error for "${track.title}": ${err.message}`,
        );
      }
    }

    if (downloadedCount > 0) {
      // Trigger library scan - reconcilePendingTracks will add them to the playlist
      const { scanQueue } = await import("../workers/queues");
      await scanQueue.add(
        "scan",
        {
          userId: job.userId,
          source: "retry-pending-track",
        },
        {
          priority: 1,
          removeOnComplete: true,
        },
      );
      logger?.info(
        `Auto-retry: ${downloadedCount}/${pendingTracks.length} track(s) downloaded, scan queued`,
      );
    } else {
      logger?.debug(`Auto-retry: No tracks downloaded`);
    }
  }

  /**
   * Re-match pending tracks and add newly downloaded ones to the playlist
   */
  async refreshJobMatches(
    jobId: string,
  ): Promise<{ added: number; total: number }> {
    const logger = jobLoggers.get(jobId);
    const job = await getImportJob(jobId);
    if (!job) {
      throw new Error("Import job not found");
    }
    if (!job.createdPlaylistId) {
      throw new Error("No playlist created for this job");
    }

    let added = 0;

    // Get existing tracks in playlist
    const existingItems = await prisma.playlistItem.findMany({
      where: { playlistId: job.createdPlaylistId },
      select: { trackId: true },
    });
    const existingTrackIds = new Set(existingItems.map((item) => item.trackId));

    // Get next position
    const maxPosition = existingItems.length;
    let nextPosition = maxPosition;

    // Batch-load all candidate tracks matching any pending track's artist
    const uniqueArtists = [
      ...new Set(job.pendingTracks.map((t) => normalizeString(t.artist))),
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
      const key = track.album.artist.normalizedName?.toLowerCase() || "";
      const existing = candidatesByArtist.get(key) || [];
      existing.push(track);
      candidatesByArtist.set(key, existing);
    }

    // Match pending tracks in-memory
    const newPlaylistItems: { playlistId: string; trackId: string; sort: number }[] = [];
    for (const pendingTrack of job.pendingTracks) {
      const dbArtist = normalizeArtistName(pendingTrack.artist);
      const candidates = candidatesByArtist.get(dbArtist.toLowerCase()) || [];

      const localTrack = candidates.find(
        (c) => c.title.toLowerCase() === pendingTrack.title.toLowerCase(),
      );

      if (localTrack && !existingTrackIds.has(localTrack.id)) {
        newPlaylistItems.push({
          playlistId: job.createdPlaylistId,
          trackId: localTrack.id,
          sort: nextPosition++,
        });
        existingTrackIds.add(localTrack.id);
        added++;
      }
    }

    // Batch insert all new playlist items
    if (newPlaylistItems.length > 0) {
      await prisma.playlistItem.createMany({ data: newPlaylistItems });
    }

    job.tracksMatched += added;
    job.updatedAt = new Date();
    await saveImportJob(job);

    logger?.debug(
      `[Spotify Import] Refresh job ${jobId}: added ${added} newly downloaded tracks`,
    );
    logger?.info(
      `Refresh: added ${added} newly downloaded track(s), totalMatchedNow=${job.tracksMatched}`,
    );

    return { added, total: job.tracksMatched };
  }

  /**
   * Get import job status (public method for routes)
   */
  async getJob(jobId: string): Promise<ImportJob | null> {
    return await getImportJob(jobId);
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

    return dbJobs
      .map((dbJob) => ({
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
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Remove all DB and Redis artifacts for an import job.
   * Does NOT touch downloaded files on disk (those become part of the library).
   */
  private async cleanupImportArtifacts(jobId: string, userId: string): Promise<void> {
    // Delete all download jobs associated with this import
    await prisma.downloadJob.deleteMany({
      where: {
        metadata: {
          path: ["spotifyImportJobId"],
          equals: jobId,
        },
      },
    });

    // Delete the import job from Postgres
    try {
      await prisma.spotifyImportJob.delete({ where: { id: jobId } });
    } catch (err: any) {
      // May already be deleted or not yet persisted
      if (err.code !== "P2025") throw err;
    }

    // Delete from Redis
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
      await this.cleanupImportArtifacts(jobId, job.userId);
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
    await this.cleanupImportArtifacts(jobId, job.userId);

    jobLogger?.info(`Import cancelled by user — all artifacts removed`);

    return {
      playlistCreated: false,
      playlistId: null,
      tracksMatched: 0,
    };
  }

  /**
   * Reconcile pending tracks for ALL playlists after a library scan
   * This checks if any previously unmatched tracks now have matches in the library
   * and automatically adds them to their playlists
   */
  async reconcilePendingTracks(): Promise<{
    playlistsUpdated: number;
    tracksAdded: number;
  }> {
    logger?.debug(
      `\n[Spotify Import] Reconciling pending tracks across all playlists...`,
    );

    // Get all pending tracks grouped by playlist
    const allPendingTracks = await prisma.playlistPendingTrack.findMany({
      include: {
        playlist: {
          select: {
            id: true,
            name: true,
            userId: true,
          },
        },
      },
      orderBy: [{ playlistId: "asc" }, { sort: "asc" }],
    });

    if (allPendingTracks.length === 0) {
      logger?.debug(`   No pending tracks to reconcile`);
      return { playlistsUpdated: 0, tracksAdded: 0 };
    }

    logger?.debug(
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
      // Get current max sort position in playlist
      const maxSortResult = await prisma.playlistItem.aggregate({
        where: { playlistId },
        _max: { sort: true },
      });
      let nextSort = (maxSortResult._max.sort ?? -1) + 1;

      // Get existing track IDs in playlist to avoid duplicates
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
        const strippedTitle = stripTrackSuffix(pendingTrack.spotifyTitle);
        const cleanedTitle = normalizeTrackTitle(strippedTitle);

        // Try to find a matching track (using same strategies as buildPlaylist)
        // Strategy 1: Stripped title + fuzzy artist (contains first word)
        let localTrack = await prisma.track.findFirst({
          where: {
            title: { equals: strippedTitle, mode: "insensitive" },
            album: {
              artist: {
                normalizedName: {
                  contains: artistFirstWord,
                  mode: "insensitive",
                },
              },
            },
          },
          select: { id: true, title: true },
        });

        logger?.debug(
          `      Strategy 1 result: ${localTrack ? "FOUND" : "not found"}`,
        );

        // Strategy 2: Contains search on first few words + similarity
        if (!localTrack && strippedTitle.length >= 5) {
          const searchTerm = strippedTitle.split(" ").slice(0, 4).join(" ");
          logger?.debug(
            `      Strategy 2: Contains search for "${searchTerm}"`,
          );
          const candidates = await prisma.track.findMany({
            where: {
              title: {
                contains: searchTerm,
                mode: "insensitive",
              },
              album: {
                artist: {
                  normalizedName: {
                    contains: artistFirstWord,
                    mode: "insensitive",
                  },
                },
              },
            },
            include: { album: { include: { artist: true } } },
            take: 10,
          });

          logger?.debug(
            `      Strategy 2: Found ${candidates.length} candidates`,
          );
          for (const candidate of candidates) {
            const candidateNormalized = normalizeTrackTitle(candidate.title);
            const sim = stringSimilarity(cleanedTitle, candidateNormalized);
            logger?.debug(
              `         "${candidate.title}" by ${
                candidate.album.artist.name
              }: ${sim.toFixed(0)}%`,
            );

            // Direct similarity match
            if (sim >= 80) {
              localTrack = {
                id: candidate.id,
                title: candidate.title,
              };
              break;
            }

            // Containment match: "Sordid Affair" should match "Sordid Affair (Feat. Ryan James)"
            const spotifyNorm = cleanedTitle.toLowerCase();
            const libraryNorm = candidateNormalized.toLowerCase();
            if (
              libraryNorm.startsWith(spotifyNorm) ||
              spotifyNorm.startsWith(libraryNorm)
            ) {
              logger?.debug(
                `         Found via containment: "${cleanedTitle}" starts "${candidateNormalized}"`,
              );
              localTrack = {
                id: candidate.id,
                title: candidate.title,
              };
              break;
            }
          }
        }

        if (!localTrack) logger?.debug(`      Strategy 2 result: not found`);

        // Strategy 3: Fuzzy match on title + artist similarity
        if (!localTrack) {
          const firstWord = strippedTitle.split(" ")[0];
          logger?.debug(
            `      Strategy 3: Fuzzy search for title containing "${firstWord}" and artist containing "${artistFirstWord}"`,
          );
          const candidates = await prisma.track.findMany({
            where: {
              title: { contains: firstWord, mode: "insensitive" },
              album: {
                artist: {
                  normalizedName: {
                    contains: artistFirstWord,
                    mode: "insensitive",
                  },
                },
              },
            },
            include: { album: { include: { artist: true } } },
            take: 20,
          });

          logger?.debug(
            `      Strategy 3: Found ${candidates.length} candidates`,
          );
          for (const candidate of candidates) {
            const titleScore = stringSimilarity(
              cleanedTitle,
              normalizeTrackTitle(candidate.title),
            );
            const artistScore = stringSimilarity(
              pendingTrack.spotifyArtist,
              candidate.album.artist.name,
            );
            const combinedScore = titleScore * 0.6 + artistScore * 0.4;
            logger?.debug(
              `         "${candidate.title}" by ${
                candidate.album.artist.name
              }: title=${titleScore.toFixed(0)}%, artist=${artistScore.toFixed(
                0,
              )}%, combined=${combinedScore.toFixed(0)}%`,
            );

            if (combinedScore >= 70) {
              localTrack = {
                id: candidate.id,
                title: candidate.title,
              };
              break;
            }
          }
        }

        // Strategy 4: Title-only match with artist scoring (for compilations / Various Artists)
        if (!localTrack) {
          logger?.debug(
            `      Strategy 4: Title-only match for "${strippedTitle}" (compilation fallback)`,
          );
          const candidates = await prisma.track.findMany({
            where: {
              title: { equals: strippedTitle, mode: "insensitive" },
            },
            include: { album: { include: { artist: true } } },
            take: 10,
          });

          if (candidates.length > 0) {
            // Score by artist name similarity, pick best match
            const scored = candidates.map((c) => ({
              candidate: c,
              score: stringSimilarity(
                pendingTrack.spotifyArtist,
                c.album.artist.name,
              ),
            }));
            scored.sort((a, b) => b.score - a.score);

            const best = scored[0];
            logger?.debug(
              `      Strategy 4: Best match "${best.candidate.title}" by ${best.candidate.album.artist.name} (artist score: ${best.score.toFixed(0)}%)`,
            );

            // Accept if artist similarity is reasonable (>= 40%) or if there's only one candidate
            if (best.score >= 40 || candidates.length === 1) {
              localTrack = {
                id: best.candidate.id,
                title: best.candidate.title,
              };
            }
          }
        }

        if (localTrack && !existingTrackIds.has(localTrack.id)) {
          // Add to playlist
          await prisma.playlistItem.create({
            data: {
              playlistId,
              trackId: localTrack.id,
              sort: nextSort++,
            },
          });

          existingTrackIds.add(localTrack.id);
          matchedPendingTrackIds.push(pendingTrack.id);
          totalTracksAdded++;
          playlistsWithAdditions.add(playlistId);

          logger?.debug(
            `   ✓ Matched: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`,
          );
        }
      }
    }

    // Delete the matched pending tracks
    if (matchedPendingTrackIds.length > 0) {
      await prisma.playlistPendingTrack.deleteMany({
        where: { id: { in: matchedPendingTrackIds } },
      });
    }

    // Send notifications for each playlist that was updated
    if (playlistsWithAdditions.size > 0) {
      const { notificationService } = await import("./notificationService");

      for (const playlistId of playlistsWithAdditions) {
        const playlist = await prisma.playlist.findUnique({
          where: { id: playlistId },
          select: { id: true, name: true, userId: true },
        });

        if (playlist) {
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

    logger?.debug(
      `   Reconciliation complete: ${totalTracksAdded} tracks added to ${playlistsWithAdditions.size} playlists`,
    );

    return {
      playlistsUpdated: playlistsWithAdditions.size,
      tracksAdded: totalTracksAdded,
    };
  }

  /**
   * Get pending tracks count for a playlist
   */
  async getPendingTracksCount(playlistId: string): Promise<number> {
    return prisma.playlistPendingTrack.count({
      where: { playlistId },
    });
  }

  /**
   * Get pending tracks for a playlist
   */
  async getPendingTracks(playlistId: string): Promise<
    Array<{
      id: string;
      artist: string;
      title: string;
      album: string;
    }>
  > {
    const tracks = await prisma.playlistPendingTrack.findMany({
      where: { playlistId },
      orderBy: { sort: "asc" },
    });

    return tracks.map((t) => ({
      id: t.id,
      artist: t.spotifyArtist,
      title: t.spotifyTitle,
      album: t.spotifyAlbum,
    }));
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

        await redisClient.setEx(
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
        logger?.error("[Preview Job] Failed:", error);
        const isNetworkError = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(error.code);
        const userMessage = isNetworkError
            ? "Service temporarily unavailable. Please try again in a moment."
            : (error.message || "Import failed");
        await redisClient.setEx(
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
    })().catch((e) => logger?.error("[Preview Job] Unhandled:", e));

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
      return null;
    }
  }

  /**
   * Import a playlist from an M3U file.
   * Matches entries against the local library using a 4-tier strategy:
   *   1. Exact file path match (DB filePath is relative, strip common prefixes)
   *   2. Filename match (basename without extension)
   *   3. Exact metadata match (artist + title from EXTINF, case-insensitive)
   *   4. Fuzzy metadata match (fuzzball token_set_ratio >= 80)
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
                })),
              }
            : undefined,
      },
    });

    logger.info(
      `[M3U Import] Created playlist "${playlistName}" (${playlist.id}): ${uniqueTrackIds.length}/${entries.length} matched`,
    );

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
    const job = await this.getJob(importJobId);
    if (!job) throw new Error(`Import job ${importJobId} not found`);

    // Retrieve cached preview from Redis
    let preview: ImportPreview | null = null;
    try {
      const cached = await redisClient.get(`import:preview:${importJobId}`);
      if (cached) preview = JSON.parse(cached);
    } catch (e: any) {
      logger?.warn(`[Spotify Import] Failed to read preview cache for job ${importJobId}: ${e.message}`);
    }

    if (!preview) {
      throw new Error(`Preview not found for import job ${importJobId}`);
    }

    // Create job logger
    const jobLogger = createPlaylistLogger(importJobId);
    jobLoggers.set(importJobId, jobLogger);

    try {
      await this.processImport(job, albumMbidsToDownload, preview);
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

    // Check for existing active import of same URL
    const existingJobs = await this.getUserJobs(userId);
    const activeStatuses = ["pending", "fetching", "downloading", "scanning", "creating_playlist", "matching_tracks"];
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

    // Create a minimal ImportJob record so status polling works immediately
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

    logger?.info(`[Quick Import] Enqueued job ${jobId} for ${url}`);
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
    const job = await this.getJob(importJobId);
    if (!job) throw new Error(`Import job ${importJobId} not found`);

    const jobLogger = createPlaylistLogger(importJobId);
    jobLoggers.set(importJobId, jobLogger);

    try {
      // Phase 1: Fetch playlist
      job.status = "fetching";
      await saveImportJob(job);

      jobLogger?.info(`[Quick Import] Fetching playlist from ${url}`);

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
      const freshJob = await this.getJob(importJobId);
      if (!freshJob || freshJob.status === "cancelled") {
        jobLogger?.info("[Quick Import] Job cancelled during fetch phase");
        return;
      }

      // Phase 2: Update job with real data
      const resolvedName = playlistNameOverride || preview.playlist.name;
      job.playlistName = resolvedName;
      job.spotifyPlaylistId = preview.playlist.id;
      job.tracksTotal = preview.summary.total;
      job.tracksMatched = preview.summary.inLibrary;
      job.status = "downloading";
      await saveImportJob(job);

      jobLogger?.info(`[Quick Import] Playlist: "${resolvedName}" (${preview.summary.total} tracks)`);
      jobLogger?.info(`[Quick Import] Already in library: ${preview.summary.inLibrary}, downloadable: ${preview.summary.downloadable}`);

      // Phase 3: Auto-select ALL downloadable albums
      const albumMbidsToDownload = preview.albumsToDownload.map(
        (a) => a.albumMbid || a.spotifyAlbumId,
      );

      if (albumMbidsToDownload.length === 0) {
        jobLogger?.info(`[Quick Import] No albums to download, creating playlist from matched tracks`);
      }

      // Calculate tracks from downloads
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
        await redisClient.setEx(
          `import:preview:${job.id}`,
          IMPORT_JOB_TTL,
          JSON.stringify(preview),
        );
      } catch (e: any) {
        logger?.warn(`[Quick Import] Failed to cache preview: ${e.message}`);
      }

      // Phase 4: Hand off to existing import flow
      await this.processImport(job, albumMbidsToDownload, preview);
    } finally {
      jobLoggers.delete(importJobId);
    }
  }

  /**
   * Mark an import job as failed (used by the BullMQ worker's failed handler).
   * If zero tracks were matched, cleans up all artifacts.
   * If some tracks matched, keeps the job record for visibility.
   */
  async markJobFailed(importJobId: string, errorMessage: string): Promise<void> {
    const job = await this.getJob(importJobId);
    if (!job) return;

    // Check if any tracks were pre-matched before the failure
    const hasMatchedTracks = (job.pendingTracks || []).some(
      (t) => t.preMatchedTrackId,
    );

    if (!hasMatchedTracks) {
      // Total failure -- clean up all traces
      logger?.info(
        `[Spotify Import] Job ${importJobId} failed with zero matched tracks, cleaning up`,
      );

      // Emit failure SSE before cleanup
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

      await this.cleanupImportArtifacts(importJobId, job.userId);
      return;
    }

    // Partial failure -- keep job for visibility, user can see what happened
    job.status = "failed";
    job.error = errorMessage;
    job.updatedAt = new Date();
    await saveImportJob(job);
  }
}

export const spotifyImportService = new SpotifyImportService();
