import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";

const router = Router();

router.use(requireAuth);

const downloadAlbumSchema = z.object({
    quality: z.enum(["original", "high", "medium", "low"]).optional(),
});

// POST /offline/albums/:id/download
router.post("/albums/:id/download", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const albumId = req.params.id;
        const { quality } = downloadAlbumSchema.parse(req.body);

        // Get user's default quality if not specified
        let selectedQuality: "original" | "high" | "medium" | "low" = quality || "medium";
        if (!quality) {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
            });
            selectedQuality = (settings?.playbackQuality as "original" | "high" | "medium" | "low") || "medium";
        }

        // Get album with tracks
        const album = await prisma.album.findUnique({
            where: { id: albumId },
            include: {
                tracks: {
                    orderBy: { trackNo: "asc" },
                },
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        if (!album) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Calculate total size estimate
        const avgSizeMb: Record<string, number> = {
            original: 30, // FLAC
            high: 10, // MP3 320
            medium: 6, // MP3 192
            low: 4, // MP3 128
        };

        const estimatedSizeMb =
            album.tracks.length * avgSizeMb[selectedQuality];

        // Check user's cache limit
        const settings = await prisma.userSettings.findUnique({
            where: { userId },
        });

        if (settings) {
            const currentCacheSize = await prisma.cachedTrack.aggregate({
                where: { userId },
                _sum: { fileSizeMb: true },
            });

            const currentSize = currentCacheSize._sum.fileSizeMb || 0;

            if (currentSize + estimatedSizeMb > settings.maxCacheSizeMb) {
                return res.status(400).json({
                    error: "Cache size limit exceeded",
                    currentSize,
                    maxSize: settings.maxCacheSizeMb,
                    needed: estimatedSizeMb,
                });
            }
        }

        // Create download job (tracks to be downloaded by mobile client)
        const downloadJob = {
            albumId: album.id,
            albumTitle: album.title,
            artistName: album.artist.name,
            quality: selectedQuality,
            tracks: album.tracks.map((track) => ({
                trackId: track.id,
                title: track.title,
                trackNo: track.trackNo,
                duration: track.duration,
                streamUrl: `/library/tracks/${track.id}/stream?quality=${selectedQuality}`,
            })),
            estimatedSizeMb,
        };

        res.json(downloadJob);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Create download job error:", error);
        res.status(500).json({ error: "Failed to create download job" });
    }
});

// POST /offline/tracks/:id/complete (called by mobile after download)
router.post("/tracks/:id/complete", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const trackId = req.params.id;
        const { localPath, quality, fileSizeMb } = req.body;

        if (!localPath || !quality || !fileSizeMb) {
            return res
                .status(400)
                .json({ error: "localPath, quality, and fileSizeMb required" });
        }

        const cachedTrack = await prisma.cachedTrack.upsert({
            where: {
                userId_trackId_quality: {
                    userId,
                    trackId,
                    quality,
                },
            },
            create: {
                userId,
                trackId,
                localPath,
                quality,
                fileSizeMb: parseFloat(fileSizeMb),
            },
            update: {
                localPath,
                fileSizeMb: parseFloat(fileSizeMb),
                lastAccessedAt: new Date(),
            },
        });

        res.json(cachedTrack);
    } catch (error) {
        logger.error("Complete track download error:", error);
        res.status(500).json({ error: "Failed to complete download" });
    }
});

// GET /offline/albums
router.get("/albums", async (req, res) => {
    try {
        const userId = req.session.userId!;

        // Get all cached tracks grouped by album
        const cachedTracks = await prisma.cachedTrack.findMany({
            where: { userId },
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        // Group by album
        const albumsMap = new Map();

        for (const cached of cachedTracks) {
            const albumId = cached.track.album.id;

            if (!albumsMap.has(albumId)) {
                albumsMap.set(albumId, {
                    album: cached.track.album,
                    tracks: [],
                    totalSizeMb: 0,
                });
            }

            const albumData = albumsMap.get(albumId);
            albumData.tracks.push({
                ...cached.track,
                cachedPath: cached.localPath,
                cachedQuality: cached.quality,
                cachedSizeMb: cached.fileSizeMb,
            });
            albumData.totalSizeMb += cached.fileSizeMb;
        }

        const albums = Array.from(albumsMap.values()).map((data) => ({
            ...data.album,
            cachedTracks: data.tracks,
            totalSizeMb: data.totalSizeMb,
        }));

        res.json(albums);
    } catch (error) {
        logger.error("Get cached albums error:", error);
        res.status(500).json({ error: "Failed to get cached albums" });
    }
});

// DELETE /offline/albums/:id
router.delete("/albums/:id", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const albumId = req.params.id;

        // Get all cached tracks for this album
        const cachedTracks = await prisma.cachedTrack.findMany({
            where: {
                userId,
                track: {
                    albumId,
                },
            },
        });

        // Delete all cached tracks for this album
        await prisma.cachedTrack.deleteMany({
            where: {
                userId,
                track: {
                    albumId,
                },
            },
        });

        res.json({
            message: "Album removed from cache",
            deletedCount: cachedTracks.length,
        });
    } catch (error) {
        logger.error("Delete cached album error:", error);
        res.status(500).json({ error: "Failed to delete cached album" });
    }
});

// GET /offline/stats
router.get("/stats", async (req, res) => {
    try {
        const userId = req.session.userId!;

        const [settings, cacheStats] = await Promise.all([
            prisma.userSettings.findUnique({
                where: { userId },
            }),
            prisma.cachedTrack.aggregate({
                where: { userId },
                _sum: { fileSizeMb: true },
                _count: true,
            }),
        ]);

        const usedMb = cacheStats._sum.fileSizeMb || 0;
        const maxMb = settings?.maxCacheSizeMb || 5120;
        const trackCount = cacheStats._count || 0;

        res.json({
            usedMb,
            maxMb,
            availableMb: maxMb - usedMb,
            percentUsed: (usedMb / maxMb) * 100,
            trackCount,
        });
    } catch (error) {
        logger.error("Get cache stats error:", error);
        res.status(500).json({ error: "Failed to get cache stats" });
    }
});

export default router;
