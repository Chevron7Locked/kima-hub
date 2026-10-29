/**
 * The daily database check. It deletes only rows that carry no listener's decision (expired exclusions, orphaned
 * Discover song rows, temp and album-less artists, notifications older than 30 days), moves albums Discover's records
 * say are Discover's (relocateDiscoverAlbums) and merges temp artists into real ones. Albums and OwnedAlbum keeps
 * that look orphaned are only reported.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { lookupKey, relocateDiscoverAlbums } from "../services/discovery/discoverEvidence";

interface IntegrityReport {
    expiredExclusions: number;
    orphanedDiscoveryTracks: number;
    mislocatedAlbums: number;
    orphanedAlbums: number;
    emptyAlbums: number;
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
        emptyAlbums: 0,
        orphanedOwnedAlbums: 0,
        consolidatedArtists: 0,
        orphanedArtists: 0,
        oldNotifications: 0,
    };

    const expiredExclusions = await prisma.discoverExclusion.deleteMany({
        where: {
            expiresAt: { lt: new Date() },
        },
    });
    report.expiredExclusions = expiredExclusions.count;
    if (expiredExclusions.count > 0) {
        logger.debug(`[DataIntegrity] Removed ${expiredExclusions.count} expired exclusions`);
    }

    // Discover song rows with no song, or whose song was deleted: trackId has no foreign key by design, so only an
    // anti-join finds the second kind.
    const orphanedDiscoveryTracksNull = await prisma.discoveryTrack.deleteMany({
        where: {
            trackId: null,
        },
    });
    const orphanedDiscoveryTracksDangling = await prisma.$executeRaw`
        DELETE FROM "DiscoveryTrack"
        WHERE "trackId" IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM "Track" WHERE "Track".id = "DiscoveryTrack"."trackId"
        )
    `;
    report.orphanedDiscoveryTracks = orphanedDiscoveryTracksNull.count + orphanedDiscoveryTracksDangling;
    if (report.orphanedDiscoveryTracks > 0) {
        logger.debug(`[DataIntegrity] Removed ${report.orphanedDiscoveryTracks} orphaned discovery track records`);
    }

    // DISCOVER albums no live suggestion (by id, or artist and title by nameKey) and no keep names: reported, not
    // deleted, since a scan can bring them back.
    const discoverAlbums = await prisma.album.findMany({
        where: { location: "DISCOVER" },
        include: { artist: true },
    });
    if (discoverAlbums.length > 0) {
        const suggestions = await prisma.discoveryAlbum.findMany({
            where: { status: { in: ["ACTIVE", "LIKED", "MOVED"] } },
            select: { rgMbid: true, albumTitle: true, artistName: true },
        });
        const suggestedIds = new Set(suggestions.map((d) => d.rgMbid));
        const suggestedNames = new Set(suggestions.map((d) => lookupKey(d.artistName, d.albumTitle)));
        const kept = new Set(
            (await prisma.ownedAlbum.findMany({ select: { artistId: true, rgMbid: true } })).map((o) => `${o.artistId}::${o.rgMbid}`),
        );
        for (const album of discoverAlbums) {
            const suggested = suggestedIds.has(album.rgMbid) || suggestedNames.has(lookupKey(album.artist.name, album.title));
            if (suggested || kept.has(`${album.artistId}::${album.rgMbid}`)) continue;
            report.orphanedAlbums++;
            logger.warn(`[DataIntegrity] Orphaned album (kept, needs a decision): ${album.artist.name} - ${album.title}`);
        }
    }

    report.mislocatedAlbums = (await relocateDiscoverAlbums({ dryRun: false })).length;
    if (report.mislocatedAlbums > 0) {
        logger.debug(`[DataIntegrity] Moved ${report.mislocatedAlbums} albums Discover's records say are Discover's`);
    }

    // Albums with no songs left: reported, not deleted.
    const emptyAlbums = await prisma.album.findMany({
        where: {
            tracks: { none: {} },
        },
        include: { artist: true },
    });

    report.emptyAlbums = emptyAlbums.length;
    for (const album of emptyAlbums) {
        logger.warn(`[DataIntegrity] Empty album kept (no tracks, needs a decision): ${album.artist.name} - ${album.title}`);
    }

    // Keeps whose album is gone: a keep is a listener's decision and a rescan can bring the album back, so reported.
    const [{ count: orphanedOwnedAlbums }] = await prisma.$queryRaw<[{ count: number }]>`
        SELECT count(*)::int AS count
          FROM "OwnedAlbum" oa
         WHERE NOT EXISTS (SELECT 1 FROM "Album" a WHERE a."rgMbid" = oa."rgMbid")
    `;
    report.orphanedOwnedAlbums = orphanedOwnedAlbums;
    if (orphanedOwnedAlbums > 0) {
        logger.warn(`[DataIntegrity] Orphaned OwnedAlbum records (kept, need a decision): ${orphanedOwnedAlbums}`);
    }

    // An artist with a temp id whose name a real artist has: its albums move to the real one and it goes.
    const tempArtists = await prisma.artist.findMany({
        where: { mbid: { startsWith: "temp-" } },
    });

    if (tempArtists.length > 0) {
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
            const realArtist = realArtistByNormalizedName.get(tempArtist.normalizedName);

            if (realArtist) {
                await prisma.album.updateMany({
                    where: { artistId: tempArtist.id },
                    data: { artistId: realArtist.id },
                });

                await prisma.similarArtist.deleteMany({
                    where: { OR: [{ fromArtistId: tempArtist.id }, { toArtistId: tempArtist.id }] },
                });
                await prisma.artist.delete({
                    where: { id: tempArtist.id },
                });

                report.consolidatedArtists++;
                logger.debug(`[DataIntegrity] Merged temp artist "${tempArtist.name}" into the real one`);
            }
        }
    }

    // Artists with no albums go, with their similar-artist links.
    const orphanedArtistIds = (
        await prisma.artist.findMany({ where: { albums: { none: {} } }, select: { id: true } })
    ).map((a) => a.id);
    if (orphanedArtistIds.length > 0) {
        await prisma.similarArtist.deleteMany({
            where: { OR: [{ fromArtistId: { in: orphanedArtistIds } }, { toArtistId: { in: orphanedArtistIds } }] },
        });
        await prisma.artist.deleteMany({ where: { id: { in: orphanedArtistIds } } });
        report.orphanedArtists = orphanedArtistIds.length;
    }

    // Notifications are news, not history: anything older than 30 days goes.
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const oldNotifications = await prisma.notification.deleteMany({
        where: { createdAt: { lt: thirtyDaysAgo } },
    });
    report.oldNotifications = oldNotifications.count;

    logger.debug(`[DataIntegrity] Check complete: ${JSON.stringify(report)}`);

    return report;
}
