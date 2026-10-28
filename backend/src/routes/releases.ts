/**
 * Release Radar API
 *
 * Provides upcoming and recent releases from:
 * 1. Lidarr monitored artists (via calendar API)
 * 2. Similar artists from user's library (local similarity engine)
 */

import { Router } from "express";
import { logger } from "../utils/logger";
import { lidarrService } from "../services/lidarr";
import { prisma } from "../utils/db";
import { ConfigurationError } from "../utils/errors";
import { requireAuthOrToken, requireAcquirePermission } from "../middleware/auth";
import { withAlbumArtwork } from "../services/artwork";
import { z } from "zod";

const router = Router();
router.use(requireAuthOrToken);

// Lidarr's Cover Art Archive address is empty for most unowned albums, so ask
// the library's artwork providers instead.
function withReleaseArtwork<
    T extends { albumMbid?: string; artistName: string; title: string; coverUrl?: string | null },
>(releases: T[]): Promise<T[]> {
    return withAlbumArtwork(
        releases,
        (r) => ({
            rgMbid: r.albumMbid,
            artistName: r.artistName,
            albumTitle: r.title,
            candidateUrl: r.coverUrl,
        }),
        (r, coverUrl) => ({ ...r, coverUrl }),
    );
}

/** The release-group mbids among `releases` that the library already owns. */
async function ownedRgMbids<T extends { albumMbid: string }>(
    releases: T[]
): Promise<Set<string>> {
    const candidates = [...new Set(releases.map(r => r.albumMbid).filter(Boolean))];
    const rows = await prisma.album.findMany({
        where: { rgMbid: { in: candidates } },
        select: { rgMbid: true },
    });
    return new Set(rows.map(a => a.rgMbid).filter(Boolean));
}

interface ReleaseRadarResponse {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: 'lidarr' | 'similar';
    status: 'upcoming' | 'released' | 'available';
    inLibrary: boolean;
    canDownload: boolean;
}

/**
 * GET /releases/radar
 * 
 * Get upcoming and recent releases for the user's monitored artists
 * and their similar artists.
 */
router.get("/radar", async (req, res) => {
    try {
        const now = new Date();
        const daysBack = parseInt(req.query.daysBack as string) || 30;
        const daysAhead = parseInt(req.query.daysAhead as string) || 90;

        // Calculate date range
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);
        
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        logger.debug(`[Releases] Fetching radar: ${daysBack} days back, ${daysAhead} days ahead`);

        // 1. Get releases from Lidarr calendar (monitored artists)
        const lidarrReleases = await lidarrService.getCalendar(startDate, endDate);
        
        // 2. Get monitored artists from Lidarr
        const monitoredArtists = await lidarrService.getMonitoredArtists();
        const monitoredMbids = new Set(monitoredArtists.map(a => a.mbid));

        // 3. Get similar artists from user's library that aren't monitored
        const similarArtists = await prisma.similarArtist.findMany({
            where: {
                // Source artist is in the library (has albums)
                fromArtist: {
                    albums: { some: {} }
                },
                // Target artist is NOT in library (no albums)
                toArtist: {
                    albums: { none: {} }
                }
            },
            select: {
                toArtist: {
                    select: {
                        id: true,
                        name: true,
                        mbid: true,
                    }
                },
                weight: true,
            },
            orderBy: { weight: 'desc' },
            take: 50, // Top 50 similar artists
        });

        // Filter out any that are already monitored in Lidarr
        const unmonitoredSimilar = similarArtists.filter(
            sa => sa.toArtist.mbid && !monitoredMbids.has(sa.toArtist.mbid)
        );

        logger.debug(`[Releases] Found ${lidarrReleases.length} Lidarr releases`);
        logger.debug(`[Releases] Found ${unmonitoredSimilar.length} unmonitored similar artists`);

        // 4. Check which of these releases the library owns, looking up only their MBIDs.
        const libraryAlbumMbids = await ownedRgMbids(lidarrReleases);

        // 5. Transform Lidarr releases
        const rawReleases: ReleaseItem[] = lidarrReleases.map(release => {
            const releaseTime = new Date(release.releaseDate).getTime();
            const isUpcoming = releaseTime > now.getTime();
            const inLibrary = release.hasFile || libraryAlbumMbids.has(release.albumMbid);

            return {
                id: release.id,
                title: release.title,
                artistName: release.artistName,
                artistMbid: release.artistMbid,
                albumMbid: release.albumMbid,
                releaseDate: release.releaseDate,
                coverUrl: release.coverUrl,
                source: 'lidarr' as const,
                status: isUpcoming ? 'upcoming' : (inLibrary ? 'available' : 'released'),
                inLibrary,
                canDownload: !inLibrary && !isUpcoming,
            };
        });

        const releases = await withReleaseArtwork(rawReleases);

        // 6. Split into upcoming and recent
        const upcoming = releases
            .filter(r => r.status === 'upcoming')
            .sort((a, b) => new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime());

        const recent = releases
            .filter(r => r.status !== 'upcoming')
            .sort((a, b) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime());

        const response: ReleaseRadarResponse = {
            upcoming,
            recent,
            monitoredArtistCount: monitoredArtists.length,
            similarArtistCount: unmonitoredSimilar.length,
        };

        res.json(response);
    } catch (error: any) {
        logger.error("[Releases] Radar error:", error.message);
        res.status(500).json({ error: "Failed to fetch release radar" });
    }
});

/**
 * GET /releases/upcoming
 * 
 * Get only upcoming releases (next X days)
 */
router.get("/upcoming", async (req, res) => {
    try {
        const daysAhead = parseInt(req.query.days as string) || 90;
        
        const now = new Date();
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        const releases = await lidarrService.getCalendar(now, endDate);

        // Sort by release date (soonest first)
        const sorted = releases.sort((a, b) => 
            new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime()
        );

        const checked = await withReleaseArtwork(sorted);

        res.json({
            releases: checked,
            count: sorted.length,
            daysAhead,
        });
    } catch (error: any) {
        logger.error("[Releases] Upcoming error:", error.message);
        res.status(500).json({ error: "Failed to fetch upcoming releases" });
    }
});

/**
 * GET /releases/recent
 * 
 * Get recently released albums (last X days) that user might want to download
 */
router.get("/recent", async (req, res) => {
    try {
        const daysBack = parseInt(req.query.days as string) || 30;
        
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysBack);

        const releases = await lidarrService.getCalendar(startDate, now);
        
        const libraryMbids = await ownedRgMbids(releases);

        // Filter to releases not in library and sort (newest first)
        const notInLibrary = releases
            .filter(r => !r.hasFile && !libraryMbids.has(r.albumMbid))
            .sort((a, b) => 
                new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
            );

        const checked = await withReleaseArtwork(notInLibrary);

        res.json({
            releases: checked,
            count: notInLibrary.length,
            daysBack,
            inLibraryCount: releases.length - notInLibrary.length,
        });
    } catch (error: any) {
        logger.error("[Releases] Recent error:", error.message);
        res.status(500).json({ error: "Failed to fetch recent releases" });
    }
});

/**
 * POST /releases/download/:albumMbid
 * 
 * Download a release from the radar
 */
const downloadReleaseSchema = z.object({
    artistName: z.string().min(1),
    albumTitle: z.string().min(1),
});

router.post("/download/:albumMbid", requireAcquirePermission, async (req, res) => {
    try {
        const { albumMbid } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: "Authentication required" });
        }

        // The radar row the client is showing already carries artist + title;
        // they're required because the acquisition service resolves the album by
        // name (the release-group mbid alone isn't enough for the source search).
        const parsed = downloadReleaseSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "artistName and albumTitle are required to download a release",
                details: parsed.error.issues,
            });
        }
        const { artistName, albumTitle } = parsed.data;

        logger.debug(
            `[Releases] Download requested: ${artistName} - ${albumTitle} (${albumMbid})`
        );

        // Pre-create (or reuse) the DownloadJob, so the download is trackable by id and
        // early config errors stay visible. Dedup and create run under the lock
        // createDownloadJob uses, so two taps cannot start two downloads.
        const { acquisitionService } = await import(
            "../services/acquisitionService"
        );
        const { distributedLock } = await import("../utils/distributedLock");

        const jobWhere: any = {
            userId,
            status: { in: ["pending", "processing"] },
        };
        if (albumMbid) jobWhere.targetMbid = albumMbid;
        else jobWhere.subject = `${artistName} - ${albumTitle}`;

        const dedupKey = albumMbid || `${artistName}::${albumTitle}`;
        const { jobId, started } = await distributedLock.withLock(
            `release-download:${userId}:${dedupKey}`,
            5000,
            async () => {
                const existing = await prisma.downloadJob.findFirst({
                    where: jobWhere,
                });
                if (existing) return { jobId: existing.id, started: false };
                const created = await prisma.downloadJob.create({
                    data: {
                        userId,
                        subject: `${artistName} - ${albumTitle}`,
                        type: "album",
                        targetMbid: albumMbid || null,
                        status: "pending",
                        metadata: {
                            artistName,
                            albumTitle,
                            albumMbid: albumMbid || null,
                        },
                    },
                });
                return { jobId: created.id, started: true };
            }
        );

        // Only launch the acquisition for a FRESHLY-created job. A reused in-flight job
        // already has an acquisition running; re-triggering would start a duplicate
        // download and race two status writers on the same row.
        if (started) {
            const markFailed = (message: string) =>
                prisma.downloadJob
                    .update({
                        where: { id: jobId },
                        data: {
                            status: "failed",
                            error: message,
                            completedAt: new Date(),
                        },
                    })
                    .catch(() => {});

            // Use the shared acquisition service, which honours the user's download source.
            // Runs in the background against the job; config errors throw, acquisition
            // failures resolve {success:false}, and both mark the job failed.
            void acquisitionService
                .acquireAlbum(
                    { albumTitle, artistName, mbid: albumMbid },
                    { userId, existingJobId: jobId }
                )
                .then((result) => {
                    if (!result?.success) {
                        logger.error(
                            `[Releases] Acquisition did not start for ${albumMbid}: ${
                                result?.error || "unknown error"
                            }`
                        );
                        void markFailed(result?.error || "Acquisition did not start");
                    }
                })
                .catch((error: any) => {
                    logger.error(
                        `[Releases] Background acquisition failed for ${albumMbid}:`,
                        error?.message || error
                    );
                    void markFailed(error?.message || "Acquisition failed");
                });
        }

        return res.status(200).json({
            success: true,
            jobId,
            message: started
                ? `Download started for ${artistName} - ${albumTitle}`
                : `Download already in progress for ${artistName} - ${albumTitle}`,
        });
    } catch (error: any) {
        logger.error("[Releases] Download error:", error.message);

        // With no Lidarr configured, acquireAlbum throws this; answer with its
        // actionable message, not a generic 500.
        if (error instanceof ConfigurationError) {
            return res.status(400).json({
                error: error.message,
                code: "CONFIGURATION_ERROR",
            });
        }

        res.status(500).json({ error: "Failed to start download" });
    }
});

export default router;

