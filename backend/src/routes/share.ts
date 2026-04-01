import { Router, Request, Response } from "express";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { randomBytes } from "crypto";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { getLocalImagePath, getResizedImagePath } from "../services/imageStorage";
import { getAudioStreamingService } from "../services/audioStreaming";
import { config } from "../config";

const router = Router();

const recentPlays = new Map<string, number>();
const PLAY_DEDUP_MS = 30_000;

setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of recentPlays) {
        if (now - ts > PLAY_DEDUP_MS * 2) recentPlays.delete(key);
    }
}, 60_000).unref();

const shareResolveLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
});

const shareStreamLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
});

function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".opus": "audio/opus",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".wma": "audio/x-ms-wma",
    };
    return mimeTypes[ext] || "application/octet-stream";
}

/**
 * POST /api/share - Create a share link (authenticated)
 */
router.post("/", requireAuth, async (req: Request, res: Response) => {
    try {
        const { entityType, entityId } = req.body;
        const userId = req.user!.id;

        if (!entityType || !entityId) {
            return res.status(400).json({ error: "entityType and entityId are required" });
        }

        if (!["playlist", "track", "album"].includes(entityType)) {
            return res.status(400).json({ error: "entityType must be playlist, track, or album" });
        }

        if (entityType === "playlist") {
            const playlist = await prisma.playlist.findUnique({ where: { id: entityId } });
            if (!playlist) return res.status(404).json({ error: "Playlist not found" });
            if (playlist.userId !== userId) return res.status(403).json({ error: "Not the playlist owner" });
        } else if (entityType === "track") {
            const track = await prisma.track.findUnique({ where: { id: entityId } });
            if (!track) return res.status(404).json({ error: "Track not found" });
        } else if (entityType === "album") {
            const album = await prisma.album.findUnique({ where: { id: entityId } });
            if (!album) return res.status(404).json({ error: "Album not found" });
        }

        const createShareLink = () => prisma.$transaction(async (tx) => {
            const existing = await tx.shareLink.findFirst({
                where: {
                    entityType,
                    entityId,
                    createdBy: userId,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } },
                    ],
                },
            });

            if (existing) {
                return { token: existing.token, url: `/share/${existing.token}`, existing: true };
            }

            const userLinkCount = await tx.shareLink.count({
                where: {
                    createdBy: userId,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } },
                    ],
                },
            });
            if (userLinkCount >= 500) {
                throw new Error("SHARE_LIMIT_REACHED");
            }

            const shareLink = await tx.shareLink.create({
                data: {
                    token: randomBytes(24).toString("base64url"),
                    entityType,
                    entityId,
                    createdBy: userId,
                },
            });

            return { token: shareLink.token, url: `/share/${shareLink.token}` };
        }, { isolationLevel: "Serializable" });

        let result;
        try {
            result = await createShareLink();
        } catch (retryError: any) {
            if (retryError.code === "P2034") {
                result = await createShareLink();
            } else {
                throw retryError;
            }
        }

        res.json(result);
    } catch (error: any) {
        if (error.message === "SHARE_LIMIT_REACHED") {
            return res.status(429).json({ error: "Share link limit reached (max 500)" });
        }
        logger.error(`[Share] Failed to create share link: ${error.message}`);
        res.status(500).json({ error: "Failed to create share link" });
    }
});

/**
 * GET /api/share/:token - Resolve a share link (public, no auth)
 */
router.get("/:token", shareResolveLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await prisma.shareLink.findUnique({
            where: { token: req.params.token },
        });

        if (!shareLink) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
            return res.status(410).json({ error: "Share link has expired" });
        }

        if (shareLink.maxPlays && shareLink.playCount >= shareLink.maxPlays) {
            return res.status(410).json({ error: "Share link play limit reached" });
        }

        let entity: any = null;

        if (shareLink.entityType === "playlist") {
            entity = await prisma.playlist.findUnique({
                where: { id: shareLink.entityId },
                include: {
                    items: {
                        include: {
                            track: {
                                include: {
                                    album: {
                                        include: {
                                            artist: {
                                                select: { id: true, name: true },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                        orderBy: { sort: "asc" },
                    },
                    user: { select: { username: true } },
                },
            });
        } else if (shareLink.entityType === "track") {
            entity = await prisma.track.findUnique({
                where: { id: shareLink.entityId },
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true } },
                        },
                    },
                },
            });
        } else if (shareLink.entityType === "album") {
            entity = await prisma.album.findUnique({
                where: { id: shareLink.entityId },
                include: {
                    artist: { select: { id: true, name: true } },
                    tracks: {
                        orderBy: [
                            { discNumber: "asc" },
                            { trackNo: "asc" },
                        ],
                        select: {
                            id: true,
                            title: true,
                            trackNo: true,
                            discNumber: true,
                            discSubtitle: true,
                            duration: true,
                        },
                    },
                },
            });
        }

        if (!entity) {
            return res.status(404).json({ error: "Shared content no longer exists" });
        }

        res.json({
            entityType: shareLink.entityType,
            entity,
            createdAt: shareLink.createdAt,
        });
    } catch (error: any) {
        logger.error(`[Share] Failed to resolve share link: ${error.message}`);
        res.status(500).json({ error: "Failed to load shared content" });
    }
});

/**
 * GET /api/share/:token/cover-art/:coverArtId - Serve cover art via share token (public)
 */
router.get("/:token/cover-art/:coverArtId", shareResolveLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await prisma.shareLink.findUnique({
            where: { token: req.params.token },
        });

        if (!shareLink) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
            return res.status(410).json({ error: "Share link has expired" });
        }

        if (shareLink.maxPlays && shareLink.playCount >= shareLink.maxPlays) {
            return res.status(410).json({ error: "Share link play limit reached" });
        }

        const coverArtId = decodeURIComponent(req.params.coverArtId);
        const size = req.query.size as string | undefined;

        if (!coverArtId.startsWith("native:")) {
            return res.status(404).json({ error: "Cover art not found" });
        }

        const localPath = getLocalImagePath(coverArtId);
        if (!localPath) {
            return res.status(404).json({ error: "Cover art not found" });
        }

        const width = size ? parseInt(size, 10) : 0;
        if (width >= 16 && width <= 2048) {
            const resizedPath = getResizedImagePath(coverArtId, width);
            if (resizedPath) {
                try {
                    await fs.promises.access(resizedPath, fs.constants.R_OK);
                    res.setHeader("Content-Type", "image/jpeg");
                    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
                    return res.sendFile(resizedPath);
                } catch {}
            }
        }

        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.sendFile(localPath);
    } catch (error: any) {
        logger.error(`[Share] Cover art error: ${error.message}`);
        res.status(500).json({ error: "Failed to serve cover art" });
    }
});

/**
 * GET /api/share/:token/stream/:trackId - Stream audio via share token (public, no auth)
 */
router.get("/:token/stream/:trackId", shareStreamLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await prisma.shareLink.findUnique({
            where: { token: req.params.token },
        });

        if (!shareLink) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
            return res.status(410).json({ error: "Share link has expired" });
        }

        if (shareLink.maxPlays && shareLink.playCount >= shareLink.maxPlays) {
            return res.status(410).json({ error: "Share link play limit reached" });
        }

        const trackId = req.params.trackId;
        let authorized = false;

        if (shareLink.entityType === "track" && shareLink.entityId === trackId) {
            authorized = true;
        } else if (shareLink.entityType === "playlist") {
            const item = await prisma.playlistItem.findFirst({
                where: { playlistId: shareLink.entityId, trackId },
            });
            authorized = !!item;
        } else if (shareLink.entityType === "album") {
            const track = await prisma.track.findFirst({
                where: { id: trackId, albumId: shareLink.entityId },
            });
            authorized = !!track;
        }

        if (!authorized) {
            return res.status(403).json({ error: "Track not in shared content" });
        }

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: { filePath: true },
        });

        if (!track?.filePath) {
            return res.status(404).json({ error: "Track file not found" });
        }

        const musicPath = config.music.musicPath;
        const resolvedMusicPath = path.resolve(musicPath);
        const fullPath = path.resolve(resolvedMusicPath, track.filePath);

        if (!fullPath.startsWith(resolvedMusicPath + path.sep)) {
            return res.status(403).json({ error: "Access denied" });
        }

        try {
            await fs.promises.access(fullPath, fs.constants.R_OK);
        } catch {
            return res.status(404).json({ error: "Audio file not found" });
        }

        // Deduplicate play count: only increment once per share+track within time window
        const playKey = `${shareLink.id}:${trackId}`;
        const lastPlay = recentPlays.get(playKey);
        const now = Date.now();

        if (!lastPlay || now - lastPlay > PLAY_DEDUP_MS) {
            recentPlays.set(playKey, now);

            if (shareLink.maxPlays) {
                // Atomic check-and-increment: only succeeds if under the limit
                const updated = await prisma.$executeRaw`
                    UPDATE "share_links"
                    SET "playCount" = "playCount" + 1
                    WHERE "id" = ${shareLink.id}
                      AND ("maxPlays" IS NULL OR "playCount" < "maxPlays")
                `;
                if (updated === 0) {
                    recentPlays.delete(playKey);
                    return res.status(410).json({ error: "Share link play limit reached" });
                }
            } else {
                await prisma.shareLink.update({
                    where: { id: shareLink.id },
                    data: { playCount: { increment: 1 } },
                });
            }
        }

        const mimeType = getMimeType(track.filePath);
        const streamingService = getAudioStreamingService(
            config.music.musicPath,
            config.music.transcodeCachePath,
            config.music.transcodeCacheMaxGb,
        );
        await streamingService.streamFileWithRangeSupport(req, res, fullPath, mimeType);
    } catch (error: any) {
        logger.error(`[Share] Stream error: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream audio" });
        }
    }
});

/**
 * DELETE /api/share/:token - Revoke a share link (authenticated, owner only)
 */
router.delete("/:token", requireAuth, async (req: Request, res: Response) => {
    try {
        const shareLink = await prisma.shareLink.findUnique({
            where: { token: req.params.token },
        });

        if (!shareLink) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (shareLink.createdBy !== req.user!.id) {
            return res.status(403).json({ error: "Not the link owner" });
        }

        await prisma.shareLink.delete({ where: { id: shareLink.id } });

        res.json({ message: "Share link revoked" });
    } catch (error: any) {
        logger.error(`[Share] Failed to revoke share link: ${error.message}`);
        res.status(500).json({ error: "Failed to revoke share link" });
    }
});

export default router;
