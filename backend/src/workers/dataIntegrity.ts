/**
 * Data Integrity Worker
 *
 * Periodic cleanup to maintain database health:
 * 1. Remove expired DiscoverExclusion records
 * 2. Clean up orphaned DiscoveryTrack records
 * 3. Clean up orphaned Album records (DISCOVER location with no DiscoveryAlbum)
 * 4. Consolidate duplicate artists (temp MBID vs real MBID)
 * 5. Clean up orphaned artists (no albums)
 * 6. Clean up old completed/failed DownloadJob records
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

interface IntegrityReport {
    expiredExclusions: number;
    orphanedDiscoveryTracks: number;
    mislocatedAlbums: number;
    orphanedAlbums: number;
    consolidatedArtists: number;
    orphanedArtists: number;
    oldDownloadJobs: number;
}

export async function runDataIntegrityCheck(): Promise<IntegrityReport> {
    logger.debug("\nRunning data integrity check...");

    const report: IntegrityReport = {
        expiredExclusions: 0,
        orphanedDiscoveryTracks: 0,
        mislocatedAlbums: 0,
        orphanedAlbums: 0,
        consolidatedArtists: 0,
        orphanedArtists: 0,
        oldDownloadJobs: 0,
    };

    // 1. Remove expired DiscoverExclusion records
    const expiredExclusions = await prisma.discoverExclusion.deleteMany({
        where: {
            expiresAt: { lt: new Date() },
        },
    });
    report.expiredExclusions = expiredExclusions.count;
    if (expiredExclusions.count > 0) {
        logger.debug(
            `     Removed ${expiredExclusions.count} expired exclusions`
        );
    }

    // 2. Clean up orphaned DiscoveryTrack records (tracks whose Track record was deleted)
    const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
        where: {
            trackId: null,
        },
    });
    report.orphanedDiscoveryTracks = orphanedDiscoveryTracks.count;
    if (orphanedDiscoveryTracks.count > 0) {
        logger.debug(
            `     Removed ${orphanedDiscoveryTracks.count} orphaned discovery track records`
        );
    }

    // 3. Clean up orphaned DISCOVER albums (no active DiscoveryAlbum record AND no OwnedAlbum)
    const discoverAlbums = await prisma.album.findMany({
        where: { location: "DISCOVER" },
        include: { artist: true },
    });

    for (const album of discoverAlbums) {
        // Check if there's an ACTIVE, LIKED, or MOVED DiscoveryAlbum record
        const hasActiveRecord = await prisma.discoveryAlbum.findFirst({
            where: {
                OR: [
                    { rgMbid: album.rgMbid },
                    {
                        albumTitle: { equals: album.title, mode: "insensitive" },
                        artistName: { equals: album.artist.name, mode: "insensitive" },
                    },
                ],
                status: { in: ["ACTIVE", "LIKED", "MOVED"] },
            },
        });

        // Also check if there's an OwnedAlbum record (user liked it)
        const hasOwnedRecord = await prisma.ownedAlbum.findFirst({
            where: {
                artistId: album.artistId,
                rgMbid: album.rgMbid,
            },
        });

        if (!hasActiveRecord && !hasOwnedRecord) {
            // Delete tracks first
            await prisma.track.deleteMany({
                where: { albumId: album.id },
            });
            // Delete album
            await prisma.album.delete({
                where: { id: album.id },
            });
            report.orphanedAlbums++;
            logger.debug(
                `     Removed orphaned album: ${album.artist.name} - ${album.title}`
            );
        }
    }

    // 4. Fix mislocated LIBRARY albums that should be DISCOVER
    // This happens when:
    // - Discovery tracks have featured artists that don't match the download job
    // - Lidarr downloads a different album than requested (e.g., "Broods" album vs "Evergreen" album)
    // - Album title metadata differs from the requested album
    // - Scanner ran before DiscoveryAlbum records were created
    
    const discoveryJobs = await prisma.downloadJob.findMany({
        where: {
            discoveryBatchId: { not: null },
            status: { in: ["pending", "processing", "completed"] },
        },
    });
    
    // Build sets of discovery album titles AND artist names (normalized)
    const discoveryAlbumTitles = new Set<string>();
    const discoveryArtistNames = new Set<string>();
    const discoveryArtistMbids = new Set<string>();
    
    for (const job of discoveryJobs) {
        const metadata = job.metadata as any;
        const albumTitle = (metadata?.albumTitle || "").toLowerCase().trim();
        const artistName = (metadata?.artistName || "").toLowerCase().trim();
        const artistMbid = metadata?.artistMbid;
        if (albumTitle) discoveryAlbumTitles.add(albumTitle);
        if (artistName) discoveryArtistNames.add(artistName);
        if (artistMbid) discoveryArtistMbids.add(artistMbid);
    }
    
    // Also check DiscoveryAlbum table for ALL discoveries (not just active)
    // This catches albums where Lidarr downloaded a different album than requested
    const allDiscoveryAlbums = await prisma.discoveryAlbum.findMany();
    for (const da of allDiscoveryAlbums) {
        discoveryAlbumTitles.add(da.albumTitle.toLowerCase().trim());
        discoveryArtistNames.add(da.artistName.toLowerCase().trim());
        if (da.artistMbid) discoveryArtistMbids.add(da.artistMbid);
    }
    
    // Find LIBRARY albums that might be discovery
    const libraryAlbums = await prisma.album.findMany({
        where: { location: "LIBRARY" },
        include: { artist: true },
    });
    
    let mislocatedAlbumsFixed = 0;
    for (const album of libraryAlbums) {
        const normalizedTitle = album.title.toLowerCase().trim();
        const normalizedArtist = album.artist.name.toLowerCase().trim();
        
        // Match criteria:
        // 1. Album title matches a discovery download, OR
        // 2. Artist name matches a discovery download (catches Lidarr downloading wrong album), OR
        // 3. Artist MBID matches a discovery download
        const albumMatches = discoveryAlbumTitles.has(normalizedTitle);
        const artistNameMatches = discoveryArtistNames.has(normalizedArtist);
        const artistMbidMatches = album.artist.mbid ? discoveryArtistMbids.has(album.artist.mbid) : false;
        
        if (!albumMatches && !artistNameMatches && !artistMbidMatches) continue;
        
        // KEY FIX: Check if artist has ANY protected OwnedAlbum records:
        // - native_scan = real user library from before discovery
        // - discovery_liked = user liked a discovery album (should be kept!)
        const hasProtectedOwnedAlbum = await prisma.ownedAlbum.findFirst({
            where: {
                artistId: album.artistId,
                source: { in: ["native_scan", "discovery_liked"] },
            },
        });
        
        if (hasProtectedOwnedAlbum) {
            // Artist has protected content - this album should stay as LIBRARY
            continue;
        }
        
        // Also check if artist has any LIKED discovery albums (double-check)
        const hasLikedDiscovery = await prisma.discoveryAlbum.findFirst({
            where: {
                artistMbid: album.artist.mbid || undefined,
                status: { in: ["LIKED", "MOVED"] },
            },
        });
        
        if (hasLikedDiscovery) {
            // User liked albums from this artist - don't touch
            continue;
        }
        
        const reason = albumMatches 
            ? `album title "${album.title}" matches discovery` 
            : artistNameMatches
                ? `artist "${album.artist.name}" matches discovery`
                : `artist MBID matches discovery`;
        logger.debug(
            `     Fixing mislocated album: ${album.artist.name} - ${album.title} (LIBRARY -> DISCOVER, ${reason})`
        );
        
        // Update album location
        await prisma.album.update({
            where: { id: album.id },
            data: { location: "DISCOVER" },
        });
        
        // Remove OwnedAlbum record (but only non-native ones)
        await prisma.ownedAlbum.deleteMany({
            where: { 
                rgMbid: album.rgMbid,
                source: { not: "native_scan" },
            },
        });
        
        mislocatedAlbumsFixed++;
    }
    
    report.mislocatedAlbums = mislocatedAlbumsFixed;
    if (mislocatedAlbumsFixed > 0) {
        logger.debug(`     Fixed ${mislocatedAlbumsFixed} mislocated albums`);
    }

    // 5. Clean up albums with NO tracks (files were deleted from filesystem)
    // These are "ghost" albums that still appear in the database but have no actual content
    const emptyAlbums = await prisma.album.findMany({
        where: {
            tracks: { none: {} },
        },
        include: { artist: true },
    });

    for (const album of emptyAlbums) {
        // Delete the album record
        await prisma.album.delete({
            where: { id: album.id },
        });

        // Also delete any associated OwnedAlbum records
        await prisma.ownedAlbum.deleteMany({
            where: { rgMbid: album.rgMbid },
        });

        report.orphanedAlbums++;
        logger.debug(
            `     Removed empty album (no tracks): ${album.artist.name} - ${album.title}`
        );
    }

    // 6. Clean up orphaned OwnedAlbum records (no matching Album record)
    // This happens when files are deleted but Lidarr records remain
    const orphanedOwnedAlbums = await prisma.$executeRaw`
        DELETE FROM "OwnedAlbum" oa
        WHERE NOT EXISTS (
            SELECT 1 FROM "Album" a WHERE a."rgMbid" = oa."rgMbid"
        )
    `;
    if (orphanedOwnedAlbums > 0) {
        logger.debug(
            `     Removed ${orphanedOwnedAlbums} orphaned OwnedAlbum records`
        );
    }

    // 7. Consolidate duplicate artists (same name, one with temp MBID, one with real)
    const tempArtists = await prisma.artist.findMany({
        where: {
            mbid: { startsWith: "temp-" },
        },
        include: { albums: true },
    });

    for (const tempArtist of tempArtists) {
        // Find a real artist with the same normalized name
        const realArtist = await prisma.artist.findFirst({
            where: {
                normalizedName: tempArtist.normalizedName,
                mbid: { not: { startsWith: "temp-" } },
            },
        });

        if (realArtist) {
            // Move all albums from temp artist to real artist
            await prisma.album.updateMany({
                where: { artistId: tempArtist.id },
                data: { artistId: realArtist.id },
            });

            // Delete SimilarArtist relations
            await prisma.similarArtist.deleteMany({
                where: {
                    OR: [
                        { fromArtistId: tempArtist.id },
                        { toArtistId: tempArtist.id },
                    ],
                },
            });

            // Delete temp artist
            await prisma.artist.delete({
                where: { id: tempArtist.id },
            });

            report.consolidatedArtists++;
            logger.debug(
                `     Consolidated "${tempArtist.name}" (temp) into real artist`
            );
        }
    }

    // 8. Clean up orphaned artists (no albums)
    const orphanedArtists = await prisma.artist.findMany({
        where: {
            albums: { none: {} },
        },
    });

    if (orphanedArtists.length > 0) {
        // Delete SimilarArtist relations first
        await prisma.similarArtist.deleteMany({
            where: {
                OR: [
                    { fromArtistId: { in: orphanedArtists.map((a) => a.id) } },
                    {
                        toArtistId: {
                            in: orphanedArtists.map((a) => a.id),
                        },
                    },
                ],
            },
        });

        // Delete orphaned artists
        await prisma.artist.deleteMany({
            where: { id: { in: orphanedArtists.map((a) => a.id) } },
        });

        report.orphanedArtists = orphanedArtists.length;
    }

    // 9. Clean up old DownloadJob records (older than 30 days, completed/failed)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oldJobs = await prisma.downloadJob.deleteMany({
        where: {
            status: { in: ["completed", "failed"] },
            completedAt: { lt: thirtyDaysAgo },
        },
    });
    report.oldDownloadJobs = oldJobs.count;
    if (oldJobs.count > 0) {
        logger.debug(`     Removed ${oldJobs.count} old download jobs`);
    }

    // Summary
    logger.debug("\nData integrity check complete:");
    logger.debug(`   - Expired exclusions: ${report.expiredExclusions}`);
    logger.debug(
        `   - Orphaned discovery tracks: ${report.orphanedDiscoveryTracks}`
    );
    logger.debug(`   - Mislocated albums (LIBRARY->DISCOVER): ${report.mislocatedAlbums}`);
    logger.debug(`   - Orphaned albums: ${report.orphanedAlbums}`);
    logger.debug(`   - Consolidated artists: ${report.consolidatedArtists}`);
    logger.debug(`   - Orphaned artists: ${report.orphanedArtists}`);
    logger.debug(`   - Old download jobs: ${report.oldDownloadJobs}`);

    return report;
}

// CLI entry point
if (require.main === module) {
    runDataIntegrityCheck()
        .then((report) => {
            logger.debug("\nData integrity check completed successfully");
            process.exit(0);
        })
        .catch((err) => {
            logger.error("\n Data integrity check failed:", err);
            process.exit(1);
        });
}
