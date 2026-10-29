/** Release Radar: the upcoming and recent releases of the artists Lidarr monitors, and downloading one. */

import { Router } from "express";
import { logger } from "../utils/logger";
import { lidarrService } from "../services/lidarr";
import { prisma } from "../utils/db";
import { ConfigurationError } from "../utils/errors";
import { requireAuthOrToken, requireAcquirePermission } from "../middleware/auth";
import { acquisitionService } from "../services/acquisitionService";
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
}

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: 'lidarr';
    status: 'upcoming' | 'released' | 'available';
    inLibrary: boolean;
    canDownload: boolean;
}

/**
 * GET /releases/radar
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
        
        const monitoredArtists = await lidarrService.getMonitoredArtists();
        logger.debug(`[Releases] Found ${lidarrReleases.length} Lidarr releases`);

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
        };

        res.json(response);
    } catch (error: any) {
        logger.error("[Releases] Radar error:", error.message);
        res.status(500).json({ error: "Failed to fetch release radar" });
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
        const userId = req.user!.id;

        // The radar row carries artist and title, and the acquisition searches sources by name.
        const parsed = downloadReleaseSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "artistName and albumTitle are required to download a release",
                details: parsed.error.issues,
            });
        }
        const { artistName, albumTitle } = parsed.data;

        // One job per album for this listener, never a Discover one; a second tap gets the job already running,
        // whose acquisition is not started again.
        const { job, created } = await acquisitionService.findOrCreateDownloadJob(
            { artistName, albumTitle, mbid: albumMbid },
            { userId }
        );
        const jobId = job.id;

        if (created) {
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

            // Config errors throw and acquisition failures resolve {success:false}; both fail the job.
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
            message: created
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

