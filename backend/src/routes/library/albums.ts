import { Router } from "express";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { deezerService } from "../../services/deezer";
import { lidarrService } from "../../services/lidarr";
import { safeError } from "../../utils/errors";
import { config } from "../../config";
import path from "path";
import fs from "fs";
import pLimit from "p-limit";

const ALBUM_SORT_MAP: Record<string, any> = {
  name: { title: "asc" as const },
  "name-desc": { title: "desc" as const },
  recent: { year: "desc" as const },
};

const MAX_LIMIT = 10000;

const router = Router();

router.get("/albums", async (req, res) => {
  try {
    const {
      artistId,
      limit: limitParam = "500",
      offset: offsetParam = "0",
      filter = "owned",
      sortBy = "name",
    } = req.query;
    const limit = Math.min(
      parseInt(limitParam as string, 10) || 500,
      MAX_LIMIT,
    );
    const offset = parseInt(offsetParam as string, 10) || 0;

    const orderBy = ALBUM_SORT_MAP[sortBy as string] ?? {
      title: "asc" as const,
    };

    let where: any = {
      tracks: { some: {} },
    };

    if (filter === "owned") {
      const ownedAlbumMbids = await prisma.ownedAlbum.findMany({
        select: { rgMbid: true },
      });
      const ownedMbids = ownedAlbumMbids.map((oa) => oa.rgMbid);

      where.OR = [
        { location: "LIBRARY", tracks: { some: {} } },
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
        orderBy,
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
          orderBy: { trackNo: Prisma.SortOrder.asc },
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

router.delete("/albums/:id", async (req, res) => {
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
          const absolutePath = path.join(
            config.music.musicPath,
            track.filePath,
          );

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
      const albumFolder = path.join(
        config.music.musicPath,
        artistName,
        album.title,
      );

      if (fs.existsSync(albumFolder)) {
        const files = fs.readdirSync(albumFolder);
        if (files.length === 0) {
          fs.rmdirSync(albumFolder);
          logger.debug(`[DELETE] Deleted empty album folder: ${albumFolder}`);
        }
      }
    } catch (err) {
      logger.warn("[DELETE] Could not delete album folder:", err);
    }

    await prisma.album.delete({
      where: { id: album.id },
    });

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
