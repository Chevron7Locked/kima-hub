import { Router } from "express";
import { requireAdmin } from "../../middleware/auth";
import { announcePlaylistsChanged, playlistsHoldingTracks } from "../../services/playlistEvents";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { deezerService } from "../../services/deezer";
import { lidarrService } from "../../services/lidarr";
import { safeError } from "../../utils/errors";
import { resolveWithinMusicRoot } from "./trackPath";
import { parseLimit } from "./paging";
import fs from "fs";
import pLimit from "p-limit";
import { toAudioFeaturesDTO } from "../../utils/audioFeatures";
import { LIBRARY_LOCATION } from "../../services/libraryFilters";

// Alphabetical sorts use `sortName` (article-stripped, unaccented,
// lowercased), written wherever a title or displayTitle is written.
const ALBUM_SORT_MAP: Record<string, any> = {
  name: { sortName: "asc" as const },
  "name-desc": { sortName: "desc" as const },
  recent: { year: "desc" as const },
};

const router = Router();

router.get("/albums", async (req, res) => {
  const start = Date.now();
  try {
    const {
      artistId,
      limit: limitParam = "500",
      offset: offsetParam = "0",
      filter = "owned",
      sortBy = "name",
    } = req.query;
    const limit = parseLimit(limitParam, 500);
    const offset = parseInt(offsetParam as string, 10) || 0;

    const orderBy = ALBUM_SORT_MAP[sortBy as string] ?? {
      sortName: "asc" as const,
    };

    let where: any = {
      tracks: { some: {} },
    };

    if (filter === "owned") {
      // Bounded so the query cannot fetch every row.
      const ownedAlbumMbids = await prisma.ownedAlbum.findMany({
        select: { rgMbid: true },
        take: 20000,
      });
      const ownedMbids = ownedAlbumMbids.map((oa) => oa.rgMbid);

      where.OR = [
        { location: LIBRARY_LOCATION, tracks: { some: {} } },
        { rgMbid: { in: ownedMbids }, tracks: { some: {} } },
      ];
    } else if (filter === "discovery") {
      where.location = "DISCOVER";
    }

    if (artistId) {
      if (where.OR) {
        where = {
          AND: [{ OR: where.OR }, { artistId: artistId as string }],
        };
      } else {
        where.artistId = artistId as string;
      }
    }

    const [albumsData, total] = await Promise.all([
      prisma.album.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: [orderBy, { id: "asc" }],
        include: {
          artist: {
            select: {
              id: true,
              mbid: true,
              name: true,
            },
          },
        },
      }),
      prisma.album.count({ where }),
    ]);

    const albums = albumsData.map((album) => ({
      ...album,
      coverArt: album.coverUrl,
    }));

    res.json({
      albums,
      total,
      offset,
      limit,
    });
  } catch (error) {
    safeError(res, "Get albums", error);
  } finally {
    const elapsed = Date.now() - start;
    logger.info(`GET /albums completed in ${elapsed}ms`);
  }
});

router.get("/albums/:id", async (req, res) => {
  try {
    const idParam = req.params.id;

    const album = await prisma.album.findFirst({
      where: {
        OR: [{ id: idParam }, { rgMbid: idParam }],
      },
      include: {
        artist: {
          select: {
            id: true,
            mbid: true,
            name: true,
          },
        },
        tracks: {
          orderBy: [
            { discNumber: { sort: Prisma.SortOrder.asc, nulls: "first" } },
            { trackNo: Prisma.SortOrder.asc },
          ],
        },
      },
    });

    if (!album) {
      return res.status(404).json({ error: "Album not found" });
    }

    const owned = await prisma.ownedAlbum.findUnique({
      where: {
        artistId_rgMbid: {
          artistId: album.artistId,
          rgMbid: album.rgMbid,
        },
      },
    });
    const isOwned = !!owned;

    const artistData = album.artist;

    let missingTracks: Array<{
      title: string;
      trackNumber: number | null;
      previewUrl: string | null;
    }> = [];

    if (album.rgMbid) {
      const lidarrMissingTracks = await lidarrService.getMissingTracksByAlbumMbid(
        album.rgMbid
      );

      if (lidarrMissingTracks.length > 0) {
        const previewLimit = pLimit(3);
        missingTracks = await Promise.all(
          lidarrMissingTracks.map((track) => previewLimit(async () => {
            let previewUrl: string | null = null;
            if (artistData?.name) {
              previewUrl = await deezerService.getTrackPreview(
                artistData.name,
                track.title
              );
            }
            return {
              title: track.title,
              trackNumber: track.trackNumber,
              previewUrl,
            };
          }))
        );
      }
    }

    res.json({
      ...album,
      tracks: album.tracks.map((t) => ({
        ...t,
        audioFeatures: toAudioFeaturesDTO(t),
      })),
      artist: artistData,
      owned: isOwned,
      coverArt: album.coverUrl,
      missingTracks,
    });
  } catch (error) {
    logger.error("Get album error:", error);
    res.status(500).json({ error: "Failed to fetch album" });
  }
});

router.delete("/albums/:id", requireAdmin, async (req, res) => {
  try {
    const album = await prisma.album.findUnique({
      where: { id: req.params.id },
      include: {
        artist: true,
        tracks: {
          include: {
            album: true,
          },
        },
      },
    });

    if (!album) {
      return res.status(404).json({ error: "Album not found" });
    }

    let deletedFiles = 0;
    for (const track of album.tracks) {
      if (track.filePath) {
        try {
          const absolutePath = resolveWithinMusicRoot(track.filePath);
          if (!absolutePath) {
            logger.warn(
              `[DELETE] Refused out-of-root track path for ${track.id}: ${track.filePath}`,
            );
            continue;
          }

          if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            deletedFiles++;
          }
        } catch (err) {
          logger.warn("[DELETE] Could not delete file:", err);
        }
      }
    }

    try {
      const artistName = album.artist.name;
      // artist.name and album.title are tag values, not paths the scanner
      // produced -- see resolveWithinMusicRoot for why they are resolved
      // rather than joined.
      const albumFolder = resolveWithinMusicRoot(artistName, album.title);

      if (!albumFolder) {
        logger.warn(
          `[DELETE] Refused out-of-root album folder for ${artistName}/${album.title}`,
        );
      } else if (fs.existsSync(albumFolder)) {
        const files = fs.readdirSync(albumFolder);
        if (files.length === 0) {
          fs.rmdirSync(albumFolder);
          logger.debug(`[DELETE] Deleted empty album folder: ${albumFolder}`);
        }
      }
    } catch (err) {
      logger.warn("[DELETE] Could not delete album folder:", err);
    }

    // Its songs' playlist entries go with it: tell those playlists once it is gone.
    const playlists = await playlistsHoldingTracks(prisma, { albumId: album.id });
    await prisma.album.delete({
      where: { id: album.id },
    });
    announcePlaylistsChanged(playlists);

    logger.debug(
      `[DELETE] Deleted album: ${album.title} (${deletedFiles} files)`,
    );

    res.json({
      message: "Album deleted successfully",
      deletedFiles,
    });
  } catch (error) {
    logger.error("Delete album error:", error);
    res.status(500).json({ error: "Failed to delete album" });
  }
});

export default router;
