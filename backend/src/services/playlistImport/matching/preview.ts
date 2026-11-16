import { ShownArtists, MIN_WORD_LENGTH, songsOfArtistsHoldingWord, SONGS_OF_ARTISTS } from "./pools";
import pLimit from "p-limit";
import { SpotifyTrack } from "../../spotify";
import { logger } from "../../../utils/logger";
import { musicBrainzService } from "../../musicbrainz";
import { getSystemSettings } from "../../../utils/systemSettings";
import { isLidarrConfigured } from "../../lidarrClient";
import { prisma } from "../../../utils/db";
import { PLAYABLE_SONG } from "../../../utils/playableSong";
import { sourcePauseController } from "../../sourcePauseController";
import { normalizeArtistName, parseCredit } from "../../artistIdentity";
import { sameName } from "../../discovery/discoverEvidence";
import { failureCause } from "../../../utils/outcome";
import { resolveArtistMbid } from "../../artistCorrection";
import { titlesAgree } from "../../albumIdentity";
import { matchTrackToLibrary, toMatchCandidates, type MatchCandidate } from "../../trackMatching";
import { stripTrackSuffix, normalizeTrackTitle } from "../../../utils/normalization";
import type { ImportJob, ImportPreview, MatchedTrack, AlbumToDownload, Tracklist } from "../types";
/** A track's album id after MusicBrainz named its album: the release-group id behind a marker. */
const mbAlbumId = (albumMbid: string) => `mbid:${albumMbid}`;
/** The release-group id in an album id MusicBrainz resolved, or null for a source's own album id. */
const resolvedAlbumMbid = (albumId: string | null | undefined): string | null =>
  albumId?.startsWith("mbid:") ? albumId.slice("mbid:".length) : null;


/**
 * Match a listed song to the library. Candidates come from ISRC, the exact
 * artist's tracks, then first-word prefix sweeps; the shared ladder in
 * services/trackMatching picks the verdict.
 */
async function matchTrack(spotifyTrack: SpotifyTrack, shownArtists?: ShownArtists): Promise<MatchedTrack> {
  // A song edited to a shown title or artist name is in once under each pairing, so the key holds both.
  const candidates = new Map<string, MatchCandidate>();
  const add = (rows: MatchCandidate[]) => {
    for (const c of rows) {
      const key = `${c.id}\n${c.title}\n${c.artistName}`;
      if (!candidates.has(key)) candidates.set(key, c);
    }
  };
  const withAlbum = {
    include: { album: { include: { artist: true } } },
  } as const;

  if (spotifyTrack.isrc) {
    const rows = await prisma.track.findMany({
      where: { AND: [PLAYABLE_SONG, { isrc: spotifyTrack.isrc }] },
      ...withAlbum,
    });
    add(rows.flatMap(toMatchCandidates));
  }

  const primaryArtist =
    parseCredit(spotifyTrack.artist).primary || spotifyTrack.artist;
  const normalizedPrimaryArtist = normalizeArtistName(primaryArtist);
  const dbNormalizedArtist = normalizeArtistName(spotifyTrack.artist);

  const exactArtistNames = [normalizedPrimaryArtist, dbNormalizedArtist];
  const shown = shownArtists ?? (await ShownArtists.load());
  const shownAsArtist = shown.as(exactArtistNames);
  const artistRows = await prisma.track.findMany({
    where: {
      AND: [
        PLAYABLE_SONG,
        {
          album: {
            artist: {
              OR: [{ normalizedName: { in: exactArtistNames } }, ...(shownAsArtist.length > 0 ? [{ id: { in: shownAsArtist } }] : [])],
            },
          },
        },
      ],
    },
    ...withAlbum,
  });
  add(artistRows.flatMap(toMatchCandidates));

  // Fuzzy sweeps: artists whose normalizedName holds the first word as a whole word (covers
  // "Artist A feat. B" stored under a compound name); the matcher narrows them
  // to exact-artist candidates.
  if (candidates.size === 0) {
    const firstWord = normalizedPrimaryArtist.split(" ")[0];
    if (firstWord.length >= MIN_WORD_LENGTH) {
      add(
        (await songsOfArtistsHoldingWord(firstWord, withAlbum.include, shown.holding(firstWord))).flatMap(toMatchCandidates),
      );
    }
    // Shorter than sweep 1's minimum, the prefix starts too many artists to read ("" starts every one).
    if (candidates.size === 0 && normalizedPrimaryArtist.length >= MIN_WORD_LENGTH) {
      const prefix = normalizedPrimaryArtist.substring(0, Math.min(5, normalizedPrimaryArtist.length));
      const shownWithPrefix = shown.beginningWith(prefix);
      add(
        (
          await prisma.track.findMany({
            ...SONGS_OF_ARTISTS({
              OR: [{ normalizedName: { startsWith: prefix } }, ...(shownWithPrefix.length > 0 ? [{ id: { in: shownWithPrefix } }] : [])],
            }),
            ...withAlbum,
          })
        ).flatMap(toMatchCandidates),
      );
    }
    const creditFirstWord = dbNormalizedArtist.split(" ")[0];
    if (candidates.size === 0 && primaryArtist !== spotifyTrack.artist && creditFirstWord.length > 0) {
      add(
        (await songsOfArtistsHoldingWord(creditFirstWord, withAlbum.include, shown.holding(creditFirstWord))).flatMap(toMatchCandidates),
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
async function findAlbumMbid(
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
async function enrichUnknownAlbumsViaMusicBrainz(
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

  // One lookup per artist and title; every copy of a song takes its answer.
  const byKey = new Map<string, SpotifyTrack[]>();
  for (const track of unknownAlbumTracks) {
    const key = `${track.artist.toLowerCase()}|||${track.title.toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), track]);
  }
  const resultsCache = new Map<
    string,
    { albumName: string; albumId: string; albumMbid: string }
  >();

  let resolved = 0;
  let failed = 0;

  // Every lookup starts at once; MusicBrainz's rate limiter spaces the requests.
  const lookupResults = await Promise.all(
    [...byKey.values()].map(async (copies) => {
      const track = copies[0];
      const recordingInfo = await musicBrainzService.searchRecording({
        title: stripTrackSuffix(track.title),
        artists: [track.artist],
        durationSec: Math.round(track.durationMs / 1000),
      });

      if (recordingInfo.kind === "answered") {
        const result = {
          albumName: recordingInfo.value.albumName,
          albumId: recordingInfo.value.albumMbid,
          albumMbid: recordingInfo.value.albumMbid,
        };
        return { copies, result, status: "resolved" as const };
      }
      if (recordingInfo.kind === "absent") {
        return { copies, result: null, status: "failed" as const };
      }
      // A rate limit leaves the song unresolved without counting it as failed, so the next run asks again.
      if (recordingInfo.kind === "rateLimited") {
        logger.warn(
          `${logPrefix} MusicBrainz rate-limited — "${track.title}" stays unresolved`,
        );
        return { copies, result: null, status: "parked" as const };
      }
      logger.error(
        `${logPrefix} Error resolving "${track.title}": ${failureCause(recordingInfo)}`,
      );
      return { copies, result: null, status: "failed" as const };
    }),
  );

  for (const { copies, result, status } of lookupResults) {
    if (status === "resolved" && result) {
      for (const track of copies) {
        track.album = result.albumName;
        track.albumId = mbAlbumId(result.albumMbid);
        resultsCache.set(track.spotifyId, result);
      }
      resolved += copies.length;
      logger.debug(
        `${logPrefix} Resolved: "${copies[0].title}" -> "${result.albumName}"`,
      );
    } else if (status === "failed") {
      failed += copies.length;
    }
  }

  logger.info(
    `${logPrefix} MusicBrainz resolution complete: ${resolved} resolved, ${failed} still unknown`,
  );

  return { resolved, failed, cached: resultsCache };
}

/**
 * What the library has of a tracklist and what it lacks: each song matched, the missing ones grouped into the albums
 * to download.
 */
export async function previewOfTracklist({ tracks, playlist: playlistMeta, source }: Tracklist): Promise<ImportPreview> {
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
      await enrichUnknownAlbumsViaMusicBrainz(tracks, logPrefix);
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
  const shownArtists = await ShownArtists.load();
  const matchedTracks: MatchedTrack[] = await Promise.all(
    tracks.map((track) => matchLimit(() => matchTrack(track, shownArtists))),
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

      logger.debug(`${logPrefix} Looking up: "${artistName}" - "${albumName}"`);

      if (lidarrEnabled) {
        const preResolvedMbid = resolvedAlbumMbid(firstTrack.albumId);

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

          const mbResult = await findAlbumMbid(
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
        spotifyAlbumId: resolvedAlbumMbid(albumTracks[0].albumId) ?? albumTracks[0].albumId ?? "",
        albumName: resolvedAlbumName,
        artistName,
        artistMbid,
        albumMbid,
        coverUrl: albumTracks[0].coverUrl,
        trackCount: albumTracks.length,
        tracksNeeded: albumTracks,
      };

      logger.debug(
        albumMbid
          ? `${logPrefix} Will request "${resolvedAlbumName}" (${albumMbid}) by ${artistName}`
          : `${logPrefix} Will request ${albumTracks.length} songs by ${artistName} from Soulseek (no album id)`,
      );

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
 * Build the pendingTracks array from a preview's matched tracks.
 * Shared between startImport and processQuickImportFromQueue.
 */
export function pendingTracksOf(
  preview: ImportPreview,
): ImportJob["pendingTracks"] {
  return preview.matchedTracks.map((m) => {
    const spotifyAlbum = m.spotifyTrack.album;
    const spotifyAlbumId = m.spotifyTrack.albumId;
    const spotifyArtist = m.spotifyTrack.artist;
    const spotifyTrackId = m.spotifyTrack.spotifyId;
    const trackTitle = m.spotifyTrack.title;

    const resolvedMbid = resolvedAlbumMbid(spotifyAlbumId);

    // The album to fetch for this song: by the album MusicBrainz named, by the source's album id, by an album
    // that needs this very song, else by artist and a similar album name.
    let albumToDownload: AlbumToDownload | undefined;
    if (resolvedMbid) {
      albumToDownload = preview.albumsToDownload.find(
        (a) => a.albumMbid === resolvedMbid,
      );
    }

    if (!albumToDownload && spotifyAlbumId && !resolvedMbid) {
      albumToDownload = preview.albumsToDownload.find(
        (a) => a.spotifyAlbumId === spotifyAlbumId,
      );
    }

    if (!albumToDownload) {
      albumToDownload = preview.albumsToDownload.find((a) =>
        a.tracksNeeded.some(
          (t) =>
            t.spotifyId === spotifyTrackId ||
            (sameName(t.title, trackTitle) && sameName(t.artist, spotifyArtist)),
        ),
      );
    }

    if (
      !albumToDownload &&
      spotifyArtist &&
      spotifyAlbum &&
      spotifyAlbum !== "Unknown Album"
    ) {
      // Folded like every other name in the import: case, accents and punctuation do not tell two albums apart.
      const normalizedAlbum = normalizeTrackTitle(spotifyAlbum);
      // An album name with no letters or digits folds to nothing, which would hold in every name: it matches none.
      albumToDownload = preview.albumsToDownload.find(
        (a) =>
          normalizedAlbum !== "" &&
          sameName(a.artistName, spotifyArtist) &&
          normalizeTrackTitle(a.albumName).includes(normalizedAlbum.substring(0, 10)),
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
