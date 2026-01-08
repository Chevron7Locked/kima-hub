import { logger } from "../utils/logger";

/**
 * Release Radar API
 *
 * Provides upcoming and recent releases from:
 * 1. Lidarr monitored artists (via calendar API)
 * 2. Similar artists from user's library (Last.fm similar artists)
 */

import { Router } from "express";
import { lidarrService, CalendarRelease } from "../services/lidarr";
import { prisma } from "../utils/db";

const router = Router();

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

        // 4. Get albums in library to check what user already has
        const libraryAlbums = await prisma.album.findMany({
            select: {
                rgMbid: true,
            }
        });
        const libraryAlbumMbids = new Set(libraryAlbums.map(a => a.rgMbid).filter(Boolean));

        // 5. Transform Lidarr releases
        const releases: ReleaseItem[] = lidarrReleases.map(release => {
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

        res.json({
            releases: sorted,
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
        
        // Get library albums to mark what's already downloaded
        const libraryAlbums = await prisma.album.findMany({
            select: { rgMbid: true }
        });
        const libraryMbids = new Set(libraryAlbums.map(a => a.rgMbid).filter(Boolean));

        // Filter to releases not in library and sort (newest first)
        const notInLibrary = releases
            .filter(r => !r.hasFile && !libraryMbids.has(r.albumMbid))
            .sort((a, b) => 
                new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
            );

        res.json({
            releases: notInLibrary,
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
router.post("/download/:albumMbid", async (req, res) => {
    try {
        const { albumMbid } = req.params;
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ error: "Authentication required" });
        }

        logger.debug(`[Releases] Download requested for album: ${albumMbid}`);

        // TODO: Implement downloadAlbum method on LidarrService
        // For now, return not implemented error
        res.status(501).json({
            error: "Download feature not yet implemented for release radar"
        });
    } catch (error: any) {
        logger.error("[Releases] Download error:", error.message);
        res.status(500).json({ error: "Failed to start download" });
    }
});

export default router;

