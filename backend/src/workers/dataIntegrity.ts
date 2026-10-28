/**
 * Periodic database cleanup. It deletes only rows that carry no user decision:
 * expired exclusions, orphaned discovery tracks, temp and album-less artists,
 * and notifications older than 30 days. Albums and OwnedAlbum keeps are reported
 * for a human, never deleted.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { relocateDiscoverAlbums } from "../services/discovery/discoverEvidence";

interface IntegrityReport {
    expiredExclusions: number;
    orphanedDiscoveryTracks: number;
    mislocatedAlbums: number;
    orphanedAlbums: number;
    orphanedOwnedAlbums: number;
    consolidatedArtists: number;
    orphanedArtists: number;
    oldNotifications: number;
}

export async function runDataIntegrityCheck(): Promise<IntegrityReport> {
    logger.debug("[DataIntegrity] Running check");

    const report: IntegrityReport = {
        expiredExclusions: 0,
        orphanedDiscoveryTracks: 0,
        mislocatedAlbums: 0,
        orphanedAlbums: 0,
        orphanedOwnedAlbums: 0,
        consolidatedArtists: 0,
        orphanedArtists: 0,
        oldNotifications: 0,
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
    // 2a. Rows explicitly left with no track
    const orphanedDiscoveryTracksNull = await prisma.discoveryTrack.deleteMany({
        where: {
            trackId: null,
        },
    });
    // 2b. Rows whose Track was deleted out from under them. trackId has no FK
    // constraint by design, so deleting a Track never nulls or cascades this
    // out; an anti-join against Track is the only way to catch these.
    const orphanedDiscoveryTracksDangling = await prisma.$executeRaw`
        DELETE FROM "DiscoveryTrack"
        WHERE "trackId" IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM "Track" WHERE "Track".id = "DiscoveryTrack"."trackId"
        )
    `;
    report.orphanedDiscoveryTracks = orphanedDiscoveryTracksNull.count + orphanedDiscoveryTracksDangling;
    if (report.orphanedDiscoveryTracks > 0) {
        logger.debug(
            `     Removed ${report.orphanedDiscoveryTracks} orphaned discovery track records`
        );
    }

    // 3. Report orphaned DISCOVER albums (no active DiscoveryAlbum and no OwnedAlbum)
    const discoverAlbums = await prisma.album.findMany({
        where: { location: "DISCOVER" },
        include: { artist: true },
    });

    if (discoverAlbums.length > 0) {
        // Batch the per-album existence checks (3 * N sequential queries) into a
        // handful of bulk lookups + in-memory Set/Map matching.
        const activeDiscoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: { status: { in: ["ACTIVE", "LIKED", "MOVED"] } },
            select: { rgMbid: true, albumTitle: true, artistName: true },
        });
        const activeRgMbids = new Set(
            activeDiscoveryAlbums.filter((d) => d.rgMbid !== null).map((d) => d.rgMbid as string)
        );
        const hasActiveNullRgMbid = activeDiscoveryAlbums.some((d) => d.rgMbid === null);
        const activeTitleArtistPairs = new Set(
            activeDiscoveryAlbums.map(
                (d) => `${d.albumTitle.toLowerCase().trim()}::${d.artistName.toLowerCase().trim()}`
            )
        );

        const ownedAlbums = await prisma.ownedAlbum.findMany({
            select: { artistId: true, rgMbid: true },
        });
        const ownedArtistRgMbidPairs = new Set(
            ownedAlbums.map((o) => `${o.artistId}::${o.rgMbid ?? "\0"}`)
        );

        const orphanCandidates = discoverAlbums.filter((album) => {
            const hasActiveRecord =
                (album.rgMbid ? activeRgMbids.has(album.rgMbid) : hasActiveNullRgMbid) ||
                activeTitleArtistPairs.has(
                    `${album.title.toLowerCase().trim()}::${album.artist.name.toLowerCase().trim()}`
                );
            const hasOwnedRecord = ownedArtistRgMbidPairs.has(`${album.artistId}::${album.rgMbid ?? "\0"}`);
            return !hasActiveRecord && !hasOwnedRecord;
        });

        if (orphanCandidates.length > 0) {
            // Reported, not deleted: a scan can bring them back.
            for (const album of orphanCandidates) {
                report.orphanedAlbums++;
                logger.warn(
                    `     Orphaned album (kept, needs a decision): ${album.artist.name} - ${album.title}`
                );
            }
        }
    }

    // 4. Move LIBRARY albums that Discover's records say came from Discover to DISCOVER (relocateDiscoverAlbums).
    const mislocatedAlbumsFixed = (await relocateDiscoverAlbums({ dryRun: false })).length;

    report.mislocatedAlbums = mislocatedAlbumsFixed;
    if (mislocatedAlbumsFixed > 0) {
        logger.debug(`     Fixed ${mislocatedAlbumsFixed} mislocated albums`);
    }

    // 5. Report albums with no tracks (their files are gone)
    const emptyAlbums = await prisma.album.findMany({
        where: {
            tracks: { none: {} },
        },
        include: { artist: true },
    });

    for (const album of emptyAlbums) {
        report.orphanedAlbums++;
        logger.warn(
            `     Empty album kept (no tracks, needs a decision): ${album.artist.name} - ${album.title}`
        );
    }

    // 6. Report orphaned OwnedAlbum records (no matching Album record).
    // A keep is a user decision, and a rescan can recreate the Album.
    const orphanedOwnedAlbums = await prisma.$queryRawUnsafe<
        { artistId: string; rgMbid: string | null; source: string }[]
    >(
        `SELECT oa."artistId", oa."rgMbid", oa.source
           FROM "OwnedAlbum" oa
          WHERE NOT EXISTS (
              SELECT 1 FROM "Album" a WHERE a."rgMbid" = oa."rgMbid"
          )`,
    );
    report.orphanedOwnedAlbums = orphanedOwnedAlbums.length;
    if (orphanedOwnedAlbums.length > 0) {
        logger.warn(
            `     Orphaned OwnedAlbum records (kept, need a decision): ${orphanedOwnedAlbums.length}`,
        );
    }

    // 7. Consolidate duplicate artists (same name, one with temp MBID, one with real)
    const tempArtists = await prisma.artist.findMany({
        where: {
            mbid: { startsWith: "temp-" },
        },
        include: { albums: true },
    });

    if (tempArtists.length > 0) {
        // One batched lookup instead of a findFirst per temp artist
        const realArtists = await prisma.artist.findMany({
            where: {
                normalizedName: { in: tempArtists.map((t) => t.normalizedName) },
                mbid: { not: { startsWith: "temp-" } },
            },
        });
        const realArtistByNormalizedName = new Map(
            realArtists.map((a) => [a.normalizedName, a])
        );

        for (const tempArtist of tempArtists) {
            // Find a real artist with the same normalized name
            const realArtist = realArtistByNormalizedName.get(tempArtist.normalizedName);

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

    // 9. Notifications are news, not history: drop anything older than 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const oldNotifications = await prisma.notification.deleteMany({
        where: { createdAt: { lt: thirtyDaysAgo } },
    });
    report.oldNotifications = oldNotifications.count;

    // Summary
    logger.debug(`[DataIntegrity] Check complete: ${JSON.stringify(report)}`);

    return report;
}
