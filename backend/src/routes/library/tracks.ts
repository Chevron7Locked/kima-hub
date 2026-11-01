import { Router } from "express";
import { requireAdmin } from "../../middleware/auth";
import { announcePlaylistsChanged, playlistsHoldingTracks } from "../../services/playlistEvents";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { lrclibService } from "../../services/lrclib";
import { rateLimiter } from "../../services/rateLimiter";
import { computeGenreTotals } from "../../utils/genreSql";
import {
  getEffectiveYear,
  getDecadeFromYear,
} from "../../utils/dateFilters";
import { shuffleArray } from "../../utils/shuffle";
import {
  COVER_STATION_TYPES,
  STATION_TYPES_WITH_VALUE,
  MAX_COVER_STATIONS,
  MAX_COVER_VALUE_LENGTH,
  stationCovers,
  type CoverStation,
} from "../../services/mixes/stationCovers";
import { songArtistKey } from "../../services/mixes/recipes";
import { selectRadioTracks, stillPlayable } from "../../services/mixes/stationSelection";
import { moodStationList } from "../../services/mixes/stations";
import { spreadByArtist } from "../../utils/artistSpread";
import { LIBRARY_LOCATION } from "../../services/libraryFilters";
import { IN_LIBRARY, LIBRARY_PLAYABLE } from "../../utils/libraryEligibility";
import { toAudioFeaturesDTO, AUDIO_FEATURE_SELECT } from "../../utils/audioFeatures";
import { resolveWithinMusicRoot } from "./trackPath";
import { parseLimit, parseOffset } from "./paging";
import fs from "fs";

const TRACK_SORT_MAP: Record<string, any> = {
  name: { title: "asc" as const },
  "name-desc": { title: "desc" as const },
};

const router = Router();

/** A track with its album and that album's artist. */
const WITH_ALBUM_ARTIST = {
  album: { include: { artist: { select: { id: true, name: true } } } },
} satisfies Prisma.TrackInclude;

router.get("/recently-listened", async (req, res) => {
  try {
    const userId = req.user!.id;
    const limitNum = parseLimit(req.query.limit, 10, 100);

    const [recentPlays, inProgressAudiobooks, inProgressPodcasts] =
      await Promise.all([
        prisma.play.findMany({
          where: {
            userId,
            source: { in: ["LIBRARY", "DISCOVERY_KEPT"] },
            track: {
              album: {
                location: LIBRARY_LOCATION,
              },
            },
          },
          orderBy: { playedAt: "desc" },
          take: limitNum * 3,
          include: {
            track: {
              include: {
                album: {
                  include: {
                    artist: {
                      select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        userHeroUrl: true,
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        prisma.audiobookProgress.findMany({
          where: {
            userId,
            isFinished: false,
            currentTime: { gt: 0 },
          },
          orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
          take: Math.ceil(limitNum / 3),
        }),
        prisma.podcastProgress.findMany({
          where: {
            userId,
            isFinished: false,
            currentTime: { gt: 0 },
          },
          orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
          take: limitNum * 2,
          include: {
            episode: {
              include: {
                podcast: {
                  select: {
                    id: true,
                    title: true,
                    author: true,
                    imageUrl: true,
                  },
                },
              },
            },
          },
        }),
      ]);

    const seenPodcasts = new Set();
    const uniquePodcasts = inProgressPodcasts
      .filter((pp) => {
        const podcastId = pp.episode.podcast.id;
        if (seenPodcasts.has(podcastId)) {
          return false;
        }
        seenPodcasts.add(podcastId);
        return true;
      })
      .slice(0, Math.ceil(limitNum / 3));

    const artistsMap = new Map();

    for (const play of recentPlays) {
      const artist = play.track.album.artist;
      if (!artistsMap.has(artist.id)) {
        artistsMap.set(artist.id, {
          ...artist,
          type: "artist",
          lastPlayedAt: play.playedAt,
        });
      }
    }

    const combined = [
      ...Array.from(artistsMap.values()),
      ...inProgressAudiobooks.map((ab: any) => {
        const coverArt =
          ab.coverUrl && !ab.coverUrl.startsWith("http")
            ? `audiobook__${ab.coverUrl}`
            : ab.coverUrl;

        return {
          id: ab.audiobookshelfId,
          name: ab.title,
          coverArt,
          type: "audiobook",
          author: ab.author,
          progress:
            ab.duration > 0
              ? Math.round((ab.currentTime / ab.duration) * 100)
              : 0,
          lastPlayedAt: ab.lastPlayedAt,
        };
      }),
      ...uniquePodcasts.map((pp: any) => ({
        id: pp.episode.podcast.id,
        episodeId: pp.episodeId,
        name: pp.episode.podcast.title,
        coverArt: pp.episode.podcast.imageUrl,
        type: "podcast",
        author: pp.episode.podcast.author,
        progress:
          pp.duration > 0
            ? Math.round((pp.currentTime / pp.duration) * 100)
            : 0,
        lastPlayedAt: pp.lastPlayedAt,
      })),
    ];

    combined.sort(
      (a, b) =>
        new Date(b.lastPlayedAt).getTime() - new Date(a.lastPlayedAt).getTime(),
    );
    const limitedItems = combined.slice(0, limitNum);

    const artistIds = limitedItems
      .filter((item) => item.type === "artist")
      .map((item) => item.id);
    const albumCounts = await prisma.ownedAlbum.groupBy({
      by: ["artistId"],
      where: { artistId: { in: artistIds } },
      _count: { rgMbid: true },
    });
    const albumCountMap = new Map(
      albumCounts.map((ac) => [ac.artistId, ac._count.rgMbid]),
    );

    const results = limitedItems.map((item) => {
      if (item.type === "audiobook" || item.type === "podcast") {
        return item;
      } else {
        const coverArt = item.userHeroUrl ?? item.heroUrl ?? null;
        return {
          ...item,
          coverArt,
          albumCount: albumCountMap.get(item.id) || 0,
        };
      }
    });

    res.json({ items: results });
  } catch (error) {
    logger.error("Get recently listened error:", error);
    res.status(500).json({ error: "Failed to fetch recently listened" });
  }
});

router.get("/recently-added", async (req, res) => {
  try {
    const limitNum = parseLimit(req.query.limit, 10, 100);

    // Artists ordered by their newest library album with songs, one row each.
    const newest = await prisma.album.groupBy({
      by: ["artistId"],
      where: { location: LIBRARY_LOCATION, tracks: { some: {} } },
      _max: { lastSynced: true },
      orderBy: { _max: { lastSynced: "desc" } },
      take: limitNum,
    });
    const artistRows = await prisma.artist.findMany({
      where: { id: { in: newest.map((n) => n.artistId) } },
      select: { id: true, mbid: true, name: true, heroUrl: true, userHeroUrl: true },
    });
    const byId = new Map(artistRows.map((a) => [a.id, a]));
    const artistsMap = new Map(
      newest.flatMap((n) => (byId.has(n.artistId) ? [[n.artistId, byId.get(n.artistId)!] as const] : [])),
    );

    const artistIds = Array.from(artistsMap.keys());
    const albumCounts = await prisma.album.groupBy({
      by: ["artistId"],
      where: {
        artistId: { in: artistIds },
        location: LIBRARY_LOCATION,
        tracks: { some: {} },
      },
      _count: { id: true },
    });
    const albumCountMap = new Map(
      albumCounts.map((ac) => [ac.artistId, ac._count.id]),
    );

    const artistsWithImages = Array.from(artistsMap.values()).map((artist) => {
      const coverArt = artist.userHeroUrl ?? artist.heroUrl ?? null;
      return {
        ...artist,
        coverArt,
        albumCount: albumCountMap.get(artist.id) || 0,
      };
    });

    res.json({ artists: artistsWithImages });
  } catch (error) {
    logger.error("Get recently added error:", error);
    res.status(500).json({ error: "Failed to fetch recently added" });
  }
});

router.get("/tracks", async (req, res) => {
  try {
    const { albumId, sortBy = "name" } = req.query;
    const limit = parseLimit(req.query.limit, 100);
    const offset = parseOffset(req.query.offset);

    let orderBy: any;
    if (albumId) {
      orderBy = { trackNo: "asc" as const };
    } else {
      orderBy = TRACK_SORT_MAP[sortBy as string] ?? { title: "asc" as const };
    }

    const where: any = { ...IN_LIBRARY };
    if (albumId) {
      where.albumId = albumId as string;
    }

    const [tracksData, total] = await Promise.all([
      prisma.track.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: [orderBy, { id: "asc" }],
        include: WITH_ALBUM_ARTIST,
      }),
      prisma.track.count({ where }),
    ]);

    const tracks = tracksData.map((track) => ({
      ...track,
      album: {
        ...track.album,
        coverArt: track.album.coverUrl,
      },
      audioFeatures: toAudioFeaturesDTO(track),
    }));

    res.json({ tracks, total, offset, limit });
  } catch (error) {
    logger.error("Get tracks error:", error);
    res.status(500).json({ error: "Failed to fetch tracks" });
  }
});

router.get("/tracks/shuffle", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 100);

    const totalTracks = await prisma.track.count({ where: LIBRARY_PLAYABLE });

    if (totalTracks === 0) {
      return res.json({ tracks: [], total: 0 });
    }

    let tracksData;
    if (totalTracks <= limit) {
      tracksData = await prisma.track.findMany({
        where: LIBRARY_PLAYABLE,
        include: WITH_ALBUM_ARTIST,
      });
      tracksData = shuffleArray(tracksData);
    } else {
      // Random ids are drawn in SQL, so the playable rule is written out here.
      const randomIds = await prisma.$queryRaw<{ id: string }[]>`
                SELECT id FROM "Track"
                WHERE EXISTS (SELECT 1 FROM "Album" a WHERE a.id = "Track"."albumId" AND a.location = 'LIBRARY')
                  AND "Track"."missingSince" IS NULL AND "Track".corrupt = false
                ORDER BY RANDOM()
                LIMIT ${limit}
            `;

      tracksData = await prisma.track.findMany({
        where: {
          id: { in: randomIds.map((r) => r.id) },
        },
        include: WITH_ALBUM_ARTIST,
      });

      tracksData = shuffleArray(tracksData);
    }

    const tracks = tracksData.slice(0, limit).map((track) => ({
      ...track,
      album: {
        ...track.album,
        coverArt: track.album.coverUrl,
      },
    }));

    res.json({ tracks, total: totalTracks });
  } catch (error) {
    logger.error("Shuffle tracks error:", error);
    res.status(500).json({ error: "Failed to shuffle tracks" });
  }
});

router.get("/tracks/:id/lyrics", async (req, res) => {
  try {
    const existing = await prisma.trackLyrics.findUnique({
      where: { track_id: req.params.id },
    });

    if (existing && existing.source !== "none") {
      return res.json({
        plainLyrics: existing.plain_lyrics,
        syncedLyrics: existing.synced_lyrics,
        source: existing.source,
      });
    }

    if (existing && existing.source === "none") {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (existing.fetched_at > thirtyDaysAgo) {
        return res.json({
          plainLyrics: null,
          syncedLyrics: null,
          source: "none",
        });
      }
    }

    const track = await prisma.track.findUnique({
      where: { id: req.params.id },
      include: {
        album: {
          include: {
            artist: {
              select: { name: true },
            },
          },
        },
      },
    });

    if (!track) {
      return res.status(404).json({ error: "Track not found" });
    }

    const artistName = track.album.artist.name;
    const albumName = track.album.title;
    const durationSecs = track.duration || 0;

    try {
      const result = await rateLimiter.execute("lrclib", () =>
        lrclibService.fetchLyrics(
          track.title,
          artistName,
          albumName,
          durationSecs
        )
      );

      if (result) {
        await prisma.trackLyrics.upsert({
          where: { track_id: track.id },
          create: {
            track_id: track.id,
            plain_lyrics: result.plainLyrics,
            synced_lyrics: result.syncedLyrics,
            source: "lrclib",
            lrclib_id: result.id,
          },
          update: {
            plain_lyrics: result.plainLyrics,
            synced_lyrics: result.syncedLyrics,
            source: "lrclib",
            lrclib_id: result.id,
            fetched_at: new Date(),
          },
        });

        return res.json({
          plainLyrics: result.plainLyrics,
          syncedLyrics: result.syncedLyrics,
          source: "lrclib",
        });
      }

      await prisma.trackLyrics.upsert({
        where: { track_id: track.id },
        create: {
          track_id: track.id,
          source: "none",
        },
        update: {
          source: "none",
          fetched_at: new Date(),
        },
      });

      return res.json({
        plainLyrics: null,
        syncedLyrics: null,
        source: "none",
      });
    } catch (fetchError) {
      logger.error("[LYRICS] LRCLIB fetch failed:", fetchError);
      return res.json({
        plainLyrics: existing?.plain_lyrics || null,
        syncedLyrics: existing?.synced_lyrics || null,
        source: existing?.source || "none",
      });
    }
  } catch (error) {
    logger.error("Get lyrics error:", error);
    res.status(500).json({ error: "Failed to fetch lyrics" });
  }
});

router.get("/tracks/:id", async (req, res) => {
  try {
    const track = await prisma.track.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        title: true,
        duration: true,
        ...AUDIO_FEATURE_SELECT,
        album: {
          include: {
            artist: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!track) {
      return res.status(404).json({ error: "Track not found" });
    }

    const formattedTrack = {
      id: track.id,
      title: track.title,
      artist: {
        name: track.album.artist.name || "Unknown Artist",
        id: track.album.artist.id,
      },
      album: {
        title: track.album.title || "Unknown Album",
        coverArt: track.album.coverUrl,
        id: track.album.id,
      },
      duration: track.duration,
      audioFeatures: toAudioFeaturesDTO(track),
    };

    res.json(formattedTrack);
  } catch (error) {
    logger.error("Get track error:", error);
    res.status(500).json({ error: "Failed to fetch track" });
  }
});

router.delete("/tracks/:id", requireAdmin, async (req, res) => {
  try {
    const track = await prisma.track.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, filePath: true },
    });

    if (!track) {
      return res.status(404).json({ error: "Track not found" });
    }

    if (track.filePath) {
      try {
        const absolutePath = resolveWithinMusicRoot(track.filePath);

        if (!absolutePath) {
          logger.warn(
            `[DELETE] Refused out-of-root track path for ${track.id}: ${track.filePath}`,
          );
        } else if (fs.existsSync(absolutePath)) {
          fs.unlinkSync(absolutePath);
          logger.debug(`[DELETE] Deleted file: ${absolutePath}`);
        }
      } catch (err) {
        logger.warn("[DELETE] Could not delete file:", err);
      }
    }

    // The song's playlist entries go with it: tell those playlists once it is gone.
    const playlists = await playlistsHoldingTracks(prisma, { id: track.id });
    await prisma.track.delete({
      where: { id: track.id },
    });
    announcePlaylistsChanged(playlists);

    logger.debug(`[DELETE] Deleted track: ${track.title}`);

    res.json({ message: "Track deleted successfully" });
  } catch (error) {
    logger.error("Delete track error:", error);
    res.status(500).json({ error: "Failed to delete track" });
  }
});

router.get("/genres", async (_req, res) => {
  try {
    const minTracks = 15;
    // Library songs only, tallied by the shared rule (computeGenreTotals). The web's own choices on top: lowercase
    // spelling, a 15-song minimum, twenty genres at most.
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
    const genres = computeGenreTotals(
      artists.map((a) => ({ ...a, songs: Number(a.n), albums: 0 })),
    )
      .filter((g) => g.songs >= minTracks)
      .map((g) => ({ genre: g.name.toLowerCase(), count: g.songs }))
      .sort((x, y) => y.count - x.count || (x.genre < y.genre ? -1 : x.genre > y.genre ? 1 : 0))
      .slice(0, 20);

    logger.debug(
      `[Genres] Found ${genres.length} genres from Artist.genres (min ${minTracks} tracks)`,
    );

    res.json({ genres });
  } catch (error) {
    logger.error("Genres endpoint error:", error);
    res.status(500).json({ error: "Failed to get genres" });
  }
});

router.get("/decades", async (_req, res) => {
  try {
    const albums = await prisma.album.findMany({
      where: { location: LIBRARY_LOCATION },
      select: {
        year: true,
        originalYear: true,
        displayYear: true,
        _count: { select: { tracks: true } },
      },
    });

    const decadeMap = new Map<number, number>();

    for (const album of albums) {
      const effectiveYear = getEffectiveYear(album);
      if (effectiveYear) {
        const decadeStart = getDecadeFromYear(effectiveYear);
        decadeMap.set(
          decadeStart,
          (decadeMap.get(decadeStart) || 0) + album._count.tracks,
        );
      }
    }

    const decades = Array.from(decadeMap.entries())
      .map(([decade, count]) => ({ decade, count }))
      .filter((d) => d.count >= 15)
      .sort((a, b) => b.decade - a.decade);

    res.json({ decades });
  } catch (error) {
    logger.error("Decades endpoint error:", error);
    res.status(500).json({ error: "Failed to get decades" });
  }
});

/** The mood stations and their subtitles, for the apps' radio pages; generated from the recipes (stations.ts). */
router.get("/radio/stations", (_req, res) => {
  res.json({ stations: moodStationList() });
});

/**
 * The cover for each station tile a page shows, in one request: { stations: [{ type, value? }], tz? }. Each cover is
 * that listener's pick for the local day (stationCovers.ts), so it does not change between visits.
 */
router.post("/radio/covers", async (req, res) => {
  try {
    const { stations, tz } = req.body ?? {};
    if (!Array.isArray(stations) || stations.length > MAX_COVER_STATIONS) {
      return res.status(400).json({ error: `stations must be a list of at most ${MAX_COVER_STATIONS}` });
    }
    const asked: CoverStation[] = [];
    for (const entry of stations) {
      const type = entry?.type;
      const value = entry?.value;
      if (!COVER_STATION_TYPES.includes(type)) {
        return res.status(400).json({ error: "Unknown station type" });
      }
      if (value !== undefined && (typeof value !== "string" || value.length > MAX_COVER_VALUE_LENGTH)) {
        return res.status(400).json({ error: "A station's value must be a short string" });
      }
      // Only mood, genre and decade stations read a value; for the others it is dropped, so junk cannot make a pick each.
      asked.push({ type, value: STATION_TYPES_WITH_VALUE.includes(type) ? value : undefined });
    }
    const covers = await stationCovers(asked, req.user!.id, tz);
    res.json({ covers: asked.map((s, i) => ({ type: s.type, value: s.value ?? null, cover: covers[i] })) });
  } catch (error) {
    logger.error("Radio covers endpoint error:", error);
    res.status(500).json({ error: "Failed to get radio covers" });
  }
});

router.get("/radio", async (req, res) => {
  try {
    const { type, value } = req.query;
    const limitNum = parseLimit(req.query.limit, 50, 100);
    if (!type) {
      return res.status(400).json({ error: "Radio type is required" });
    }
    const picked = await selectRadioTracks(type, value, req.query, limitNum, req.user?.id);
    if ("reply" in picked) return res.status(picked.reply.status).json(picked.reply.body);
    const { trackIds, station, next } = picked;

    // Every radio plays only tracks that can play: the file is present and not corrupt. The stations checked theirs.
    const finalIds = station ? trackIds : shuffleArray([...(await stillPlayable(trackIds))]).slice(0, limitNum);

    if (finalIds.length === 0) {
      return res.json(next === undefined ? { tracks: [] } : { tracks: [], next });
    }

    const tracks = await prisma.track.findMany({
      where: {
        id: { in: finalIds },
      },
      include: {
        album: {
          include: {
            artist: {
              select: {
                id: true,
                name: true,
                identityKey: true,
              },
            },
          },
        },
        trackGenres: {
          include: {
            genre: { select: { name: true } },
          },
        },
      },
    });

    // The stations' own order, or for the other radios the same artist spread over this refill.
    const rank = new Map(finalIds.map((id, i) => [id, i]));
    const ordered = !station
        ? spreadByArtist(tracks, (t) => songArtistKey(t.id, t.album.artist.id, t.album.artist.identityKey))
        : [...tracks].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);

    const transformedTracks = ordered.map((track) => ({
      id: track.id,
      title: track.title,
      displayTitle: track.displayTitle,
      duration: track.duration,
      trackNo: track.trackNo,
      discNumber: track.discNumber,
      discSubtitle: track.discSubtitle,
      filePath: track.filePath,
      artist: {
        id: track.album.artist.id,
        name: track.album.artist.name,
      },
      album: {
        id: track.album.id,
        title: track.album.title,
        coverArt: track.album.coverUrl,
      },
    }));

    res.json(next === undefined ? { tracks: transformedTracks } : { tracks: transformedTracks, next });
  } catch (error) {
    logger.error("Radio endpoint error:", error);
    res.status(500).json({ error: "Failed to get radio tracks" });
  }
});

export default router;
