import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { config } from "../config";
import { lidarrService } from "../services/lidarr";
import { musicBrainzService } from "../services/musicbrainz";
import { lastFmService } from "../services/lastfm";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import crypto from "crypto";

const router = Router();

router.use(requireAuthOrToken);

/**
 * Verify and potentially correct artist name before download
 * Uses multiple sources for canonical name resolution:
 * 1. MusicBrainz (if MBID provided) - most authoritative
 * 2. LastFM correction API - handles aliases and misspellings
 * 3. Original name - fallback
 *
 * @returns Object with verified name and whether correction was applied
 */
async function verifyArtistName(
    artistName: string,
    artistMbid?: string
): Promise<{
    verifiedName: string;
    wasCorrected: boolean;
    source: "musicbrainz" | "lastfm" | "original";
    originalName: string;
}> {
    const originalName = artistName;

    // Strategy 1: If we have MBID, use MusicBrainz as authoritative source
    if (artistMbid) {
        try {
            const mbArtist = await musicBrainzService.getArtist(artistMbid);
            if (mbArtist?.name) {
                return {
                    verifiedName: mbArtist.name,
                    wasCorrected:
                        mbArtist.name.toLowerCase() !==
                        artistName.toLowerCase(),
                    source: "musicbrainz",
                    originalName,
                };
            }
        } catch (error) {
            logger.warn(
                `MusicBrainz lookup failed for MBID ${artistMbid}:`,
                error
            );
        }
    }

    // Strategy 2: Use LastFM correction API
    try {
        const correction = await lastFmService.getArtistCorrection(artistName);
        if (correction?.corrected) {
            logger.debug(
                `[VERIFY] LastFM correction: "${artistName}" → "${correction.canonicalName}"`
            );
            return {
                verifiedName: correction.canonicalName,
                wasCorrected: true,
                source: "lastfm",
                originalName,
            };
        }
    } catch (error) {
        logger.warn(
            `LastFM correction lookup failed for "${artistName}":`,
            error
        );
    }

    // Strategy 3: Return original name
    return {
        verifiedName: artistName,
        wasCorrected: false,
        source: "original",
        originalName,
    };
}

// POST /downloads - Create download job
router.post("/", async (req, res) => {
    try {
        const {
            type,
            mbid,
            subject,
            artistName,
            albumTitle,
            downloadType = "library",
        } = req.body;
        const userId = req.user!.id;

        if (!type || !mbid || !subject) {
            return res.status(400).json({
                error: "Missing required fields: type, mbid, subject",
            });
        }

        if (type !== "artist" && type !== "album") {
            return res
                .status(400)
                .json({ error: "Type must be 'artist' or 'album'" });
        }

        if (downloadType !== "library" && downloadType !== "discovery") {
            return res.status(400).json({
                error: "downloadType must be 'library' or 'discovery'",
            });
        }

        // Check if Lidarr is enabled (database or .env)
        const lidarrEnabled = await lidarrService.isEnabled();
        if (!lidarrEnabled) {
            return res.status(400).json({
                error: "Lidarr not configured. Please add albums manually to your library.",
            });
        }

        // Determine root folder path based on download type
        const rootFolderPath =
            downloadType === "discovery" ? "/music/discovery" : "/music";

        if (type === "artist") {
            // For artist downloads, fetch albums and create individual jobs
            const jobs = await processArtistDownload(
                userId,
                mbid,
                subject,
                rootFolderPath,
                downloadType
            );

            return res.json({
                id: jobs[0]?.id || null,
                status: "processing",
                downloadType,
                rootFolderPath,
                message: `Creating download jobs for ${jobs.length} album(s)...`,
                albumCount: jobs.length,
                jobs: jobs.map((j) => ({ id: j.id, subject: j.subject })),
            });
        }

        // Single album download - verify artist name before proceeding
        let verifiedArtistName = artistName;
        if (type === "album" && artistName) {
            const verification = await verifyArtistName(artistName, mbid);
            if (verification.wasCorrected) {
                logger.debug(
                    `[DOWNLOAD] Artist name verified: "${artistName}" → "${verification.verifiedName}" (source: ${verification.source})`
                );
                verifiedArtistName = verification.verifiedName;
            }
        }

        // Single album download - check for existing job first
        const existingJob = await prisma.downloadJob.findFirst({
            where: {
                targetMbid: mbid,
                status: { in: ["pending", "processing"] },
            },
        });

        if (existingJob) {
            logger.debug(
                `[DOWNLOAD] Job already exists for ${mbid}: ${existingJob.id} (${existingJob.status})`
            );
            return res.json({
                id: existingJob.id,
                status: existingJob.status,
                downloadType,
                rootFolderPath,
                message: "Download already in progress",
                duplicate: true,
            });
        }

        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject,
                type,
                targetMbid: mbid,
                status: "pending",
                metadata: {
                    downloadType,
                    rootFolderPath,
                    artistName: verifiedArtistName,
                    albumTitle,
                },
            },
        });

        logger.debug(
            `[DOWNLOAD] Triggering Lidarr: ${type} "${subject}" -> ${rootFolderPath}`
        );

        // Process in background
        processDownload(
            job.id,
            type,
            mbid,
            subject,
            rootFolderPath,
            verifiedArtistName,
            albumTitle
        ).catch((error) => {
            logger.error(
                `Download processing failed for job ${job.id}:`,
                error
            );
        });

        res.json({
            id: job.id,
            status: job.status,
            downloadType,
            rootFolderPath,
            message: "Download job created. Processing in background.",
        });
    } catch (error) {
        logger.error("Create download job error:", error);
        res.status(500).json({ error: "Failed to create download job" });
    }
});

/**
 * Process artist download by creating individual album jobs
 */
async function processArtistDownload(
    userId: string,
    artistMbid: string,
    artistName: string,
    rootFolderPath: string,
    downloadType: string
): Promise<{ id: string; subject: string }[]> {
    logger.debug(`\n Processing artist download: ${artistName}`);
    logger.debug(`   Artist MBID: ${artistMbid}`);

    // Generate a batch ID to group all album downloads
    const batchId = crypto.randomUUID();
    logger.debug(`   Batch ID: ${batchId}`);

    // CRITICAL FIX: Resolve canonical artist name from MusicBrainz
    // Last.fm may return aliases (e.g., "blink" for "blink-182")
    // Lidarr needs the official name to find the correct artist
    let canonicalArtistName = artistName;
    try {
        logger.debug(`   Resolving canonical artist name from MusicBrainz...`);
        const mbArtist = await musicBrainzService.getArtist(artistMbid);
        if (mbArtist && mbArtist.name) {
            canonicalArtistName = mbArtist.name;
            if (canonicalArtistName !== artistName) {
                logger.debug(
                    `   ✓ Canonical name resolved: "${artistName}" → "${canonicalArtistName}"`
                );
            } else {
                logger.debug(
                    `   ✓ Name matches canonical: "${canonicalArtistName}"`
                );
            }
        }
    } catch (mbError: any) {
        logger.warn(`   ⚠ MusicBrainz lookup failed: ${mbError.message}`);
        // Fallback to LastFM correction
        try {
            const correction = await lastFmService.getArtistCorrection(
                artistName
            );
            if (correction?.canonicalName) {
                canonicalArtistName = correction.canonicalName;
                logger.debug(
                    `   ✓ Name resolved via LastFM: "${artistName}" → "${canonicalArtistName}"`
                );
            }
        } catch (lfmError) {
            logger.warn(
                `   ⚠ LastFM correction also failed, using original name`
            );
        }
    }

    try {
        // First, add the artist to Lidarr (this monitors all albums)
        const lidarrArtist = await lidarrService.addArtist(
            artistMbid,
            canonicalArtistName,
            rootFolderPath
        );

        if (!lidarrArtist) {
            logger.debug(`   Failed to add artist to Lidarr`);
            throw new Error("Failed to add artist to Lidarr");
        }

        logger.debug(`   Artist added to Lidarr (ID: ${lidarrArtist.id})`);

        // Fetch albums from MusicBrainz
        const releaseGroups = await musicBrainzService.getReleaseGroups(
            artistMbid,
            ["album", "ep"],
            100
        );

        logger.debug(
            `   Found ${releaseGroups.length} albums/EPs from MusicBrainz`
        );

        if (releaseGroups.length === 0) {
            logger.debug(`   No albums found for artist`);
            return [];
        }

        // Create individual album jobs
        const jobs: { id: string; subject: string }[] = [];

        for (const rg of releaseGroups) {
            const albumMbid = rg.id;
            const albumTitle = rg.title;
            const albumSubject = `${artistName} - ${albumTitle}`;

            // Check if we already have this album downloaded
            const existingAlbum = await prisma.album.findFirst({
                where: { rgMbid: albumMbid },
            });

            if (existingAlbum) {
                logger.debug(`   Skipping "${albumTitle}" - already in library`);
                continue;
            }

            // Use transaction to prevent race conditions when creating jobs
            const jobResult = await prisma.$transaction(async (tx) => {
                // Check for existing active job
                const existingJob = await tx.downloadJob.findFirst({
                    where: {
                        targetMbid: albumMbid,
                        status: { in: ["pending", "processing"] },
                    },
                });

                if (existingJob) {
                    return {
                        skipped: true,
                        job: existingJob,
                        reason: "already_queued",
                    };
                }

                // Also check for recently failed job (within last 30 seconds) to prevent spam retries
                const recentFailed = await tx.downloadJob.findFirst({
                    where: {
                        targetMbid: albumMbid,
                        status: "failed",
                        completedAt: { gte: new Date(Date.now() - 30000) },
                    },
                });

                if (recentFailed) {
                    return {
                        skipped: true,
                        job: recentFailed,
                        reason: "recently_failed",
                    };
                }

                // Create new job inside transaction
                const now = new Date();
                const job = await tx.downloadJob.create({
                    data: {
                        userId,
                        subject: albumSubject,
                        type: "album",
                        targetMbid: albumMbid,
                        status: "pending",
                        metadata: {
                            downloadType,
                            rootFolderPath,
                            artistName,
                            artistMbid,
                            albumTitle,
                            batchId, // Link all albums in this artist download
                            batchArtist: artistName,
                            createdAt: now.toISOString(), // Track when job was created for timeout
                        },
                    },
                });

                return { skipped: false, job };
            });

            if (jobResult.skipped) {
                logger.debug(
                    `   Skipping "${albumTitle}" - ${
                        jobResult.reason === "recently_failed"
                            ? "recently failed"
                            : "already in download queue"
                    }`
                );
                continue;
            }

            const job = jobResult.job;
            jobs.push({ id: job.id, subject: albumSubject });
            logger.debug(`   [JOB] Created job for: ${albumSubject}`);

            // Start the download in background
            processDownload(
                job.id,
                "album",
                albumMbid,
                albumSubject,
                rootFolderPath,
                artistName,
                albumTitle
            ).catch((error) => {
                logger.error(`Download failed for ${albumSubject}:`, error);
            });
        }

        logger.debug(`   Created ${jobs.length} album download jobs`);
        return jobs;
    } catch (error: any) {
        logger.error(`   Failed to process artist download:`, error.message);
        throw error;
    }
}

// Background download processor
async function processDownload(
    jobId: string,
    type: string,
    mbid: string,
    subject: string,
    rootFolderPath: string,
    artistName?: string,
    albumTitle?: string
) {
    const job = await prisma.downloadJob.findUnique({ where: { id: jobId } });
    if (!job) {
        logger.error(`Job ${jobId} not found`);
        return;
    }

    if (type === "album") {
        // For albums, use the simple download manager
        let parsedArtist = artistName;
        let parsedAlbum = albumTitle;

        if (!parsedArtist || !parsedAlbum) {
            const parts = subject.split(" - ");
            if (parts.length >= 2) {
                parsedArtist = parts[0].trim();
                parsedAlbum = parts.slice(1).join(" - ").trim();
            } else {
                parsedArtist = subject;
                parsedAlbum = subject;
            }
        }

        logger.debug(`Parsed: Artist="${parsedArtist}", Album="${parsedAlbum}"`);

        // Use simple download manager for album downloads
        const result = await simpleDownloadManager.startDownload(
            jobId,
            parsedArtist,
            parsedAlbum,
            mbid,
            job.userId
        );

        if (!result.success) {
            logger.error(`Failed to start download: ${result.error}`);
        }
    }
}

// DELETE /downloads/clear-all - Clear all download jobs for the current user
// IMPORTANT: Must be BEFORE /:id route to avoid catching "clear-all" as an ID
router.delete("/clear-all", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { status } = req.query;

        const where: any = { userId };
        if (status) {
            where.status = status as string;
        }

        const result = await prisma.downloadJob.deleteMany({ where });

        logger.debug(
            ` Cleared ${result.count} download jobs for user ${userId}`
        );
        res.json({ success: true, deleted: result.count });
    } catch (error) {
        logger.error("Clear downloads error:", error);
        res.status(500).json({ error: "Failed to clear downloads" });
    }
});

// POST /downloads/clear-lidarr-queue - Clear stuck/failed items from Lidarr's queue
router.post("/clear-lidarr-queue", async (req, res) => {
    try {
        const result = await simpleDownloadManager.clearLidarrQueue();
        res.json({
            success: true,
            removed: result.removed,
            errors: result.errors,
        });
    } catch (error: any) {
        logger.error("Clear Lidarr queue error:", error);
        res.status(500).json({ error: "Failed to clear Lidarr queue" });
    }
});

// GET /downloads/failed - List failed/unavailable albums for the current user
// IMPORTANT: Must be BEFORE /:id route to avoid catching "failed" as an ID
router.get("/failed", async (req, res) => {
    try {
        const userId = req.user!.id;

        const failedAlbums = await prisma.unavailableAlbum.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });

        res.json(failedAlbums);
    } catch (error) {
        logger.error("List failed albums error:", error);
        res.status(500).json({ error: "Failed to list failed albums" });
    }
});

// DELETE /downloads/failed/:id - Dismiss a failed album notification
router.delete("/failed/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        // Verify ownership before deleting
        const failedAlbum = await prisma.unavailableAlbum.findFirst({
            where: { id, userId },
        });

        if (!failedAlbum) {
            return res.status(404).json({ error: "Failed album not found" });
        }

        await prisma.unavailableAlbum.delete({
            where: { id },
        });

        res.json({ success: true });
    } catch (error) {
        logger.error("Delete failed album error:", error);
        res.status(500).json({ error: "Failed to delete failed album" });
    }
});

// GET /downloads/:id - Get download job status
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const job = await prisma.downloadJob.findFirst({
            where: {
                id,
                userId,
            },
        });

        if (!job) {
            return res.status(404).json({ error: "Download job not found" });
        }

        res.json(job);
    } catch (error) {
        logger.error("Get download job error:", error);
        res.status(500).json({ error: "Failed to get download job" });
    }
});

// PATCH /downloads/:id - Update download job (e.g., mark as complete)
router.patch("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const { status } = req.body;

        const job = await prisma.downloadJob.findFirst({
            where: {
                id,
                userId,
            },
        });

        if (!job) {
            return res.status(404).json({ error: "Download job not found" });
        }

        const updated = await prisma.downloadJob.update({
            where: { id },
            data: {
                status: status || "completed",
                completedAt: status === "completed" ? new Date() : undefined,
            },
        });

        res.json(updated);
    } catch (error) {
        logger.error("Update download job error:", error);
        res.status(500).json({ error: "Failed to update download job" });
    }
});

// DELETE /downloads/:id - Delete download job
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        // Use deleteMany to handle race conditions gracefully
        // This won't throw an error if the record was already deleted
        const result = await prisma.downloadJob.deleteMany({
            where: {
                id,
                userId,
            },
        });

        // Return success even if nothing was deleted (idempotent delete)
        res.json({ success: true, deleted: result.count > 0 });
    } catch (error: any) {
        logger.error("Delete download job error:", error);
        logger.error("Error details:", error.message, error.stack);
        res.status(500).json({
            error: "Failed to delete download job",
            details: error.message,
        });
    }
});

// GET /downloads - List user's download jobs
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            status,
            limit = "50",
            includeDiscovery = "false",
            includeCleared = "false",
        } = req.query;

        const where: any = { userId };
        if (status) {
            where.status = status as string;
        }
        // Filter out cleared jobs by default (user dismissed from history)
        if (includeCleared !== "true") {
            where.cleared = false;
        }

        const jobs = await prisma.downloadJob.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: parseInt(limit as string, 10),
        });

        // Filter out discovery downloads unless explicitly requested
        // Discovery downloads are automated and shouldn't show in the UI popover
        const filteredJobs =
            includeDiscovery === "true"
                ? jobs
                : jobs.filter((job) => {
                      const metadata = job.metadata as any;
                      return metadata?.downloadType !== "discovery";
                  });

        res.json(filteredJobs);
    } catch (error) {
        logger.error("List download jobs error:", error);
        res.status(500).json({ error: "Failed to list download jobs" });
    }
});

// POST /downloads/keep-track - Keep a discovery track (move to permanent library)
router.post("/keep-track", async (req, res) => {
    try {
        const { discoveryTrackId } = req.body;
        const userId = req.user!.id;

        if (!discoveryTrackId) {
            return res.status(400).json({ error: "Missing discoveryTrackId" });
        }

        const discoveryTrack = await prisma.discoveryTrack.findUnique({
            where: { id: discoveryTrackId },
            include: {
                discoveryAlbum: true,
            },
        });

        if (!discoveryTrack) {
            return res.status(404).json({ error: "Discovery track not found" });
        }

        // Mark as kept
        await prisma.discoveryTrack.update({
            where: { id: discoveryTrackId },
            data: { userKept: true },
        });

        // If Lidarr enabled, create job to download full album to permanent library
        const lidarrEnabled = await lidarrService.isEnabled();
        if (lidarrEnabled) {
            const job = await prisma.downloadJob.create({
                data: {
                    userId,
                    subject: `${discoveryTrack.discoveryAlbum.albumTitle} by ${discoveryTrack.discoveryAlbum.artistName}`,
                    type: "album",
                    targetMbid: discoveryTrack.discoveryAlbum.rgMbid,
                    status: "pending",
                },
            });

            return res.json({
                success: true,
                message:
                    "Track marked as kept. Full album will be downloaded to permanent library.",
                downloadJobId: job.id,
            });
        }

        res.json({
            success: true,
            message:
                "Track marked as kept. Please add the full album manually to your /music folder.",
        });
    } catch (error) {
        logger.error("Keep track error:", error);
        res.status(500).json({ error: "Failed to keep track" });
    }
});

export default router;
