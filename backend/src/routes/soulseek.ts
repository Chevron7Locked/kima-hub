import { logger } from "../utils/logger";
import { safeError } from "../utils/errors";

/** Soulseek routes: UI searches and track downloads over the vendored soulseek-ts connection. */

import { Router } from "express";
import { requireAuth, requireAdmin, requireAcquirePermission } from "../middleware/auth";
import { soulseekService } from "../services/soulseek";
import { getSystemSettings } from "../utils/systemSettings";
import { randomUUID } from "crypto";
import { eventBus } from "../services/eventBus";
import { prisma } from "../utils/db";
import fs from "fs";
import path from "path";
import type { FileSearchResponse } from "../lib/soulseek/messages/from/peer";
import { FileAttribute } from "../lib/soulseek/messages/common";

const router = Router();

interface SearchSession {
    query: string;
    results: FormattedSearchResult[];
    createdAt: Date;
    userId: string;
}

const searchSessions = new Map<string, SearchSession>();
const SEARCH_SESSION_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_SEARCH_SESSIONS = 50;

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

type FormattedSearchResult = ReturnType<typeof formatSearchResult>[number];

setInterval(() => {
    const now = Date.now();
    for (const [searchId, session] of searchSessions.entries()) {
        if (now - session.createdAt.getTime() > SEARCH_SESSION_TTL) {
            searchSessions.delete(searchId);
        }
    }
}, 60_000).unref();

async function requireSoulseekConfigured(_req: any, res: any, next: any) {
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
router.get("/status", requireAuth, async (_req, res) => {
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
    } catch (error) {
        safeError(res, "Soulseek status", error);
    }
});

/**
 * POST /soulseek/connect
 * Connects the server's one Soulseek connection, shared by every listener, so admins only.
 */
router.post(
    "/connect",
    requireAuth,
    requireAdmin,
    requireSoulseekConfigured,
    async (_req, res) => {
        try {
            await soulseekService.connect();

            res.json({
                success: true,
                message: "Connected to Soulseek network",
            });
        } catch (error) {
            safeError(res, "Soulseek connect", error);
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

            // Either a free-text query or an artist and title
            let searchQuery: string;

            if (query) {
                searchQuery = query;
            } else if (artist && title) {
                searchQuery = `${artist} ${title}`;
            } else {
                return res.status(400).json({
                    error: "Either 'query' or both 'artist' and 'title' are required",
                });
            }

            logger.debug(
                `[Soulseek] Starting general search: "${searchQuery}"`,
            );

            if (searchSessions.size >= MAX_SEARCH_SESSIONS) {
                let oldestId: string | null = null;
                let oldestTime = Infinity;
                for (const [id, session] of searchSessions.entries()) {
                    if (session.createdAt.getTime() < oldestTime) {
                        oldestTime = session.createdAt.getTime();
                        oldestId = id;
                    }
                }
                if (oldestId) searchSessions.delete(oldestId);
            }

            const userId = req.user!.id;

            const searchId = randomUUID();
            searchSessions.set(searchId, {
                query: searchQuery,
                results: [],
                createdAt: new Date(),
                userId,
            });

            let streamedCount = 0;
            const MAX_STREAMED_RESULTS = 200;
            let searchAborted = false;

            // 10 s is enough for 200+ results and keeps the UI quick
            soulseekService
                .searchTrack(searchQuery, "", undefined, false, 10000, (response) => {
                    if (searchAborted || streamedCount >= MAX_STREAMED_RESULTS) {
                        searchAborted = true;
                        return;
                    }

                    const formatted = formatSearchResult(response);

                    // Filter for decent quality results (FLAC or 128kbps+ MP3, allow unknown bitrate)
                    const highQuality = formatted.filter(r =>
                        r.format === "flac" || r.bitrate === 0 || r.bitrate >= 128
                    );

                    if (highQuality.length > 0 && userId) {
                        const toSend = highQuality.slice(0, MAX_STREAMED_RESULTS - streamedCount);
                        streamedCount += toSend.length;

                        eventBus.emit({
                            type: "search:result",
                            userId,
                            payload: { searchId, results: toSend },
                        });
                    }

                    // Also accumulate in session for GET fallback (all results, not filtered)
                    const session = searchSessions.get(searchId);
                    if (session) {
                        session.results.push(...formatted);
                    }
                })
                .then((result) => {
                    try {
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
                    } catch (emitErr: any) {
                        logger.error(`[Soulseek] Search ${searchId} post-completion error: ${emitErr.message}`);
                    }
                })
                .catch((err) => {
                    try {
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
                    } catch (emitErr: any) {
                        logger.error(`[Soulseek] Search ${searchId} failed (${err.message}) and emit also failed: ${emitErr.message}`);
                    }
                });

            res.json({
                searchId,
                message: "Search started",
            });
        } catch (error) {
            safeError(res, "Soulseek search", error);
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
        const userId = req.user!.id;

        if (!session || session.userId !== userId) {
            return res.status(404).json({
                error: "Search not found or expired",
                results: [],
                count: 0,
            });
        }

        res.json({
            results: session.results,
            count: session.results.length,
        });
    } catch (error) {
        safeError(res, "Get search results", error);
    }
});

/**
 * POST /soulseek/download
 * Download a specific file from a specific user
 */
router.post(
    "/download",
    requireAuth,
    requireAcquirePermission,
    requireSoulseekConfigured,
    async (req, res) => {
        let jobId: string | null = null;
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
                str.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
                   .replace(/\.\./g, "_")  // Block parent directory traversal
                   .replace(/^\.+/, "");    // Block hidden files
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

            const userId = req.user!.id;
            const subject = `${resolvedArtist} - ${resolvedTitle}`;

            // Create a DownloadJob so the activity tracker shows this download in progress
            const job = await prisma.downloadJob.create({
                data: {
                    userId,
                    subject,
                    type: "soulseek-search",
                    targetMbid: null,
                    status: "processing",
                    startedAt: new Date(),
                },
            });
            jobId = job.id;

            const result = await soulseekService.downloadTrack(match, destPath);

            if (result.success) {
                try {
                    await fs.promises.access(destPath);
                } catch {
                    logger.error(`[Soulseek] Download reported success but file missing: ${destPath}`);
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: { status: "failed", error: "File not written to disk", completedAt: new Date() },
                    });
                    return res.status(500).json({ success: false, error: "Download failed: file not written to disk" });
                }

                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: { status: "completed", completedAt: new Date() },
                });

                eventBus.emit({
                    type: "download:complete",
                    userId,
                    payload: {
                        jobId: job.id,
                        subject,
                    },
                });

                // Trigger library scan to import the new file (keyed on
                // this download job; a repeat click finds it queued/running)
                try {
                    const { requestScan } = await import("../workers/scanRequest");
                    await requestScan({
                        userId,
                        source: "soulseek-manual-download",
                        downloadId: job.id,
                    });
                    logger.debug(`[Soulseek] Library scan queued for: ${resolvedArtist} - ${resolvedTitle}`);
                } catch (scanError: any) {
                    logger.warn(`[Soulseek] Failed to queue library scan: ${scanError.message}`);
                }

                res.json({
                    success: true,
                    filePath: destPath,
                    message: "Download complete, scanning library...",
                });
            } else {
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: { status: "failed", error: result.error || "Download failed", completedAt: new Date() },
                });
                res.status(500).json({
                    success: false,
                    error: result.error || "Download failed",
                });
            }
        } catch (error) {
            if (jobId) {
                await prisma.downloadJob.update({
                    where: { id: jobId },
                    data: { status: "failed", error: error instanceof Error ? error.message : "Download failed", completedAt: new Date() },
                }).catch(() => {});
            }
            safeError(res, "Soulseek download", error);
        }
    },
);



/**
 * POST /soulseek/disconnect
 * Drops the server's one Soulseek connection, for every listener, so admins only.
 */
router.post("/disconnect", requireAuth, requireAdmin, async (_req, res) => {
    try {
        soulseekService.disconnect();
        res.json({ success: true, message: "Disconnected" });
    } catch (error) {
        safeError(res, "Soulseek disconnect", error);
    }
});

export default router;
