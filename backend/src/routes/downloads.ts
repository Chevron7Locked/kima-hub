import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAcquirePermission } from "../middleware/auth";
import { prisma } from "../utils/db";
import { config } from "../config";
import { lidarrService } from "../services/lidarr";
import { musicBrainzService } from "../services/musicbrainz";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import * as downloadJobs from "../services/downloads/jobs";
import { sweepFailedDownloads } from "../services/lidarrFailures";
import crypto from "crypto";
import { refuseRequest, safeError, UserFacingError } from "../utils/errors";
import { failureCause } from "../utils/outcome";
import { isMbid } from "../services/artistIdentity";

const router = Router();

router.post("/", requireAcquirePermission, async (req, res) => {
    try {
        const {
            type,
            mbid,
            subject,
            artistName,
            albumTitle,
        } = req.body;
        const userId = req.user!.id;

        if (!type || !mbid || !subject) {
            return refuseRequest(req, res, "type, mbid and subject required");
        }

        if (!isMbid(mbid)) {
            return refuseRequest(req, res, "mbid: not a MusicBrainz id");
        }

        if (type !== "artist" && type !== "album") {
            return refuseRequest(req, res, "type: must be artist or album");
        }

        const lidarrEnabled = await lidarrService.isEnabled();
        if (!lidarrEnabled) {
            return res.status(400).json({
                error: "Lidarr not configured. Please add albums manually to your library.",
            });
        }

        // Every download a person asks for goes to the music folder as "library"; a downloadType a client
        // still sends is ignored. Discover's own jobs are marked "discovery" in acquisitionService.
        const rootFolderPath = config.music.musicPath;

        if (type === "artist") {
            const jobs = await processArtistDownload(
                userId,
                mbid,
                subject,
                rootFolderPath
            );

            return res.json({
                id: jobs[0]?.id || null,
                status: "processing",
                downloadType: "library",
                rootFolderPath,
                message: `Creating download jobs for ${jobs.length} album(s)...`,
                albumCount: jobs.length,
                jobs: jobs.map((j) => ({ id: j.id, subject: j.subject })),
            });
        }

        // The release group's own credit names the artist Lidarr will file it under.
        let verifiedArtistName = artistName;
        const group = await musicBrainzService.getReleaseGroup(mbid);
        if (group.kind === "absent" || group.kind === "permanent") {
            return res.status(404).json({ error: "No such album on MusicBrainz" });
        }
        if (group.kind === "answered") {
            verifiedArtistName =
                group.value?.["artist-credit"]?.[0]?.artist?.name ?? artistName;
        } else {
            logger.warn(`[DOWNLOAD] Release group ${mbid}: ${failureCause(group)}`);
        }

        // One active job per user per album: the unique index stops two concurrent requests, and the loser takes the winner.
        const jobResult = await prisma.$transaction(async (tx) => {
            const existingJob = await downloadJobs.findActive({ userId, type: "album", targetMbid: mbid }, tx);
            if (existingJob) {
                return { duplicate: true, job: existingJob };
            }

            const newJob = await downloadJobs.create(
                {
                    userId,
                    subject,
                    type,
                    targetMbid: mbid,
                    metadata: {
                        downloadType: "library",
                        rootFolderPath,
                        artistName: verifiedArtistName,
                        albumTitle,
                    },
                },
                tx
            );

            return { duplicate: false, job: newJob };
        });

        if (jobResult.duplicate) {
            return res.json({
                id: jobResult.job.id,
                status: jobResult.job.status,
                downloadType: "library",
                rootFolderPath,
                message: "Download already in progress",
                duplicate: true,
            });
        }

        const job = jobResult.job;

        logger.debug(
            `[DOWNLOAD] Triggering Lidarr: ${type} "${subject}" -> ${rootFolderPath}`
        );

        processDownload(
            job.id,
            mbid,
            subject,
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
            downloadType: "library",
            rootFolderPath,
            message: "Download job created. Processing in background.",
        });
    } catch (error: any) {
        // Two inserts that both saw no row: the unique index rejects the loser.
        if (error.code === "P2002") {
            const { mbid } = req.body;
            const existingJob = await downloadJobs.findActive({ userId: req.user!.id, type: "album", targetMbid: mbid });
            if (existingJob) {
                return res.json({
                    id: existingJob.id,
                    status: existingJob.status,
                    downloadType: "library",
                    rootFolderPath: config.music.musicPath,
                    message: "Download already in progress",
                    duplicate: true,
                });
            }
        }
        if (error instanceof UserFacingError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        logger.error("Create download job error:", error);
        res.status(500).json({ error: "Failed to create download job" });
    }
});

/** One album job per release group of the artist, after adding the artist to Lidarr. */
async function processArtistDownload(
    userId: string,
    artistMbid: string,
    artistName: string,
    rootFolderPath: string
): Promise<{ id: string; subject: string }[]> {
    const batchId = crypto.randomUUID();
    logger.debug(`Artist download ${artistName} (${artistMbid}), batch ${batchId}`);

    const mbArtist = await musicBrainzService.getArtist(artistMbid);
    if (mbArtist.kind === "absent" || mbArtist.kind === "permanent") {
        throw new UserFacingError("No such artist on MusicBrainz", 404);
    }
    if (mbArtist.kind === "answered") {
        artistName = mbArtist.value.name;
    } else {
        logger.warn(`   MusicBrainz lookup for ${artistMbid}: ${failureCause(mbArtist)}`);
    }

    const lidarrArtist = await lidarrService.addArtist(
        artistMbid,
        artistName,
        rootFolderPath
    );

    if (!lidarrArtist) {
        throw new Error("Failed to add artist to Lidarr");
    }

    logger.debug(`   Artist added to Lidarr (ID: ${lidarrArtist.id})`);

    const discography = await musicBrainzService.getReleaseGroups(
        artistMbid,
        ["album", "ep"],
        100
    );
    if (discography.kind === "absent") {
        logger.debug(`   MusicBrainz has no albums for this artist`);
        return [];
    }
    if (discography.kind !== "answered") {
        // A failed question is not "no albums": rethrow so the job
        // fails with the real cause instead of silently queuing zero.
        throw new Error(
            `Discography lookup ${discography.kind}: ${failureCause(discography)}`
        );
    }
    const releaseGroups = discography.value;

    logger.debug(
        `   Found ${releaseGroups.length} albums/EPs from MusicBrainz`
    );

    if (releaseGroups.length === 0) {
        logger.debug(`   No albums found for artist`);
        return [];
    }

    const jobs: { id: string; subject: string }[] = [];

    for (const rg of releaseGroups) {
        const albumMbid = rg.id;
        const albumTitle = rg.title;
        const albumSubject = `${artistName} - ${albumTitle}`;

        const existingAlbum = await prisma.album.findFirst({
            where: { rgMbid: albumMbid },
        });

        if (existingAlbum) {
            logger.debug(`   Skipping "${albumTitle}" - already in library`);
            continue;
        }

        const jobResult = await prisma.$transaction(async (tx) => {
            if (await downloadJobs.findActive({ userId, type: "album", targetMbid: albumMbid }, tx)) {
                return { skipped: true as const, reason: "already_queued" };
            }

            // An album that failed a moment ago is not started again yet.
            if (await downloadJobs.recentlyFailed({ userId, type: "album", targetMbid: albumMbid }, tx)) {
                return { skipped: true as const, reason: "recently_failed" };
            }

            const job = await downloadJobs.create(
                {
                    userId,
                    subject: albumSubject,
                    type: "album",
                    targetMbid: albumMbid,
                    artistMbid,
                    metadata: {
                        downloadType: "library",
                        rootFolderPath,
                        artistName,
                        artistMbid,
                        albumTitle,
                        batchId,
                    },
                },
                tx
            );

            return { skipped: false as const, job };
        }).catch((error: any) => {
            // Another request queued this album between the check and the insert: the index refused the second job.
            if (error?.code === "P2002") return { skipped: true as const, reason: "already_queued" };
            throw error;
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

        const { job } = jobResult;
        jobs.push({ id: job.id, subject: albumSubject });
        logger.debug(`   [JOB] Created job for: ${albumSubject}`);

        processDownload(
            job.id,
            albumMbid,
            albumSubject,
            artistName,
            albumTitle
        ).catch((error) => {
            logger.error(`Download failed for ${albumSubject}:`, error);
        });
    }

    logger.debug(`   Created ${jobs.length} album download jobs`);
    return jobs;
}

/** Hands an album job to the download manager; the names come from the subject ("artist - album") when not given. */
async function processDownload(
    jobId: string,
    mbid: string,
    subject: string,
    artistName?: string,
    albumTitle?: string
) {
    let artist = artistName;
    let album = albumTitle;
    if (!artist || !album) {
        const parts = subject.split(" - ");
        artist = parts.length >= 2 ? parts[0].trim() : subject;
        album = parts.length >= 2 ? parts.slice(1).join(" - ").trim() : subject;
    }

    const result = await simpleDownloadManager.startDownload(jobId, artist, album, mbid);
    if (!result.success) {
        logger.error(`Failed to start download: ${result.error}`);
    }
}

// Registered before /:id so "clear-all" is not read as an id.
router.delete("/clear-all", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { status } = req.query;

        const where: { userId: string; status?: string } = { userId };
        if (status !== undefined) {
            if (typeof status !== "string" || !downloadJobs.isJobStatus(status)) {
                return refuseRequest(req, res, "status: not a job status");
            }
            where.status = status;
        }

        const deleted = await simpleDownloadManager.removeJobs(await prisma.downloadJob.findMany({ where }));

        logger.debug(`Cleared ${deleted} download jobs for user ${userId}`);
        res.json({ success: true, deleted });
    } catch (error) {
        logger.error("Clear downloads error:", error);
        res.status(500).json({ error: "Failed to clear downloads" });
    }
});

router.post("/clear-lidarr-queue", async (_req, res) => {
    try {
        const result = await sweepFailedDownloads();
        res.json({ success: true, removed: result.removed });
    } catch (error: any) {
        logger.error("Clear Lidarr queue error:", error);
        res.status(500).json({ error: "Failed to clear Lidarr queue" });
    }
});

// Registered before /:id so "failed" is not read as an id.
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

router.delete("/failed/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

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

router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const jobs = await prisma.downloadJob.findMany({ where: { id, userId } });
        const deleted = await simpleDownloadManager.removeJobs(jobs);

        res.json({ success: true, deleted: deleted > 0 });
    } catch (error) {
        safeError(res, "Delete download job", error);
    }
});

export default router;
