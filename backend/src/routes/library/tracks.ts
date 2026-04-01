import { Router } from "express";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { lrclibService } from "../../services/lrclib";
import { rateLimiter } from "../../services/rateLimiter";
import { getMergedGenres } from "../../utils/metadataOverrides";
import {
  getEffectiveYear,
  getDecadeWhereClause,
  getDecadeFromYear,
} from "../../utils/dateFilters";
import { shuffleArray } from "../../utils/shuffle";
import { config } from "../../config";
import path from "path";
import fs from "fs";

const TRACK_SORT_MAP: Record<string, any> = {
  name: { title: "asc" as const },
  "name-desc": { title: "desc" as const },
};

const MAX_LIMIT = 10000;

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
                location: "LIBRARY",
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

    const items: any[] = [];
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
      if (items.length >= limitNum) break;
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
        location: "LIBRARY",
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
        location: "LIBRARY",
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
    const limit = Math.min(
      parseInt(limitParam as string, 10) || 100,
      MAX_LIMIT,
    );
    const offset = parseInt(offsetParam as string, 10) || 0;

    let orderBy: any;
    if (albumId) {
      orderBy = { trackNo: "asc" as const };
    } else {
      orderBy = TRACK_SORT_MAP[sortBy as string] ?? { title: "asc" as const };
    }

    const where: any = {};
    if (albumId) {
      where.albumId = albumId as string;
    }

    const [tracksData, total] = await Promise.all([
      prisma.track.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy,
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
    const limit = Math.min(
      parseInt(limitParam as string, 10) || 100,
      MAX_LIMIT,
    );

    const totalTracks = await prisma.track.count();

    if (totalTracks === 0) {
      return res.json({ tracks: [], total: 0 });
    }

    let tracksData;
    if (totalTracks <= limit) {
      tracksData = await prisma.track.findMany({
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
      const randomIds = await prisma.$queryRaw<{ id: string }[]>`
                SELECT id FROM "Track"
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

      for (let i = tracksData.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracksData[i], tracksData[j]] = [tracksData[j], tracksData[i]];
      }
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
    };

    res.json(formattedTrack);
  } catch (error) {
    logger.error("Get track error:", error);
    res.status(500).json({ error: "Failed to fetch track" });
  }
});

router.delete("/tracks/:id", async (req, res) => {
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
        const absolutePath = path.join(config.music.musicPath, track.filePath);

        if (fs.existsSync(absolutePath)) {
          fs.unlinkSync(absolutePath);
          logger.debug(`[DELETE] Deleted file: ${absolutePath}`);
        }
      } catch (err) {
        logger.warn("[DELETE] Could not delete file:", err);
      }
    }

    await prisma.track.delete({
      where: { id: track.id },
    });

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
    const genreResults = await prisma.$queryRaw<
      { genre: string; track_count: bigint }[]
    >`
            SELECT LOWER(g.genre) as genre, COUNT(DISTINCT t.id) as track_count
            FROM "Artist" ar
            CROSS JOIN LATERAL jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
            JOIN "Album" a ON a."artistId" = ar.id
            JOIN "Track" t ON t."albumId" = a.id
            WHERE ar.genres IS NOT NULL
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
    const limitNum = Math.min(parseInt(limit as string) || 50, 100);
    if (!type) {
      return res.status(400).json({ error: "Radio type is required" });
    }

    let trackIds: string[] = [];
    let vibeSourceFeatures: any = null;

    switch (type) {
      case "discovery":
        const unplayedTracks = await prisma.track.findMany({
          where: {
            plays: { none: {} },
          },
          select: { id: true },
          take: limitNum * 2,
        });

        if (unplayedTracks.length >= limitNum) {
          trackIds = unplayedTracks.map((t) => t.id);
        } else {
          const leastPlayedTracks = await prisma.$queryRaw<{ id: string }[]>`
                        SELECT t.id
                        FROM "Track" t
                        LEFT JOIN "Play" p ON p."trackId" = t.id
                        GROUP BY t.id
                        ORDER BY COUNT(p.id) ASC
                        LIMIT ${limitNum * 2}
                    `;
          trackIds = leastPlayedTracks.map((t) => t.id);
        }
        break;

      case "favorites":
        const mostPlayedTracks = await prisma.$queryRaw<
          { id: string; play_count: bigint }[]
        >`
                    SELECT t.id, COUNT(p.id) as play_count
                    FROM "Track" t
                    LEFT JOIN "Play" p ON p."trackId" = t.id
                    GROUP BY t.id
                    HAVING COUNT(p.id) > 0
                    ORDER BY play_count DESC
                    LIMIT ${limitNum * 2}
                `;

        if (mostPlayedTracks.length > 0) {
          trackIds = mostPlayedTracks.map((t) => t.id);
        } else {
          logger.debug(
            "[Radio:favorites] No play data found, returning random tracks",
          );
          const randomTracks = await prisma.track.findMany({
            select: { id: true },
            take: limitNum * 2,
          });
          trackIds = randomTracks.map((t) => t.id);
        }
        break;

      case "decade":
        const decadeStart = parseInt(value as string) || 2000;

        const decadeTracks = await prisma.track.findMany({
          where: {
            album: getDecadeWhereClause(decadeStart),
          },
          select: { id: true },
          take: limitNum * 3,
        });
        trackIds = decadeTracks.map((t) => t.id);
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
                            SELECT 1 FROM jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
                            WHERE LOWER(g.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                        OR
                        (ar."userGenres" IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(ar."userGenres"::jsonb) AS ug(genre)
                            WHERE LOWER(ug.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                    )
                    LIMIT ${limitNum * 2}
                `;
        trackIds = genreTracks.map((t) => t.id);

        logger.debug(
          `[Radio:genre] Found ${trackIds.length} tracks for genre "${genreValue}" from Artist.genres and userGenres`,
        );
        break;

      case "mood":
        const moodValue = ((value as string) || "").toLowerCase();
        let moodWhere: any = { analysisStatus: "completed" };

        switch (moodValue) {
          case "high-energy":
            moodWhere = {
              analysisStatus: "completed",
              energy: { gte: 0.7 },
              bpm: { gte: 120 },
            };
            break;
          case "chill":
            moodWhere = {
              analysisStatus: "completed",
              OR: [{ energy: { lte: 0.4 } }, { arousal: { lte: 0.4 } }],
            };
            break;
          case "happy":
            moodWhere = {
              analysisStatus: "completed",
              valence: { gte: 0.6 },
              energy: { gte: 0.5 },
            };
            break;
          case "melancholy":
            moodWhere = {
              analysisStatus: "completed",
              OR: [{ valence: { lte: 0.4 } }, { keyScale: "minor" }],
            };
            break;
          case "dance":
            moodWhere = {
              analysisStatus: "completed",
              danceability: { gte: 0.7 },
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
            moodWhere = {
              lastfmTags: { has: moodValue },
            };
        }

        const moodTracks = await prisma.track.findMany({
          where: moodWhere,
          select: { id: true },
          take: limitNum * 3,
        });
        trackIds = moodTracks.map((t) => t.id);
        break;

      case "workout":
        let workoutTrackIds: string[] = [];

        const energyTracks = await prisma.track.findMany({
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
          select: { id: true },
          take: limitNum * 2,
        });
        workoutTrackIds = energyTracks.map((t) => t.id);
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
            include: {
              trackGenres: {
                select: { trackId: true },
                take: 50,
              },
            },
          });

          const genreTrackIds = workoutGenres.flatMap((g) =>
            g.trackGenres.map((tg) => tg.trackId),
          );
          workoutTrackIds = [
            ...new Set([...workoutTrackIds, ...genreTrackIds]),
          ];
          logger.debug(
            `[Radio:workout] After genre check: ${workoutTrackIds.length} tracks`,
          );

          if (workoutTrackIds.length < limitNum) {
            const albumGenreTracks = await prisma.track.findMany({
              where: {
                album: {
                  OR: workoutGenreNames.map((g) => ({
                    genres: { string_contains: g },
                  })),
                },
              },
              select: { id: true },
              take: limitNum,
            });
            workoutTrackIds = [
              ...new Set([
                ...workoutTrackIds,
                ...albumGenreTracks.map((t) => t.id),
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
            toArtistId: { in: Array.from(libraryArtistIds) },
          },
          orderBy: { weight: "desc" },
          take: 15,
        });
        let similarArtistIds = similarInLibrary.map((s) => s.toArtistId);
        logger.debug(
          `[Radio:artist] Found ${similarArtistIds.length} Last.fm similar artists in library`,
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
                id: { in: Array.from(libraryArtistIds) },
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

        const originalCount = Math.min(
          Math.ceil(limitNum * 0.4),
          artistTracks.length,
        );
        const similarCount = Math.min(
          limitNum - originalCount,
          similarTracks.length,
        );

        const selectedOriginal = shuffleArray(artistTracks).slice(
          0,
          originalCount,
        );
        const selectedSimilar = shuffleArray(
          similarTracks.slice(0, similarCount * 2),
        ).slice(0, similarCount);

        trackIds = [...selectedOriginal, ...selectedSimilar].map((t) => t.id);
        logger.debug(
          `[Radio:artist] Final mix: ${selectedOriginal.length} original + ${selectedSimilar.length} similar = ${trackIds.length} tracks`,
        );
        break;

      case "vibe":
        const sourceTrackId = value as string;
        if (!sourceTrackId) {
          return res
            .status(400)
            .json({ error: "Track ID required for vibe matching" });
        }

        logger.debug(
          `[Radio:vibe] Starting vibe match for track: ${sourceTrackId}`,
        );

        const sourceTrack = (await prisma.track.findUnique({
          where: { id: sourceTrackId },
          include: {
            album: {
              select: {
                artistId: true,
                genres: true,
                artist: { select: { id: true, name: true } },
              },
            },
          },
        })) as any;

        if (!sourceTrack) {
          return res.status(404).json({ error: "Track not found" });
        }

        const isEnhancedAnalysis =
          sourceTrack.analysisMode === "enhanced" ||
          (sourceTrack.moodHappy !== null && sourceTrack.moodSad !== null);

        logger.debug(
          `[Radio:vibe] Source: "${sourceTrack.title}" by ${sourceTrack.album.artist.name}`,
        );
        logger.debug(
          `[Radio:vibe] Analysis mode: ${
            isEnhancedAnalysis ? "ENHANCED" : "STANDARD"
          }`,
        );
        logger.debug(
          `[Radio:vibe] Source features: BPM=${sourceTrack.bpm}, Energy=${sourceTrack.energy}, Valence=${sourceTrack.valence}`,
        );
        if (isEnhancedAnalysis) {
          logger.debug(
            `[Radio:vibe] ML Moods: Happy=${sourceTrack.moodHappy}, Sad=${sourceTrack.moodSad}, Relaxed=${sourceTrack.moodRelaxed}, Aggressive=${sourceTrack.moodAggressive}, Party=${sourceTrack.moodParty}, Acoustic=${sourceTrack.moodAcoustic}, Electronic=${sourceTrack.moodElectronic}`,
          );
        }

        vibeSourceFeatures = {
          bpm: sourceTrack.bpm,
          energy: sourceTrack.energy,
          valence: sourceTrack.valence,
          arousal: sourceTrack.arousal,
          danceability: sourceTrack.danceability,
          keyScale: sourceTrack.keyScale,
          instrumentalness: sourceTrack.instrumentalness,
          moodHappy: sourceTrack.moodHappy,
          moodSad: sourceTrack.moodSad,
          moodRelaxed: sourceTrack.moodRelaxed,
          moodAggressive: sourceTrack.moodAggressive,
          moodParty: sourceTrack.moodParty,
          moodAcoustic: sourceTrack.moodAcoustic,
          moodElectronic: sourceTrack.moodElectronic,
          analysisMode: isEnhancedAnalysis ? "enhanced" : "standard",
        };

        let vibeMatchedIds: string[] = [];
        const sourceArtistId = sourceTrack.album.artistId;

        const hasAudioData =
          sourceTrack.bpm || sourceTrack.energy || sourceTrack.valence;

        if (hasAudioData) {
          const analyzedVibeCandiates = await prisma.track.findMany({
            where: {
              id: { not: sourceTrackId },
              analysisStatus: "completed",
            },
            take: 500,
            select: {
              id: true,
              bpm: true,
              energy: true,
              valence: true,
              arousal: true,
              danceability: true,
              keyScale: true,
              moodTags: true,
              lastfmTags: true,
              essentiaGenres: true,
              instrumentalness: true,
              moodHappy: true,
              moodSad: true,
              moodRelaxed: true,
              moodAggressive: true,
              moodParty: true,
              moodAcoustic: true,
              moodElectronic: true,
              danceabilityMl: true,
              analysisMode: true,
            },
          });

          logger.debug(
            `[Radio:vibe] Found ${analyzedVibeCandiates.length} analyzed tracks to compare`,
          );

          if (analyzedVibeCandiates.length > 0) {
            const calculateEnhancedValence = (track: any): number => {
              const happy = track.moodHappy ?? 0.5;
              const sad = track.moodSad ?? 0.5;
              const party = (track as any).moodParty ?? 0.5;
              const isMajor = track.keyScale === "major";
              const isMinor = track.keyScale === "minor";
              const modeValence = isMajor ? 0.3 : isMinor ? -0.2 : 0;
              const moodValence = happy * 0.35 + party * 0.25 + (1 - sad) * 0.2;
              const audioValence =
                (track.energy ?? 0.5) * 0.1 +
                (track.danceabilityMl ?? track.danceability ?? 0.5) * 0.1;

              return Math.max(
                0,
                Math.min(1, moodValence + modeValence + audioValence),
              );
            };

            const calculateEnhancedArousal = (track: any): number => {
              const aggressive = track.moodAggressive ?? 0.5;
              const party = (track as any).moodParty ?? 0.5;
              const relaxed = track.moodRelaxed ?? 0.5;
              const acoustic = (track as any).moodAcoustic ?? 0.5;
              const energy = track.energy ?? 0.5;
              const bpm = track.bpm ?? 120;
              const moodArousal = aggressive * 0.3 + party * 0.2;
              const energyArousal = energy * 0.25;
              const tempoArousal =
                Math.max(0, Math.min(1, (bpm - 60) / 120)) * 0.15;
              const calmReduction =
                (1 - relaxed) * 0.05 + (1 - acoustic) * 0.05;

              return Math.max(
                0,
                Math.min(
                  1,
                  moodArousal + energyArousal + tempoArousal + calmReduction,
                ),
              );
            };

            const detectOOD = (track: any): boolean => {
              const coreMoods = [
                track.moodHappy ?? 0.5,
                track.moodSad ?? 0.5,
                track.moodRelaxed ?? 0.5,
                track.moodAggressive ?? 0.5,
              ];

              const minMood = Math.min(...coreMoods);
              const maxMood = Math.max(...coreMoods);

              const allHigh = minMood > 0.7 && maxMood - minMood < 0.3;
              const allNeutral =
                Math.abs(maxMood - 0.5) < 0.15 &&
                Math.abs(minMood - 0.5) < 0.15;

              return allHigh || allNeutral;
            };

            const octaveAwareBPMDistance = (
              bpm1: number,
              bpm2: number,
            ): number => {
              if (!bpm1 || !bpm2) return 0;

              const normalizeToOctave = (bpm: number): number => {
                if (!bpm || bpm <= 0 || !isFinite(bpm)) return 120;
                while (bpm < 77) bpm *= 2;
                while (bpm > 154) bpm /= 2;
                return bpm;
              };

              const norm1 = normalizeToOctave(bpm1);
              const norm2 = normalizeToOctave(bpm2);

              const logDistance = Math.abs(Math.log2(norm1) - Math.log2(norm2));
              return Math.min(logDistance, 1);
            };

            const buildFeatureVector = (track: any): number[] => {
              const isOOD = detectOOD(track);

              const getMoodValue = (
                value: number | null,
                defaultValue: number,
              ): number => {
                if (!value) return defaultValue;
                if (!isOOD) return value;
                return 0.2 + Math.max(0, Math.min(0.6, value - 0.2));
              };

              const enhancedValence = calculateEnhancedValence(track);
              const enhancedArousal = calculateEnhancedArousal(track);

              return [
                getMoodValue(track.moodHappy, 0.5) * 1.3,
                getMoodValue(track.moodSad, 0.5) * 1.3,
                getMoodValue(track.moodRelaxed, 0.5) * 1.3,
                getMoodValue(track.moodAggressive, 0.5) * 1.3,
                getMoodValue((track as any).moodParty, 0.5) * 1.3,
                getMoodValue((track as any).moodAcoustic, 0.5) * 1.3,
                getMoodValue((track as any).moodElectronic, 0.5) * 1.3,
                track.energy ?? 0.5,
                enhancedArousal,
                track.danceabilityMl ?? track.danceability ?? 0.5,
                track.instrumentalness ?? 0.5,
                1 - octaveAwareBPMDistance(track.bpm ?? 120, 120),
                enhancedValence,
              ];
            };

            const cosineSimilarity = (a: number[], b: number[]): number => {
              let dot = 0,
                magA = 0,
                magB = 0;
              for (let i = 0; i < a.length; i++) {
                dot += a[i] * b[i];
                magA += a[i] * a[i];
                magB += b[i] * b[i];
              }
              if (magA === 0 || magB === 0) return 0;
              return dot / (Math.sqrt(magA) * Math.sqrt(magB));
            };

            const computeTagBonus = (
              sourceTags: string[],
              sourceGenres: string[],
              trackTags: string[],
              trackGenres: string[],
            ): number => {
              const sourceSet = new Set(
                [...sourceTags, ...sourceGenres].map((t) => t.toLowerCase()),
              );
              const trackSet = new Set(
                [...trackTags, ...trackGenres].map((t) => t.toLowerCase()),
              );
              if (sourceSet.size === 0 || trackSet.size === 0) return 0;
              const overlap = [...sourceSet].filter((tag) =>
                trackSet.has(tag),
              ).length;
              return Math.min(0.05, overlap * 0.01);
            };

            const sourceVector = buildFeatureVector(sourceTrack);
            const bothEnhanced = isEnhancedAnalysis;

            const scored = analyzedVibeCandiates.map((t) => {
              const targetEnhanced =
                t.analysisMode === "enhanced" ||
                (t.moodHappy !== null && t.moodSad !== null);
              const useEnhanced = bothEnhanced && targetEnhanced;

              const targetVector = buildFeatureVector(t as any);

              let score = cosineSimilarity(sourceVector, targetVector);

              const tagBonus = computeTagBonus(
                sourceTrack.lastfmTags || [],
                sourceTrack.essentiaGenres || [],
                t.lastfmTags || [],
                t.essentiaGenres || [],
              );

              const finalScore = score * 0.95 + tagBonus;

              return {
                id: t.id,
                score: finalScore,
                enhanced: useEnhanced,
              };
            });

            const minThreshold = isEnhancedAnalysis ? 0.4 : 0.5;
            const goodMatches = scored
              .filter((t) => t.score > minThreshold)
              .sort((a, b) => b.score - a.score);

            vibeMatchedIds = goodMatches.map((t) => t.id);
            const enhancedCount = goodMatches.filter((t) => t.enhanced).length;
            logger.debug(
              `[Radio:vibe] Audio matching found ${
                vibeMatchedIds.length
              } tracks (>${minThreshold * 100}% similarity)`,
            );
            logger.debug(
              `[Radio:vibe] Enhanced matches: ${enhancedCount}, Standard matches: ${
                goodMatches.length - enhancedCount
              }`,
            );

            if (goodMatches.length > 0) {
              logger.debug(
                `[Radio:vibe] Top match score: ${goodMatches[0].score.toFixed(
                  2,
                )} (${goodMatches[0].enhanced ? "enhanced" : "standard"})`,
              );
            }
          }
        }

        if (vibeMatchedIds.length < limitNum) {
          const vibeArtistFallbackTracks = await prisma.track.findMany({
            where: {
              album: { artistId: sourceArtistId },
              id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
            },
            select: { id: true },
          });
          const newIds = vibeArtistFallbackTracks.map((t) => t.id);
          vibeMatchedIds = [...vibeMatchedIds, ...newIds];
          logger.debug(
            `[Radio:vibe] Fallback A (same artist): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
          );
        }

        if (vibeMatchedIds.length < limitNum) {
          const ownedArtistIds = await prisma.ownedAlbum.findMany({
            select: { artistId: true },
            distinct: ["artistId"],
          });
          const libraryArtistSet = new Set(
            ownedArtistIds.map((o) => o.artistId),
          );
          libraryArtistSet.delete(sourceArtistId);

          const similarArtists = await prisma.similarArtist.findMany({
            where: {
              fromArtistId: sourceArtistId,
              toArtistId: { in: Array.from(libraryArtistSet) },
            },
            orderBy: { weight: "desc" },
            take: 10,
          });

          if (similarArtists.length > 0) {
            const similarArtistTracks = await prisma.track.findMany({
              where: {
                album: {
                  artistId: {
                    in: similarArtists.map((s) => s.toArtistId),
                  },
                },
                id: {
                  notIn: [sourceTrackId, ...vibeMatchedIds],
                },
              },
              select: { id: true },
            });
            const newIds = similarArtistTracks.map((t) => t.id);
            vibeMatchedIds = [...vibeMatchedIds, ...newIds];
            logger.debug(
              `[Radio:vibe] Fallback B (similar artists): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
            );
          }
        }

        const sourceGenres = (sourceTrack.album.genres as string[]) || [];
        if (vibeMatchedIds.length < limitNum && sourceGenres.length > 0) {
          const vibeGenreTracks = await prisma.track.findMany({
            where: {
              trackGenres: {
                some: {
                  genre: {
                    name: {
                      in: sourceGenres,
                      mode: "insensitive",
                    },
                  },
                },
              },
              id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
            },
            select: { id: true },
            take: limitNum,
          });
          const newIds = vibeGenreTracks.map((t) => t.id);
          vibeMatchedIds = [...vibeMatchedIds, ...newIds];
          logger.debug(
            `[Radio:vibe] Fallback C (same genre): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
          );
        }

        if (vibeMatchedIds.length < limitNum) {
          const randomTracks = await prisma.track.findMany({
            where: {
              id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
            },
            select: { id: true },
            take: limitNum - vibeMatchedIds.length,
          });
          const newIds = randomTracks.map((t) => t.id);
          vibeMatchedIds = [...vibeMatchedIds, ...newIds];
          logger.debug(
            `[Radio:vibe] Fallback D (random): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
          );
        }

        trackIds = vibeMatchedIds;
        logger.debug(
          `[Radio:vibe] Final vibe queue: ${trackIds.length} tracks`,
        );
        break;

      case "all":
      default:
        const allTracks = await prisma.track.findMany({
          select: { id: true },
          take: 300,
        });
        trackIds = allTracks.map((t) => t.id);
    }

    const finalIds =
      type === "vibe"
        ? trackIds.slice(0, limitNum)
        : shuffleArray(trackIds).slice(0, limitNum);

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

    let orderedTracks = tracks;
    if (type === "vibe") {
      const trackMap = new Map(tracks.map((t) => [t.id, t]));
      orderedTracks = finalIds
        .map((id) => trackMap.get(id))
        .filter((t): t is (typeof tracks)[0] => t !== undefined);
    }

    if (type === "vibe" && vibeSourceFeatures) {
      logger.debug("\n" + "=".repeat(100));
      logger.debug("VIBE QUEUE ANALYSIS - Source Track");
      logger.debug("=".repeat(100));

      const srcTrack = await prisma.track.findUnique({
        where: { id: value as string },
        include: {
          album: { include: { artist: { select: { name: true } } } },
          trackGenres: {
            include: { genre: { select: { name: true } } },
          },
        },
      });

      if (srcTrack) {
        logger.debug(
          `SOURCE: "${srcTrack.title}" by ${srcTrack.album.artist.name}`,
        );
        logger.debug(`  Album: ${srcTrack.album.title}`);
        logger.debug(
          `  Analysis Mode: ${(srcTrack as any).analysisMode || "unknown"}`,
        );
        logger.debug(
          `  BPM: ${srcTrack.bpm?.toFixed(1) || "N/A"} | Energy: ${
            srcTrack.energy?.toFixed(2) || "N/A"
          } | Valence: ${srcTrack.valence?.toFixed(2) || "N/A"}`,
        );
        logger.debug(
          `  Danceability: ${
            srcTrack.danceability?.toFixed(2) || "N/A"
          } | Arousal: ${
            srcTrack.arousal?.toFixed(2) || "N/A"
          } | Key: ${srcTrack.keyScale || "N/A"}`,
        );
        logger.debug(
          `  ML Moods: Happy=${
            (srcTrack as any).moodHappy?.toFixed(2) || "N/A"
          }, Sad=${(srcTrack as any).moodSad?.toFixed(2) || "N/A"}, Relaxed=${
            (srcTrack as any).moodRelaxed?.toFixed(2) || "N/A"
          }, Aggressive=${
            (srcTrack as any).moodAggressive?.toFixed(2) || "N/A"
          }`,
        );
        logger.debug(
          `  Genres: ${
            srcTrack.trackGenres.map((tg) => tg.genre.name).join(", ") || "N/A"
          }`,
        );
        logger.debug(
          `  Last.fm Tags: ${
            ((srcTrack as any).lastfmTags || []).join(", ") || "N/A"
          }`,
        );
        logger.debug(
          `  Mood Tags: ${
            ((srcTrack as any).moodTags || []).join(", ") || "N/A"
          }`,
        );
      }

      logger.debug("\n" + "-".repeat(100));
      logger.debug(
        `VIBE QUEUE - ${orderedTracks.length} tracks (showing up to 50, SORTED BY MATCH SCORE)`,
      );
      logger.debug("-".repeat(100));
      logger.debug(
        `${"#".padEnd(3)} | ${"TRACK".padEnd(35)} | ${"ARTIST".padEnd(
          20,
        )} | ${"BPM".padEnd(6)} | ${"ENG".padEnd(5)} | ${"VAL".padEnd(
          5,
        )} | ${"H".padEnd(4)} | ${"S".padEnd(4)} | ${"R".padEnd(
          4,
        )} | ${"A".padEnd(4)} | MODE    | GENRES`,
      );
      logger.debug("-".repeat(100));

      orderedTracks.slice(0, 50).forEach((track, i) => {
        const t = track as any;
        const title = track.title.substring(0, 33).padEnd(35);
        const artist = track.album.artist.name.substring(0, 18).padEnd(20);
        const bpm = track.bpm
          ? track.bpm.toFixed(0).padEnd(6)
          : "N/A".padEnd(6);
        const energy =
          track.energy !== null
            ? track.energy.toFixed(2).padEnd(5)
            : "N/A".padEnd(5);
        const valence =
          track.valence !== null
            ? track.valence.toFixed(2).padEnd(5)
            : "N/A".padEnd(5);
        const happy =
          t.moodHappy !== null
            ? t.moodHappy.toFixed(2).padEnd(4)
            : "N/A".padEnd(4);
        const sad =
          t.moodSad !== null ? t.moodSad.toFixed(2).padEnd(4) : "N/A".padEnd(4);
        const relaxed =
          t.moodRelaxed !== null
            ? t.moodRelaxed.toFixed(2).padEnd(4)
            : "N/A".padEnd(4);
        const aggressive =
          t.moodAggressive !== null
            ? t.moodAggressive.toFixed(2).padEnd(4)
            : "N/A".padEnd(4);
        const mode = (t.analysisMode || "std").substring(0, 7).padEnd(8);
        const genres = track.trackGenres
          .slice(0, 3)
          .map((tg) => tg.genre.name)
          .join(", ");

        logger.debug(
          `${String(i + 1).padEnd(
            3,
          )} | ${title} | ${artist} | ${bpm} | ${energy} | ${valence} | ${happy} | ${sad} | ${relaxed} | ${aggressive} | ${mode} | ${genres}`,
        );
      });

      if (orderedTracks.length > 50) {
        logger.debug(`... and ${orderedTracks.length - 50} more tracks`);
      }

      logger.debug("=".repeat(100) + "\n");
    }

    const transformedTracks = orderedTracks.map((track) => ({
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
      ...(vibeSourceFeatures && {
        audioFeatures: {
          bpm: track.bpm,
          energy: track.energy,
          valence: track.valence,
          arousal: track.arousal,
          danceability: track.danceability,
          keyScale: track.keyScale,
          instrumentalness: track.instrumentalness,
          analysisMode: track.analysisMode,
          moodHappy: track.moodHappy,
          moodSad: track.moodSad,
          moodRelaxed: track.moodRelaxed,
          moodAggressive: track.moodAggressive,
          moodParty: track.moodParty,
          moodAcoustic: track.moodAcoustic,
          moodElectronic: track.moodElectronic,
        },
      }),
    }));

    const finalTracks =
      type === "vibe" ? transformedTracks : shuffleArray(transformedTracks);

    const response: any = { tracks: finalTracks };
    if (vibeSourceFeatures) {
      response.sourceFeatures = vibeSourceFeatures;
    }

    res.json(response);
  } catch (error) {
    logger.error("Radio endpoint error:", error);
    res.status(500).json({ error: "Failed to get radio tracks" });
  }
});

export default router;
