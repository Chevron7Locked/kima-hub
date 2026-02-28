import { randomUUID } from "crypto";
import { withRetry } from "../utils/async";
import pLimit from "p-limit";
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
import { extractPrimaryArtist } from "../utils/artistNormalization";
import { eventBus } from "./eventBus";

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
  }>;
}

// Redis key pattern for import jobs
const IMPORT_JOB_KEY = (id: string) => `import:job:${id}`;
const IMPORT_JOB_TTL = 24 * 60 * 60; // 24 hours

// Redis key pattern for preview jobs
const PREVIEW_JOB_KEY = (id: string) => `preview:job:${id}`;
const PREVIEW_JOB_TTL = 2 * 60 * 60; // 2 hours

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
      pendingTracks: job.pendingTracks as any,
    },
    update: {
      status: job.status,
      progress: job.progress,
      albumsCompleted: job.albumsCompleted,
      tracksMatched: job.tracksMatched,
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

/**
 * Normalize a string for fuzzy matching
 * Handles: special characters, punctuation, remaster suffixes, etc.
 */
function normalizeString(str: string): string {
  return (
    str
      .toLowerCase()
      // Normalize special characters (ö→o, é→e, etc.)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Remove punctuation but keep spaces
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Normalize apostrophes and quotes to ASCII versions
 * Handles: ' ' ` ′ ʼ → '
 */
function normalizeApostrophes(str: string): string {
  return str
    .replace(/[''`′ʼ]/g, "'") // Various apostrophe forms → ASCII apostrophe
    .replace(/[""]/g, '"'); // Smart quotes → ASCII quotes
}

/**
 * Strip remaster/version suffixes but KEEP punctuation
 * "Ain't Gonna Rain Anymore - 2011 Remaster" → "Ain't Gonna Rain Anymore"
 * Used for database searches where we need to match punctuation
 */
function stripTrackSuffix(str: string): string {
  return (
    normalizeApostrophes(str)
      // Remove " - YEAR Remaster", " - Remastered YEAR", " - Radio Edit", etc.
      // Note: remaster(ed)? matches "remaster" or "remastered"
      .replace(
        /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)(\s+\d{4})?(\s+(version|edition|mix))?.*$/i,
        "",
      )
      // Remove " - YEAR" at end
      .replace(/\s*-\s*\d{4}\s*$/, "")
      // Remove "(Live at...)", "(Live from...)", "(Recorded at...)" parenthetical content
      .replace(
        /\s*\([^)]*(?:live at|live from|recorded at|performed at)[^)]*\)\s*/gi,
        " ",
      )
      // Remove parenthetical content like "(Remastered)" or "(2011 Remastered Version)"
      .replace(/\s*\([^)]*remaster[^)]*\)\s*/gi, " ")
      .replace(/\s*\([^)]*version[^)]*\)\s*/gi, " ")
      .replace(/\s*\([^)]*edition[^)]*\)\s*/gi, " ")
      // Remove general "(Live)" or "(Live 2021)" etc
      .replace(/\s*\(\s*live\s*(\d{4})?\s*\)\s*/gi, " ")
      // Remove bracketed content like "[Deluxe Edition]"
      .replace(/\s*\[[^\]]*\]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Normalize track title - removes remaster/version suffixes AND punctuation
 * "Ain't Gonna Rain Anymore - 2011 Remaster" → "aint gonna rain anymore"
 * Used for similarity comparisons
 */
function normalizeTrackTitle(str: string): string {
  return normalizeString(stripTrackSuffix(str));
}

/**
 * Normalize album title for matching - strips common suffixes
 * "In A Time Lapse (Deluxe Edition)" → "In A Time Lapse"
 * Used for flexible album matching
 */
function normalizeAlbumForMatching(str: string): string {
  return stripTrackSuffix(str).trim();
}

/**
 * Calculate similarity between two strings (0-100)
 */
function stringSimilarity(a: string, b: string): number {
  const s1 = normalizeString(a);
  const s2 = normalizeString(b);

  if (s1 === s2) return 100;

  // Check if one contains the other
  if (s1.includes(s2) || s2.includes(s1)) {
    const longer = Math.max(s1.length, s2.length);
    const shorter = Math.min(s1.length, s2.length);
    return Math.round((shorter / longer) * 100);
  }

  // Simple word overlap similarity
  const words1 = new Set(s1.split(" "));
  const words2 = new Set(s2.split(" "));
  const intersection = [...words1].filter((w) => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;

  return Math.round((intersection / union) * 100);
}

class SpotifyImportService {
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
    const cleanedTrackTitle = normalizeTrackTitle(spotifyTrack.title);

    // Extract primary artist for better matching (handles "Artist feat. Someone")
    const primaryArtist = extractPrimaryArtist(spotifyTrack.artist);
    const normalizedPrimaryArtist = normalizeString(primaryArtist);

    // Normalize album title (strip edition/remaster suffixes)
    const cleanedAlbum = normalizeAlbumForMatching(spotifyTrack.album);
    const isUnknownAlbum =
      spotifyTrack.album === "Unknown Album" || !spotifyTrack.album;

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
              normalizedName: normalizedArtist,
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
              normalizedName: normalizedArtist,
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
      const fullArtistFirstWord = normalizedArtist.split(" ")[0];
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

    // Process tracks (MusicBrainz rate limiting is handled by musicBrainzService)
    for (const track of unknownAlbumTracks) {
      const cacheKey = `${track.artist.toLowerCase()}|||${track.title.toLowerCase()}`;

      // Check if we already looked this up
      if (resolutionCache.has(cacheKey)) {
        const cached = resolutionCache.get(cacheKey);
        if (cached) {
          track.album = cached.albumName;
          // NOTE: Using albumId field with 'mbid:' prefix to carry MusicBrainz ID
          // This is parsed later in buildPreviewFromTracklist() and startImport()
          track.albumId = `mbid:${cached.albumMbid}`;
          resolved++;
          logger?.debug(
            `${logPrefix} [Cache Hit] "${track.title}" -> "${cached.albumName}"`,
          );
        } else {
          failed++;
        }
        continue;
      }

      // Normalize track title (remove remaster/live suffixes)
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
          // Success - update track with resolved album
          track.album = recordingInfo.albumName;
          // NOTE: Using albumId field with 'mbid:' prefix to carry MusicBrainz ID
          // This is parsed later in buildPreviewFromTracklist() and startImport()
          track.albumId = `mbid:${recordingInfo.albumMbid}`;

          const result = {
            albumName: recordingInfo.albumName,
            albumId: recordingInfo.albumMbid,
            albumMbid: recordingInfo.albumMbid,
          };

          resolutionCache.set(cacheKey, result);
          resultsCache.set(track.spotifyId, result);
          resolved++;

          logger?.info(
            `${logPrefix} Resolved: "${track.title}" -> "${recordingInfo.albumName}"`,
          );
        } else {
          // Failed - track stays as "Unknown Album"
          resolutionCache.set(cacheKey, null);
          failed++;
          logger?.debug(
            `${logPrefix} Could not resolve: "${track.title}" by ${track.artist}`,
          );
        }
      } catch (error: unknown) {
        resolutionCache.set(cacheKey, null);
        failed++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger?.error(
          `${logPrefix} Error resolving "${track.title}": ${errorMsg}`,
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
    source: "Spotify" | "Deezer",
  ): Promise<ImportPreview> {
    const logPrefix =
      source === "Spotify" ? "[Spotify Import]" : "[Deezer Import]";

    // PHASE 0: Early MusicBrainz resolution for "Unknown Album" tracks
    // This MUST happen BEFORE grouping so tracks get grouped by actual albums
    const unknownCount = tracks.filter(
      (t) => t.album === "Unknown Album",
    ).length;

    if (unknownCount > 0) {
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
    }

    // Phase 1: Parallel DB lookups (matchTrack is DB-only, safe to parallelise).
    // Capped at 8 concurrent queries to avoid exhausting the Prisma connection pool
    // on large playlists. Promise.all preserves insertion order so matchedTracks[i]
    // corresponds to tracks[i].
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

    const albumsToDownload: AlbumToDownload[] = [];

    for (const [key, albumTracks] of unmatchedByAlbum.entries()) {
      const [artistName, albumName] = key.split("|||");

      let resolvedAlbumName = albumName;
      let artistMbid: string | null = null;
      let albumMbid: string | null = null;

      // Check if this album was resolved via MusicBrainz (albumId starts with "mbid:")
      const firstTrack = albumTracks[0];
      const wasMbResolved = firstTrack.albumId?.startsWith("mbid:");
      const preResolvedMbid = wasMbResolved
        ? firstTrack.albumId!.replace("mbid:", "")
        : null;

      logger?.debug(`\n${logPrefix} ========================================`);
      logger?.debug(
        `${logPrefix} Looking up: "${artistName}" - "${albumName}"`,
      );

      // If we have MBID from early resolution, use it directly
      if (preResolvedMbid) {
        albumMbid = preResolvedMbid;
        logger?.debug(`${logPrefix} Using pre-resolved MBID: ${albumMbid}`);
        // Still get artistMbid for completeness
        const artists = await musicBrainzService.searchArtist(artistName, 1);
        if (artists && artists.length > 0) {
          artistMbid = artists[0].id;
        }
      } else if (albumName && albumName !== "Unknown Album") {
        // Normalize album name to remove live/remaster suffixes
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
          // Normalize track title to remove live/remaster suffixes
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
        if (albumName === "Unknown Album") {
          logger?.debug(
            `${logPrefix} ℹ But can still download via Soulseek (track-based search)`,
          );
        }
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
        // No MBID - will try Soulseek track-based search
        logger?.debug(
          `   Will request individual tracks via Soulseek (no MBID):`,
        );
        logger?.debug(`   Artist: "${artistName}"`);
        logger?.debug(
          `   Tracks: ${albumTracks.map((t) => `"${t.title}"`).join(", ")}`,
        );
      }
      logger?.debug(`${logPrefix} ========================================\n`);

      albumsToDownload.push(albumToDownload);
    }

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
  async generatePreview(spotifyUrl: string): Promise<ImportPreview> {
    // Clear any stale null cache entries before processing
    // This ensures we retry previously failed lookups
    await musicBrainzService.clearStaleRecordingCaches();

    const playlist = await spotifyService.getPlaylist(spotifyUrl);
    if (!playlist) {
      throw new Error(
        "Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL.",
      );
    }

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

    logger?.debug(
      "[Deezer Debug] Sample track from Deezer:",
      JSON.stringify(deezerPlaylist.tracks[0], null, 2),
    );

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

    logger?.debug(
      "[Deezer Debug] Sample converted track:",
      JSON.stringify(spotifyTracks[0], null, 2),
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

  /**
   * Start an import job
   */
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

    // Extract the track info we need to match after downloads
    // Include ALL tracks, both matched and unmatched
    // IMPORTANT: Store pre-matched track IDs so we don't have to re-search them!
    // NOTE: `PlaylistPendingTrack.spotifyAlbum` should reflect Spotify's album name.
    // Only fall back to a resolved album name when Spotify returns "Unknown Album".
    const pendingTracks = preview.matchedTracks.map((m) => {
      const spotifyAlbum = m.spotifyTrack.album;
      const spotifyAlbumId = m.spotifyTrack.albumId;
      const spotifyArtist = m.spotifyTrack.artist;
      const spotifyTrackId = m.spotifyTrack.spotifyId;
      const trackTitle = m.spotifyTrack.title;

      // Check if album was resolved via MusicBrainz (albumId has mbid: prefix)
      const wasMbResolved = spotifyAlbumId?.startsWith("mbid:");
      const resolvedMbid = wasMbResolved
        ? spotifyAlbumId.replace("mbid:", "")
        : null;

      // Try to find album info using multiple strategies
      let albumToDownload: AlbumToDownload | undefined;

      // Strategy 1: Match by resolved MusicBrainz MBID (highest priority for pre-resolved)
      if (resolvedMbid) {
        albumToDownload = preview.albumsToDownload.find(
          (a) => a.albumMbid === resolvedMbid,
        );
      }

      // Strategy 2: Match by Spotify album ID (for non-resolved tracks)
      if (!albumToDownload && spotifyAlbumId && !wasMbResolved) {
        albumToDownload = preview.albumsToDownload.find(
          (a) => a.spotifyAlbumId === spotifyAlbumId,
        );
      }

      // Strategy 3: Find album that contains this specific track in tracksNeeded
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

      // Strategy 4: Match by artist + album name similarity (for edge cases)
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

      // Use resolved album name for display (from track or from albumToDownload)
      const albumForDisplay =
        spotifyAlbum && spotifyAlbum !== "Unknown Album"
          ? spotifyAlbum
          : albumToDownload?.albumName || spotifyAlbum;

      // Get the actual MBID (either from pre-resolved or from albumToDownload)
      const actualAlbumMbid =
        resolvedMbid || albumToDownload?.albumMbid || null;

      return {
        artist: spotifyArtist,
        title: trackTitle,
        album: albumForDisplay,
        albumMbid: actualAlbumMbid,
        artistMbid: albumToDownload?.artistMbid || null,
        preMatchedTrackId: m.localTrack?.id || null,
      };
    });

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
      createdAt: new Date(),
      updatedAt: new Date(),
      pendingTracks,
    };

    // Save to database and memory cache
    await saveImportJob(job);

    // Start processing in background
    this.processImport(job, albumMbidsToDownload, preview).catch(
      async (error) => {
        job.status = "failed";
        job.error = error.message;
        job.updatedAt = new Date();
        await saveImportJob(job);
        jobLogger?.logJobFailed(error.message);
        // Clean up job logger to prevent memory leak
        jobLoggers.delete(job.id);
      },
    );

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

    try {
      // Phase 1: Download albums using AcquisitionService
      if (albumMbidsToDownload.length > 0) {
        job.status = "downloading";
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.logAlbumDownloadStart(albumMbidsToDownload.length);

        logger?.debug(
          `[Spotify Import] Processing ${albumMbidsToDownload.length} albums via AcquisitionService`,
        );
        logger?.info(
          `Processing ${albumMbidsToDownload.length} albums via AcquisitionService`,
        );

        // Process albums in parallel with concurrency limit from settings
        const settings = await getSystemSettings();
        const albumQueue = new PQueue({
          concurrency: settings?.soulseekConcurrentDownloads ?? 1,
        });

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
                album.albumName === "Unknown Album" || !album.albumMbid;

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
                    mbid: album.albumMbid!,
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
              logger?.error(
                `[Spotify Import] Failed: ${album.artistName} - ${album.albumName}: ${error.message}`,
              );
              logger?.logAlbumFailed(
                album.albumName,
                album.artistName,
                error.message,
              );
            }
          }),
        );

        // Wait for all album acquisitions to complete
        await Promise.all(albumPromises);

        logger?.info(
          `Initial acquisition phase finished for ${albumMbidsToDownload.length} album(s). Checking completion state...`,
        );

        // Check if we can complete immediately
        await this.checkImportCompletion(job.id);

        // Re-fetch job state after checkImportCompletion may have updated it
        const updatedJob = await getImportJob(job.id);
        if (!updatedJob) {
          logger?.error(
            `[Spotify Import] Job ${job.id}: Job not found after completion check`,
          );
          return;
        }

        // If still downloading, wait for completion
        if (updatedJob.status === "downloading") {
          logger?.debug(
            `[Spotify Import] Job ${updatedJob.id}: Waiting for downloads to complete...`,
          );
          logger?.info(`Waiting for downloads to complete...`);
        }
        return;
      }

      // No downloads needed - all tracks already in library
      // Create playlist immediately
      await this.buildPlaylist(job);
    } catch (error: any) {
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

    await this.buildPlaylist(job);
  }

  /**
   * Internal: Build the playlist with matched tracks
   */
  private async buildPlaylist(job: ImportJob): Promise<void> {
    const logger = jobLoggers.get(job.id);

    job.status = "creating_playlist";
    job.progress = 90;
    job.updatedAt = new Date();
    await saveImportJob(job);

    logger?.logPlaylistCreationStart();
    logger?.logTrackMatchingStart();

    // Match all pending tracks against the library
    const matchedTrackIds: string[] = [];
    let trackIndex = 0;

    for (const pendingTrack of job.pendingTracks) {
      trackIndex++;

      // FAST PATH: If already matched in preview, use that ID directly
      // This ensures tracks found during preview are included in the final playlist
      if (pendingTrack.preMatchedTrackId) {
        // Verify the track still exists
        const existingTrack = await prisma.track.findUnique({
          where: { id: pendingTrack.preMatchedTrackId },
          select: { id: true, title: true },
        });
        if (existingTrack) {
          matchedTrackIds.push(existingTrack.id);
          logger?.debug(
            `   ✓ Pre-matched: "${pendingTrack.title}" -> track ${existingTrack.id}`,
          );
          logger?.logTrackMatch(
            trackIndex,
            job.tracksTotal,
            pendingTrack.title,
            pendingTrack.artist,
            true,
            existingTrack.id,
          );
          continue;
        }
      }

      const normalizedArtist = normalizeString(pendingTrack.artist);
      // Get first word for fuzzy artist matching (handles "Nick Cave & The Bad Seeds" -> "nick")
      const artistFirstWord = normalizedArtist.split(" ")[0];
      // Strip suffix but keep punctuation for DB queries: "Ain't Gonna Rain Anymore - 2011 Remaster" -> "Ain't Gonna Rain Anymore"
      const strippedTitle = stripTrackSuffix(pendingTrack.title);
      // Also normalize apostrophes in the original title for searching
      const normalizedTitle = normalizeApostrophes(pendingTrack.title);
      // Fully normalized for similarity comparison: "aint gonna rain anymore"
      const cleanedTitle = normalizeTrackTitle(pendingTrack.title);

      logger?.log(
        `   Matching: "${pendingTrack.title}" by ${pendingTrack.artist}`,
      );
      logger?.log(
        `   strippedTitle: "${strippedTitle}", artistFirstWord: "${artistFirstWord}"`,
      );

      // Try multiple matching strategies
      let localTrack = null;

      // Strategy 1: Exact title match with fuzzy artist (contains first word)
      localTrack = await prisma.track.findFirst({
        where: {
          title: {
            equals: normalizedTitle,
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
      });

      // Strategy 2: Stripped title match (removes remaster suffix but keeps punctuation)
      // "Ain't Gonna Rain Anymore - 2011 Remaster" -> searches for "Ain't Gonna Rain Anymore"
      if (!localTrack && strippedTitle !== normalizedTitle) {
        logger?.log(
          `   Strategy 2: Searching for stripped title "${strippedTitle}"`,
        );
        localTrack = await prisma.track.findFirst({
          where: {
            title: {
              equals: strippedTitle,
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
        });
      }

      // Strategy 3: Case-insensitive CONTAINS search on title (handles slight variations)
      // e.g., database has "Ain't" but Spotify has "Ain't" (different apostrophe after normalization still differs)
      if (!localTrack && strippedTitle.length >= 5) {
        // Search for tracks where title contains the first few words
        const searchTerm = strippedTitle.split(" ").slice(0, 4).join(" ");
        logger?.log(`   Strategy 3: Contains search for "${searchTerm}"`);
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
          take: 10,
        });

        // Find best match using similarity OR containment
        for (const candidate of candidates) {
          const candidateNormalized = normalizeTrackTitle(candidate.title);
          const sim = stringSimilarity(cleanedTitle, candidateNormalized);

          // Direct similarity match
          if (sim >= 80) {
            localTrack = candidate;
            logger?.log(
              `      Found via contains+similarity (${sim.toFixed(0)}%)`,
            );
            break;
          }

          // Containment match: "Sordid Affair" should match "Sordid Affair (Feat. Ryan James)"
          // Check if one title contains the other (normalized)
          const spotifyNorm = cleanedTitle.toLowerCase();
          const libraryNorm = candidateNormalized.toLowerCase();
          if (
            libraryNorm.startsWith(spotifyNorm) ||
            spotifyNorm.startsWith(libraryNorm)
          ) {
            localTrack = candidate;
            logger?.log(
              `      Found via containment match: "${cleanedTitle}" in "${candidateNormalized}"`,
            );
            break;
          }
        }
      }

      // Strategy 3.5: Same as preview - fuzzy match on artist NAME using similarity
      // This catches cases where normalizedName differs from what we expect
      if (!localTrack) {
        logger?.log(`   Strategy 3.5: Fuzzy artist+title matching`);
        const candidates = await prisma.track.findMany({
          where: {
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
          take: 50,
        });

        // Use same matching as preview: compare cleaned titles
        for (const candidate of candidates) {
          const titleSim = stringSimilarity(
            cleanedTitle,
            normalizeTrackTitle(candidate.title),
          );
          const artistSim = stringSimilarity(
            pendingTrack.artist,
            candidate.album.artist.name,
          );
          const score = titleSim * 0.6 + artistSim * 0.4;

          if (score >= 70) {
            localTrack = candidate;
            logger?.debug(`      (preview-style match: ${score.toFixed(0)}%)`);
            break;
          }
        }
      }

      // Strategy 4: StartsWith match with stripped title (for slight title variations)
      if (!localTrack && strippedTitle.length > 10) {
        logger?.log(`   Strategy 4: StartsWith search`);
        localTrack = await prisma.track.findFirst({
          where: {
            title: {
              startsWith: strippedTitle.substring(
                0,
                Math.min(20, strippedTitle.length),
              ),
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
        });

        // Verify match
        if (localTrack) {
          const dbTitleNormalized = normalizeTrackTitle(localTrack.title);
          if (stringSimilarity(cleanedTitle, dbTitleNormalized) < 70) {
            localTrack = null;
          } else {
            logger?.log(`      Found via startsWith`);
          }
        }
      }

      // Strategy 5: Very fuzzy - search and score by similarity (last resort)
      if (!localTrack) {
        logger?.log(`   Strategy 5: Fuzzy search (last resort)`);
        // Get first few words for search
        const searchWords = strippedTitle.split(" ").slice(0, 3).join(" ");
        if (searchWords.length >= 4) {
          const candidates = await prisma.track.findMany({
            where: {
              title: {
                contains: searchWords.split(" ")[0], // Just first word
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
            take: 20,
          });

          // Find best match by similarity
          let bestMatch = null;
          let bestScore = 0;
          for (const candidate of candidates) {
            const titleScore = stringSimilarity(
              cleanedTitle,
              normalizeTrackTitle(candidate.title),
            );
            const artistScore = stringSimilarity(
              normalizedArtist,
              normalizeString(candidate.album.artist.name),
            );
            const combinedScore = titleScore * 0.7 + artistScore * 0.3;

            if (combinedScore > bestScore && combinedScore >= 65) {
              bestScore = combinedScore;
              bestMatch = candidate;
            }
          }

          if (bestMatch) {
            localTrack = bestMatch;
            logger?.debug(
              `      (fuzzy match: score ${bestScore.toFixed(
                0,
              )}% with "${bestMatch.title}" by ${bestMatch.album.artist.name})`,
            );
          }
        }
      }

      // Strategy 6: Title-only search (ignores artist entirely)
      // This handles cases where file has wrong artist metadata (e.g., "Various Artists" compilations)
      // Only used when title is distinctive enough (>10 chars) and no match found yet
      if (!localTrack && cleanedTitle.length >= 10) {
        logger?.log(
          `   Strategy 6: Title-only search (fallback for wrong artist metadata)`,
        );

        // Search for tracks with very similar title, ignore artist completely
        const titleSearchTerm = strippedTitle.split(" ").slice(0, 4).join(" ");
        const candidates = await prisma.track.findMany({
          where: {
            title: {
              contains: titleSearchTerm,
              mode: "insensitive",
            },
          },
          include: { album: { include: { artist: true } } },
          take: 50,
        });

        // Find a high-confidence title match (require 85%+ similarity on title alone)
        let bestTitleMatch = null;
        let bestTitleScore = 0;

        for (const candidate of candidates) {
          const titleScore = stringSimilarity(
            cleanedTitle,
            normalizeTrackTitle(candidate.title),
          );

          // Require very high title match since we're ignoring artist
          if (titleScore > bestTitleScore && titleScore >= 85) {
            bestTitleScore = titleScore;
            bestTitleMatch = candidate;
          }
        }

        if (bestTitleMatch) {
          localTrack = bestTitleMatch;
          logger?.log(
            `      Found via title-only match (${bestTitleScore.toFixed(
              0,
            )}%): "${bestTitleMatch.title}" by ${
              bestTitleMatch.album.artist.name
            }`,
          );
          logger?.debug(
            `      (title-only match: ${bestTitleScore.toFixed(
              0,
            )}% - note: artist metadata mismatch, wanted "${
              pendingTrack.artist
            }" got "${bestTitleMatch.album.artist.name}")`,
          );
        }
      }

      if (localTrack) {
        matchedTrackIds.push(localTrack.id);
        logger?.debug(
          `   ✓ Matched: "${pendingTrack.title}" -> track ${localTrack.id}`,
        );
        logger?.logTrackMatch(
          trackIndex,
          job.tracksTotal,
          pendingTrack.title,
          pendingTrack.artist,
          true,
          localTrack.id,
        );
      } else {
        // Debug: Check if artist exists at all
        const artistExists = await prisma.artist.findFirst({
          where: {
            normalizedName: {
              contains: normalizedArtist.split(" ")[0],
              mode: "insensitive",
            },
          },
          select: { name: true, normalizedName: true },
        });
        if (artistExists) {
          logger?.debug(
            `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist "${artistExists.name}" exists but track not found)`,
          );
        } else {
          logger?.debug(
            `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`,
          );
        }
        logger?.logTrackMatch(
          trackIndex,
          job.tracksTotal,
          pendingTrack.title,
          pendingTrack.artist,
          false,
        );
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
      const normalizedArtist = normalizeString(pendingTrack.artist);
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
                contains: normalizedArtist.split(" ")[0],
                mode: "insensitive",
              },
            },
          },
        },
      });

      if (found) {
        matchedTitlesNormalized.add(
          `${normalizedArtist}|${strippedTitle.toLowerCase()}`,
        );
      }
    }

    // Save pending tracks that weren't matched
    const pendingTracksToSave = job.pendingTracks
      .map((track, index) => ({ ...track, originalIndex: index }))
      .filter((track) => {
        const normalizedArtist = normalizeString(track.artist);
        const strippedTitle = stripTrackSuffix(track.title).toLowerCase();
        return !matchedTitlesNormalized.has(
          `${normalizedArtist}|${strippedTitle}`,
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
          settings.musicPath,
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

    // Try to match each pending track
    for (const pendingTrack of job.pendingTracks) {
      const normalizedArtist = normalizeString(pendingTrack.artist);

      // Track model doesn't have normalizedTitle - use case-insensitive title matching
      const localTrack = await prisma.track.findFirst({
        where: {
          title: {
            equals: pendingTrack.title,
            mode: "insensitive",
          },
          album: {
            artist: {
              normalizedName: normalizedArtist,
            },
          },
        },
      });

      if (localTrack && !existingTrackIds.has(localTrack.id)) {
        // Add to playlist
        await prisma.playlistItem.create({
          data: {
            playlistId: job.createdPlaylistId,
            trackId: localTrack.id,
            sort: nextPosition++,
          },
        });
        existingTrackIds.add(localTrack.id);
        added++;
      }
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
        createdAt: dbJob.createdAt,
        updatedAt: dbJob.updatedAt,
        pendingTracks: (dbJob.pendingTracks as any) || [],
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Cancel an import job without creating a playlist.
   * All pending downloads are marked as failed and the job is marked as cancelled.
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

    const logger = jobLoggers.get(jobId);
    logger?.debug(`[Spotify Import] Cancelling job ${jobId}...`);
    logger?.info(`Job cancelled by user`);

    // If already completed, cancelled, or failed, nothing to do
    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return {
        playlistCreated: !!job.createdPlaylistId,
        playlistId: job.createdPlaylistId || null,
        tracksMatched: job.tracksMatched,
      };
    }

    // Mark any pending download jobs as cancelled
    await prisma.downloadJob.updateMany({
      where: {
        metadata: {
          path: ["spotifyImportJobId"],
          equals: jobId,
        },
        status: { in: ["pending", "processing"] },
      },
      data: {
        status: "failed",
        error: "Import cancelled by user",
        completedAt: new Date(),
      },
    });

    // Collect tracks already matched to the library before cancellation
    const matchedTrackIds = [
      ...new Set(
        (job.pendingTracks || [])
          .map((t) => t.preMatchedTrackId)
          .filter((id): id is string => !!id),
      ),
    ];

    let createdPlaylistId: string | null = null;

    if (matchedTrackIds.length > 0) {
      try {
        const playlist = await prisma.playlist.create({
          data: {
            userId: job.userId,
            name: job.playlistName,
            isPublic: false,
            spotifyPlaylistId: job.spotifyPlaylistId,
            items: {
              create: matchedTrackIds.map((trackId, index) => ({
                trackId,
                sort: index,
              })),
            },
          },
        });
        createdPlaylistId = playlist.id;
        logger?.info(
          `Partial playlist created with ${matchedTrackIds.length} tracks: ${playlist.id}`,
        );
      } catch (err: any) {
        logger?.warn(
          `Failed to create partial playlist on cancel: ${err?.message}`,
        );
      }
    }

    job.status = "cancelled";
    job.createdPlaylistId = createdPlaylistId;
    job.tracksMatched = matchedTrackIds.length;
    job.updatedAt = new Date();
    await saveImportJob(job);
    logger?.info(
      `Import cancelled by user — ${createdPlaylistId ? "partial playlist created" : "no tracks matched"}`,
    );

    return {
      playlistCreated: !!createdPlaylistId,
      playlistId: createdPlaylistId,
      tracksMatched: matchedTrackIds.length,
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
        const normalizedArtist = normalizeString(pendingTrack.spotifyArtist);
        const artistFirstWord = normalizedArtist.split(" ")[0];
        const strippedTitle = stripTrackSuffix(pendingTrack.spotifyTitle);
        const cleanedTitle = normalizeTrackTitle(strippedTitle);

        logger?.debug(
          `   Trying to match: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`,
        );
        logger?.debug(
          `      strippedTitle: "${strippedTitle}", artistFirstWord: "${artistFirstWord}"`,
        );

        // Debug: Check what tracks exist for this artist
        const artistTracks = await prisma.track.findMany({
          where: {
            album: {
              artist: {
                normalizedName: {
                  contains: artistFirstWord,
                  mode: "insensitive",
                },
              },
            },
          },
          select: {
            title: true,
            album: {
              select: {
                artist: {
                  select: {
                    name: true,
                    normalizedName: true,
                  },
                },
              },
            },
          },
          take: 5,
        });
        if (artistTracks.length > 0) {
          logger?.debug(
            `      DEBUG: Found ${artistTracks.length}+ tracks for artist containing "${artistFirstWord}"`,
          );
          artistTracks
            .slice(0, 3)
            .forEach((t) =>
              logger?.debug(
                `         - "${t.title}" (artist: ${t.album.artist.name}, normalized: ${t.album.artist.normalizedName})`,
              ),
            );
        } else {
          logger?.debug(
            `      DEBUG: NO tracks found for artist containing "${artistFirstWord}"`,
          );
        }

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

        let preview: ImportPreview;
        if (url.includes("deezer.com")) {
          const deezerMatch = url.match(/playlist[\/:](\d+)/);
          if (!deezerMatch) throw new Error("Invalid Deezer playlist URL");
          const deezerPlaylist = await withRetry(() => deezerService.getPlaylist(deezerMatch[1]));
          if (!deezerPlaylist) throw new Error("Deezer playlist not found");

          eventBus.emit({
            type: "preview:progress",
            userId,
            payload: { jobId, phase: "matching", message: "Matching tracks to library..." },
          });

          preview = await this.generatePreviewFromDeezer(deezerPlaylist);
        } else {
          eventBus.emit({
            type: "preview:progress",
            userId,
            payload: { jobId, phase: "matching", message: "Matching tracks to library..." },
          });

          preview = await this.generatePreview(url);
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
            ? "Deezer API is temporarily unavailable. Please try again in a moment."
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
}

export const spotifyImportService = new SpotifyImportService();
