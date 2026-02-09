import { logger } from "../utils/logger";

/**
 * Soulseek routes - Direct connection via vendored soulseek-ts
 * Supports both general searches (for UI) and track-specific searches (for downloads)
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { soulseekService, SearchResult } from "../services/soulseek";
import { getSystemSettings } from "../utils/systemSettings";
import { randomUUID } from "crypto";
import { eventBus } from "../services/eventBus";
import path from "path";
import type { FileSearchResponse } from "../lib/soulseek/messages/from/peer";
import { FileAttribute } from "../lib/soulseek/messages/common";

const router = Router();

// In-memory store for search results (with TTL cleanup)
interface SearchSession {
    query: string;
    results: SearchResult[];
    createdAt: Date;
}

const searchSessions = new Map<string, SearchSession>();
const SEARCH_SESSION_TTL = 5 * 60 * 1000; // 5 minutes

function formatSearchResult(response: FileSearchResponse) {
    return response.files.map((file) => {
        const fullPath = file.filename;
        const filename = fullPath.split(/[/\\]/).pop() || fullPath;
        const format = filename.toLowerCase().endsWith(".flac") ? "flac" : "mp3";
        const pathParts = fullPath.split(/[/\\]/);
        const parsedArtist = pathParts.length > 2 ? pathParts[pathParts.length - 3] : undefined;
        const parsedAlbum = pathParts.length > 1 ? pathParts[pathParts.length - 2] : undefined;
        const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
        const parsedTitle = nameWithoutExt.replace(/^\d+[\s.\-_]*/, "").replace(/^\s*-\s*/, "").trim() || undefined;

        return {
            username: response.username,
            path: fullPath,
            filename,
            size: Number(file.size),
            bitrate: file.attrs.get(FileAttribute.Bitrate) || 0,
            format,
            parsedArtist,
            parsedAlbum,
            parsedTitle,
        };
    });
}

// Cleanup old search sessions every minute
setInterval(() => {
    const now = Date.now();
    for (const [searchId, session] of searchSessions.entries()) {
        if (now - session.createdAt.getTime() > SEARCH_SESSION_TTL) {
            searchSessions.delete(searchId);
        }
    }
}, 60000);

// Middleware to check if Soulseek credentials are configured
async function requireSoulseekConfigured(req: any, res: any, next: any) {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.status(403).json({
                error: "Soulseek credentials not configured. Add username/password in System Settings.",
            });
        }

        next();
    } catch (error) {
        logger.error("Error checking Soulseek settings:", error);
        res.status(500).json({ error: "Failed to check settings" });
    }
}

/**
 * GET /soulseek/status
 * Check connection status
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.json({
                enabled: false,
                connected: false,
                message: "Soulseek credentials not configured",
            });
        }

        const status = await soulseekService.getStatus();

        res.json({
            enabled: true,
            connected: status.connected,
            username: status.username,
        });
    } catch (error: any) {
        logger.error("Soulseek status error:", error.message);
        res.status(500).json({
            error: "Failed to get Soulseek status",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/connect
 * Manually trigger connection to Soulseek network
 */
router.post(
    "/connect",
    requireAuth,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            await soulseekService.connect();

            res.json({
                success: true,
                message: "Connected to Soulseek network",
            });
        } catch (error: any) {
            logger.error("Soulseek connect error:", error.message);
            res.status(500).json({
                error: "Failed to connect to Soulseek",
                details: error.message,
            });
        }
    },
);

/**
 * POST /soulseek/search
 * General search - supports both freeform queries and track-specific searches
 * Returns a searchId for polling results (async pattern)
 */
router.post(
    "/search",
    requireAuth,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            const { query, artist, title } = req.body;

            // Support both query formats for backward compatibility
            let searchQuery: string;

            if (query) {
                // General search (from UI search bar)
                searchQuery = query;
            } else if (artist && title) {
                // Track-specific search (for downloads)
                searchQuery = `${artist} ${title}`;
            } else {
                return res.status(400).json({
                    error: "Either 'query' or both 'artist' and 'title' are required",
                });
            }

            logger.debug(
                `[Soulseek] Starting general search: "${searchQuery}"`,
            );

            // Create search session
            const searchId = randomUUID();
            searchSessions.set(searchId, {
                query: searchQuery,
                results: [],
                createdAt: new Date(),
            });

            // Extract userId for SSE targeting
            const userId = (req as any).user?.id;

            // Start async search with onResult callback for SSE streaming
            soulseekService
                .searchTrack(searchQuery, "", false, 45000, (response) => {
                    // Stream each peer response via SSE
                    const formatted = formatSearchResult(response);
                    if (formatted.length > 0 && userId) {
                        eventBus.emit({
                            type: "search:result",
                            userId,
                            payload: { searchId, results: formatted },
                        });
                    }
                    // Also accumulate in session for GET fallback
                    const session = searchSessions.get(searchId);
                    if (session) {
                        session.results.push(...formatted.map((r) => ({
                            user: r.username,
                            file: r.path,
                            size: r.size,
                            slots: true,
                            bitrate: r.bitrate,
                            speed: 0,
                        })));
                    }
                })
                .then((result) => {
                    if (userId) {
                        eventBus.emit({
                            type: "search:complete",
                            userId,
                            payload: { searchId, found: result.found, matchCount: result.allMatches.length },
                        });
                    }
                    logger.debug(
                        `[Soulseek] Search ${searchId} completed: ${result.allMatches.length} matches`,
                    );
                })
                .catch((err) => {
                    if (userId) {
                        eventBus.emit({
                            type: "search:complete",
                            userId,
                            payload: { searchId, found: false, matchCount: 0, error: err.message },
                        });
                    }
                    logger.error(
                        `[Soulseek] Search ${searchId} failed:`,
                        err.message,
                    );
                });

            res.json({
                searchId,
                message: "Search started",
            });
        } catch (error: any) {
            logger.error("Soulseek search error:", error.message);
            res.status(500).json({
                error: "Search failed",
                details: error.message,
            });
        }
    },
);

/**
 * GET /soulseek/search/:searchId
 * Get results for an ongoing search
 */
router.get("/search/:searchId", requireAuth, async (req, res) => {
    try {
        const { searchId } = req.params;
        const session = searchSessions.get(searchId);

        if (!session) {
            return res.status(404).json({
                error: "Search not found or expired",
                results: [],
                count: 0,
            });
        }

        // Format results for frontend (reuse accumulated results from SSE callbacks)
        const formattedResults = session.results.map((r) => {
            const filename = r.file.split(/[/\\]/).pop() || r.file;
            const format = filename.toLowerCase().endsWith(".flac") ? "flac" : "mp3";
            const pathParts = r.file.split(/[/\\]/);
            const parsedArtist = pathParts.length > 2 ? pathParts[pathParts.length - 3] : undefined;
            const parsedAlbum = pathParts.length > 1 ? pathParts[pathParts.length - 2] : undefined;
            const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
            const parsedTitle = nameWithoutExt.replace(/^\d+[\s.\-_]*/, "").replace(/^\s*-\s*/, "").trim() || undefined;

            return {
                username: r.user,
                path: r.file,
                filename,
                size: r.size,
                bitrate: r.bitrate || 0,
                format,
                parsedArtist,
                parsedAlbum,
                parsedTitle,
            };
        });

        res.json({
            results: formattedResults,
            count: formattedResults.length,
        });
    } catch (error: any) {
        logger.error("Get search results error:", error.message);
        res.status(500).json({
            error: "Failed to get results",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/download
 * Download a specific file from a specific user
 */
router.post(
    "/download",
    requireAuth,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            const { username, filepath, artist, title, album, filename } = req.body;

            if (!username || !filepath) {
                return res.status(400).json({
                    error: "username and filepath are required",
                });
            }

            // Derive artist/title from filename if not provided
            let resolvedArtist = artist;
            let resolvedTitle = title;

            if (!resolvedArtist || !resolvedTitle) {
                // Try to extract from filename (strip extension and track number)
                const name = (filename || filepath.split(/[/\\]/).pop() || "")
                    .replace(/\.[^.]+$/, "")
                    .replace(/^\d+[\s.\-_]*/, "")
                    .trim();

                if (!resolvedTitle) resolvedTitle = name || "Unknown";
                if (!resolvedArtist) resolvedArtist = "Unknown";
                logger.warn(`[Soulseek] Derived artist/title from filename: "${resolvedArtist}" - "${resolvedTitle}"`);
            }

            const settings = await getSystemSettings();
            const musicPath = settings?.musicPath;

            if (!musicPath) {
                return res.status(400).json({
                    error: "Music path not configured",
                });
            }

            // Build destination path: musicPath/artist/album/filename
            const sanitize = (str: string) =>
                str.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
            const destPath = path.join(
                musicPath,
                sanitize(resolvedArtist),
                sanitize(album || "Unknown Album"),
                sanitize(filename || filepath.split(/[/\\]/).pop() || "track.mp3"),
            );

            logger.debug(`[Soulseek] Downloading from ${username}: ${filepath} -> ${destPath}`);

            const match = {
                username,
                fullPath: filepath,
                filename: filename || filepath.split(/[/\\]/).pop() || "track.mp3",
                size: 0,
                quality: "unknown",
                score: 0,
            };

            const result = await soulseekService.downloadTrack(match, destPath);

            if (result.success) {
                // Trigger library scan to import the new file
                try {
                    const { scanQueue } = await import("../workers/queues");
                    await scanQueue.add("scan", {
                        userId: (req as any).user?.id || null,
                        source: "soulseek-manual-download",
                        artistName: resolvedArtist,
                    });
                    logger.debug(`[Soulseek] Library scan queued for: ${resolvedArtist} - ${resolvedTitle}`);
                } catch (scanError: any) {
                    logger.warn(`[Soulseek] Failed to queue library scan: ${scanError.message}`);
                    // Don't fail the request if scan queueing fails
                }

                res.json({
                    success: true,
                    filePath: destPath,
                    message: "Download complete, scanning library...",
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: result.error || "Download failed",
                });
            }
        } catch (error: any) {
            logger.error("Soulseek download error:", error.message);
            res.status(500).json({
                error: "Download failed",
                details: error.message,
            });
        }
    },
);

/**
 * POST /soulseek/disconnect
 * Disconnect from Soulseek network
 */
router.post("/disconnect", requireAuth, async (req, res) => {
    try {
        soulseekService.disconnect();
        res.json({ success: true, message: "Disconnected" });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
