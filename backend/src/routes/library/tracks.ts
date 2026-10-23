// The mood and radio cut-offs in this file are the launch values; the record of each is
// services/audio-analyzer-clap/eval/music-switch-2026-10-17/cutoffs.json.
import { Router } from "express";
import { requireAdmin } from "../../middleware/auth";
import { announcePlaylistsChanged, playlistsHoldingTracks } from "../../services/playlistEvents";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { lrclibService } from "../../services/lrclib";
import { rateLimiter } from "../../services/rateLimiter";
import { getMergedGenres } from "../../utils/metadataOverrides";
import {
  getEffectiveYear,
  getEffectiveDecadeWhereClause,
  getDecadeFromYear,
} from "../../utils/dateFilters";
import { shuffleArray } from "../../utils/shuffle";
import { drawIds, drawWeighted, sampleTrackIds, unplayedTrackIds } from "../../services/mixes/helpers";
import { LIBRARY_TRACK_WHERE, LIBRARY_LOCATION } from "../../services/libraryFilters";
import { PLAYABLE } from "../../utils/libraryEligibility";
import { toAudioFeaturesDTO, AUDIO_FEATURE_SELECT } from "../../utils/audioFeatures";
import { resolveWithinMusicRoot } from "./trackPath";
import { parseLimit, parseOffset } from "./paging";
import fs from "fs";

const TRACK_SORT_MAP: Record<string, any> = {
  name: { title: "asc" as const },
  "name-desc": { title: "desc" as const },
};

const router = Router();

router.get("/recently-listened", async (req, res) => {
  try {
    const { limit = "10" } = req.query;
    const userId = req.user!.id;
    const limitNum = Math.min(parseInt(limit as string, 10) || 10, 100);

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
    const { limit = "10" } = req.query;
    const limitNum = parseInt(limit as string, 10);

    const recentAlbums = await prisma.album.findMany({
      where: {
        location: LIBRARY_LOCATION,
        tracks: { some: {} },
      },
      orderBy: { lastSynced: "desc" },
      take: 20,
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
    });

    const artistsMap = new Map();
    for (const album of recentAlbums) {
      if (!artistsMap.has(album.artist.id)) {
        artistsMap.set(album.artist.id, album.artist);
      }
      if (artistsMap.size >= limitNum) break;
    }

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
    const {
      albumId,
      limit: limitParam = "100",
      offset: offsetParam = "0",
      sortBy = "name",
    } = req.query;
    const limit = parseLimit(limitParam, 100);
    const offset = parseOffset(offsetParam);

    let orderBy: any;
    if (albumId) {
      orderBy = { trackNo: "asc" as const };
    } else {
      orderBy = TRACK_SORT_MAP[sortBy as string] ?? { title: "asc" as const };
    }

    const where: any = { ...LIBRARY_TRACK_WHERE };
    if (albumId) {
      where.albumId = albumId as string;
    }

    const [tracksData, total] = await Promise.all([
      prisma.track.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: [orderBy, { id: "asc" }],
        include: {
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
    const { limit: limitParam = "100" } = req.query;
    const limit = parseLimit(limitParam, 100);

    const playable = { ...LIBRARY_TRACK_WHERE, ...PLAYABLE };
    const totalTracks = await prisma.track.count({ where: playable });

    if (totalTracks === 0) {
      return res.json({ tracks: [], total: 0 });
    }

    let tracksData;
    if (totalTracks <= limit) {
      tracksData = await prisma.track.findMany({
        where: playable,
        include: {
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
        include: {
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

    const artistName = track.album?.artist?.name || "";
    const albumName = track.album?.title || "";
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
        name: track.album?.artist?.name || "Unknown Artist",
        id: track.album?.artist?.id,
      },
      album: {
        title: track.album?.title || "Unknown Album",
        coverArt: track.album?.coverUrl,
        id: track.album?.id,
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
      include: {
        album: {
          include: {
            artist: true,
          },
        },
      },
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
    const artists = await prisma.artist.findMany({
      select: { name: true, normalizedName: true },
    });
    const artistNames = new Set(
      artists.flatMap((a) =>
        [a.name.toLowerCase(), a.normalizedName?.toLowerCase()].filter(Boolean),
      ),
    );

    const minTracks = 15;
    // An artist's tracks may live in the DISCOVER pile as well as the owned
    // library; only owned tracks may feed the genre tallies (the whole point
    // of the libraryFilters rule).
    const genreResults = await prisma.$queryRaw<
      { genre: string; track_count: bigint }[]
    >`
            SELECT LOWER(g.genre) as genre, COUNT(DISTINCT t.id) as track_count
            FROM "Artist" ar
            CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(ar.genres) = 'array' THEN ar.genres ELSE '[]'::jsonb END) AS g(genre)
            JOIN "Album" a ON a."artistId" = ar.id
            JOIN "Track" t ON t."albumId" = a.id
            WHERE ar.genres IS NOT NULL
              AND a.location = 'LIBRARY'
            GROUP BY LOWER(g.genre)
            HAVING COUNT(DISTINCT t.id) >= ${minTracks}
            ORDER BY track_count DESC
            LIMIT 20
        `;

    const genres = genreResults
      .map((row) => ({
        genre: row.genre,
        count: Number(row.track_count),
      }))
      .filter((g) => !artistNames.has(g.genre.toLowerCase()));

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

router.get("/radio", async (req, res) => {
  try {
    const { type, value, limit = "50" } = req.query;
    const limitNum = Math.min(parseLimit(limit, 50), 100);
    if (!type) {
      return res.status(400).json({ error: "Radio type is required" });
    }

    let trackIds: string[] = [];

    switch (type) {
      case "discovery":
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

      case "favorites":
        const mostPlayedTracks = await prisma.$queryRaw<
          { id: string; play_count: bigint }[]
        >`
                    SELECT t.id, COUNT(p.id) as play_count
                    FROM "Track" t
                    LEFT JOIN "Play" p ON p."trackId" = t.id
                    WHERE t."missingSince" IS NULL AND t.corrupt = false
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

      case "decade":
        const decadeStart = parseInt(value as string) || 2000;

        trackIds = await sampleTrackIds({
          where: {
            album: getEffectiveDecadeWhereClause(decadeStart),
          },
          take: limitNum * 3,
        });
        break;

      case "genre":
        const genreValue = ((value as string) || "").toLowerCase();

        const genreTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT DISTINCT t.id
                    FROM "Artist" ar
                    JOIN "Album" a ON a."artistId" = ar.id
                    JOIN "Track" t ON t."albumId" = a.id
                    WHERE (
                        (ar.genres IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ar.genres) = 'array' THEN ar.genres ELSE '[]'::jsonb END) AS g(genre)
                            WHERE LOWER(g.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                        OR
                        (ar."userGenres" IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ar."userGenres") = 'array' THEN ar."userGenres" ELSE '[]'::jsonb END) AS ug(genre)
                            WHERE LOWER(ug.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                    )
                `;
        trackIds = drawIds(
          genreTracks.map((t) => t.id),
          limitNum * 2,
        );

        logger.debug(
          `[Radio:genre] Found ${trackIds.length} tracks for genre "${genreValue}" from Artist.genres and userGenres`,
        );
        break;

      case "mood":
        const moodValue = ((value as string) || "").toLowerCase();
        // The five named moods are the mood-bucket verdicts, as on the mood page;
        // the other values are audio-feature filters.
        const BUCKET_MOODS: Record<string, "happy" | "sad" | "chill" | "aggressive" | "party"> = {
          happy: "happy",
          melancholy: "sad",
          chill: "chill",
          intense: "aggressive",
          dance: "party",
        };
        if (BUCKET_MOODS[moodValue]) {
            // Weighted draw without replacement in the database: the smallest
            // -LN(1 - random()) / score come first (Efraimidis-Spirakis, as drawWeighted).
            const bucketRows = await prisma.$queryRaw<{ trackId: string }[]>`
                SELECT "trackId"
                FROM "MoodBucket"
                WHERE mood = ${BUCKET_MOODS[moodValue]} AND score > 0
                ORDER BY -LN(1 - random()) / score ASC
                LIMIT ${limitNum * 3}
            `;
            trackIds = bucketRows.map((r) => r.trackId);
            break;
        }
        let moodWhere: any = { analysisStatus: "completed" };

        switch (moodValue) {
          case "high-energy":
            moodWhere = {
              analysisStatus: "completed",
              energy: { gte: 0.7 },
              bpm: { gte: 120 },
            };
            break;
          case "acoustic":
            moodWhere = {
              analysisStatus: "completed",
              acousticness: { gte: 0.6 },
            };
            break;
          case "instrumental":
            moodWhere = {
              analysisStatus: "completed",
              instrumentalness: { gte: 0.7 },
            };
            break;
          default:
            return res.status(400).json({ error: `Unknown mood: ${moodValue}` });
        }

        trackIds = await sampleTrackIds({
          where: moodWhere,
          take: limitNum * 3,
        });
        break;

      case "workout":
        let workoutTrackIds: string[] = [];

        workoutTrackIds = await sampleTrackIds({
          where: {
            analysisStatus: "completed",
            OR: [
              {
                AND: [{ energy: { gte: 0.65 } }, { bpm: { gte: 115 } }],
              },
              {
                moodTags: {
                  hasSome: ["workout", "energetic", "upbeat"],
                },
              },
            ],
          },
          take: limitNum * 2,
        });
        logger.debug(
          `[Radio:workout] Found ${workoutTrackIds.length} tracks via audio analysis`,
        );

        if (workoutTrackIds.length < limitNum) {
          const workoutGenreNames = [
            "rock",
            "metal",
            "hard rock",
            "alternative rock",
            "punk",
            "hip hop",
            "rap",
            "trap",
            "electronic",
            "edm",
            "house",
            "techno",
            "drum and bass",
            "dubstep",
            "hardstyle",
            "metalcore",
            "hardcore",
            "industrial",
            "nu metal",
            "pop punk",
          ];

          const workoutGenres = await prisma.genre.findMany({
            where: {
              name: {
                in: workoutGenreNames,
                mode: "insensitive",
              },
            },
            select: { id: true },
          });

          const genreTrackIds =
            workoutGenres.length === 0
              ? []
              : drawIds(
                  (
                    await prisma.trackGenre.groupBy({
                      by: ["trackId"],
                      where: { genreId: { in: workoutGenres.map((g) => g.id) } },
                      orderBy: { trackId: "asc" },
                    })
                  ).map((tg) => tg.trackId),
                  50 * workoutGenres.length,
                );
          workoutTrackIds = [
            ...new Set([...workoutTrackIds, ...genreTrackIds]),
          ];
          logger.debug(
            `[Radio:workout] After genre check: ${workoutTrackIds.length} tracks`,
          );

          if (workoutTrackIds.length < limitNum) {
            // Album.genres is a JSON array of names, which string_contains never
            // matches (it reads a JSON string), so the names are matched in SQL.
            const albumGenreTrackIds = drawIds(
              (
                await prisma.$queryRaw<{ id: string }[]>`
                  SELECT t.id
                  FROM "Track" t
                  JOIN "Album" a ON a.id = t."albumId"
                  WHERE jsonb_typeof(a.genres) = 'array'
                    AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(a.genres) AS g(genre)
                      CROSS JOIN unnest(${workoutGenreNames}::text[]) AS p(name)
                      WHERE strpos(lower(g.genre), p.name) > 0
                    )
                  ORDER BY t.id
                `
              ).map((r) => r.id),
              limitNum,
            );
            workoutTrackIds = [
              ...new Set([
                ...workoutTrackIds,
                ...albumGenreTrackIds,
              ]),
            ];
            logger.debug(
              `[Radio:workout] After album genre check: ${workoutTrackIds.length} tracks`,
            );
          }
        }

        trackIds = workoutTrackIds;
        break;

      case "artist":
        const artistId = value as string;
        if (!artistId) {
          return res
            .status(400)
            .json({ error: "Artist ID required for artist radio" });
        }

        logger.debug(`[Radio:artist] Starting artist radio for: ${artistId}`);

        const artistTracks = await prisma.track.findMany({
          where: { album: { artistId } },
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
          return res.json({ tracks: [] });
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

        const ownedArtists = await prisma.ownedAlbum.findMany({
          select: { artistId: true },
          distinct: ["artistId"],
        });
        const libraryArtistIds = new Set(ownedArtists.map((o) => o.artistId));
        libraryArtistIds.delete(artistId);
        logger.debug(
          `[Radio:artist] Library has ${libraryArtistIds.size} other artists`,
        );

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

        if (similarArtistIds.length < 5 && libraryArtistIds.size > 0) {
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
              album: { artistId: { in: similarArtistIds } },
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
        // Tracks with a closeness score are drawn in proportion to it. Tracks
        // without one (no artist sound to compare with) are drawn uniformly, and
        // get the share of the slots that their share of the candidates is, rounded
        // to a whole track. A track scoring exactly 0 has no weight, so it is
        // taken only when too few weighted tracks are left to fill the slots.
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

      case "all":
      default:
        trackIds = await sampleTrackIds({ where: {}, take: 300 });
    }

    // Every station draws only tracks that can play: the file is present and not corrupt.
    const playable = await prisma.track.findMany({
      where: { id: { in: trackIds }, ...PLAYABLE },
      select: { id: true },
    });
    const finalIds = shuffleArray(playable.map((t) => t.id)).slice(0, limitNum);

    if (finalIds.length === 0) {
      return res.json({ tracks: [] });
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

    const transformedTracks = tracks.map((track) => ({
      id: track.id,
      title: track.title,
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

    res.json({ tracks: shuffleArray(transformedTracks) });
  } catch (error) {
    logger.error("Radio endpoint error:", error);
    res.status(500).json({ error: "Failed to get radio tracks" });
  }
});

export default router;
