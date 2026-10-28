/**
 * Discovery album lifecycle: move liked albums into the library and clear
 * rejected or expired ones (discoverClearing).
 */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { updateArtistCounts } from '../artistCountsService';
import { LIBRARY_LOCATION } from '../libraryFilters';
import { clearSuggestion, errorReason, findDiscoverAlbum, reportLidarrFailures, type ClearFailure } from './discoverClearing';
import { albumHasPlaylistTrack, discoverEvidence, loadDiscoverRecords } from './discoverEvidence';

export interface DiscoveryAlbumInfo {
    id: string;
    rgMbid: string;
    artistName: string;
    albumTitle: string;
    lidarrAlbumId?: number | null;
}

export class DiscoveryAlbumLifecycle {
    /**
     * Moves a LIKED suggestion's DISCOVER album to the LIBRARY (takeIntoLibrary) and marks the suggestion MOVED. The album is
     * found the way a clear finds it, so a listener's own copy of the same name is never the one moved. Returns whether
     * an album moved.
     */
    async moveLikedAlbumToLibrary(album: DiscoveryAlbumInfo): Promise<boolean> {
        const dbAlbum = await findDiscoverAlbum(album);
        if (dbAlbum) {
            await takeIntoLibrary(dbAlbum);
            logger.debug(`[DiscoveryLifecycle] Moved to library: ${album.artistName} - ${album.albumTitle}`);
        }

        await prisma.discoveryAlbum.update({
            where: { id: album.id },
            data: { status: 'MOVED' },
        });
        return dbAlbum !== null;
    }

    /**
     * Before a new generation: liked albums move to the library, active ones are cleared (clearSuggestion), and the user's
     * unavailable albums are cleared. An album Lidarr did not delete stays in Discover and is reported in the tray.
     */
    async processBeforeGeneration(userId: string): Promise<{ moved: number; deleted: number; lidarrFailed: ClearFailure[] }> {
        logger.debug(`[DiscoveryLifecycle] Processing previous discovery albums...`);

        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ['ACTIVE', 'LIKED'] },
            },
        });

        const likedAlbums = discoveryAlbums.filter((a) => a.status === 'LIKED');
        const activeAlbums = discoveryAlbums.filter((a) => a.status === 'ACTIVE');

        let moved = 0;
        let deleted = 0;
        const lidarrFailed: ClearFailure[] = [];

        for (const album of likedAlbums) {
            try {
                if (await this.moveLikedAlbumToLibrary(album)) moved++;
            } catch (error: any) {
                logger.error(
                    `[DiscoveryLifecycle] Failed to move ${album.albumTitle}: ${error.message}`
                );
            }
        }

        // Each clear can be a Lidarr call with a 10 s timeout, so run a few at a time.
        const CLEAR_CONCURRENCY = 5;
        for (let i = 0; i < activeAlbums.length; i += CLEAR_CONCURRENCY) {
            const chunk = activeAlbums.slice(i, i + CLEAR_CONCURRENCY);
            await Promise.all(
                chunk.map(async (album) => {
                    try {
                        const result = await clearSuggestion(album);
                        if (result.outcome === 'cleared') deleted++;
                        if (result.outcome === 'kept') lidarrFailed.push(result.failure);
                    } catch (error: any) {
                        logger.error(
                            `[DiscoveryLifecycle] Failed to delete ${album.albumTitle}: ${error.message}`
                        );
                        lidarrFailed.push({ artistName: album.artistName, albumTitle: album.albumTitle, reason: errorReason(error) });
                    }
                })
            );
        }

        await prisma.unavailableAlbum.deleteMany({ where: { userId } });
        // A regeneration only retries the suggestions' albums, so it can add to the tray row but not clear it.
        await reportLidarrFailures(userId, lidarrFailed, { complete: false });

        logger.debug(`[DiscoveryLifecycle] Previous discovery cleanup complete`);

        return { moved, deleted, lidarrFailed };
    }
}

export const discoveryAlbumLifecycle = new DiscoveryAlbumLifecycle();

/**
 * A liked Discover album joins the library: its location, an OwnedAlbum row (source discovery_liked), the artist's
 * counts, and an enrichment cycle, which now picks up its songs. Discover songs go through enrichment only from here.
 */
export async function takeIntoLibrary(album: { id: string; artistId: string; rgMbid: string }): Promise<void> {
    // One step: a scan in between would see a library album with no like's mark and mark it as the scan's.
    await prisma.$transaction([
        prisma.album.update({ where: { id: album.id }, data: { location: LIBRARY_LOCATION } }),
        prisma.ownedAlbum.upsert({
            where: { artistId_rgMbid: { artistId: album.artistId, rgMbid: album.rgMbid } },
            create: { artistId: album.artistId, rgMbid: album.rgMbid, source: 'discovery_liked' },
            update: {},
        }),
    ]);
    await updateArtistCounts(album.artistId);
    // Imported when needed: the enrichment worker imports half the services, this module among them.
    void import('../../workers/unifiedEnrichment')
        .then(({ triggerEnrichmentNow }) => triggerEnrichmentNow())
        .catch((error) => logger.warn('[DiscoveryLifecycle] Enrichment after a like did not start:', error));
}

/**
 * An unliked Discover album goes back to Discover, with the ownership its like gave it, unless another listener's like
 * still keeps it. `suggestedAs` is the release-group id the suggestion carries, which can differ from the scanned
 * album's.
 */
export async function returnToDiscover(
    album: { id: string; artistId: string; rgMbid: string },
    suggestedAs: string = album.rgMbid,
): Promise<boolean> {
    // Only an album a like brought into the library goes back: the like left its mark on it (takeIntoLibrary). An album
    // the listener already had keeps its own ownership row, which a like does not replace.
    const broughtByLike = await prisma.ownedAlbum.count({
        where: { artistId: album.artistId, rgMbid: album.rgMbid, source: 'discovery_liked' },
    });
    if (broughtByLike === 0) return false;
    const likedElsewhere = await prisma.discoveryAlbum.count({
        where: { rgMbid: { in: [...new Set([album.rgMbid, suggestedAs])] }, status: { in: ['LIKED', 'MOVED'] } },
    });
    if (likedElsewhere > 0) return false;
    // The same evidence rule the scanner and the integrity check use: a listener's own download request, or a
    // like on any of the album's suggestions, makes the album theirs, so undoing a Discover like does not take
    // it back. The evidence matches by artist+title as well as by release-group id, so a LIKED suggestion
    // recorded under a different id keeps the album too. Checked under both ids the album is recorded by: its
    // own release-group id and the one the suggestion carried. Null evidence is not enough to keep it: a
    // Discover download record is deleted after 30 days, and an unliked album with no record goes back by its
    // origin.
    const recorded = await prisma.album.findUnique({
        where: { id: album.id },
        select: { title: true, artist: { select: { name: true } } },
    });
    if (recorded) {
        const records = await loadDiscoverRecords();
        const keptByEvidence = [...new Set([album.rgMbid, suggestedAs])].some((rgMbid) => {
            const evidence = discoverEvidence({ artistName: recorded.artist.name, title: recorded.title, rgMbid }, records);
            return evidence === "liked" || evidence === "requested";
        });
        if (keptByEvidence) return false;
    }
    // A playlist holding any of its songs is the listener's own act, which keeps the album in the library.
    if (await albumHasPlaylistTrack(album.id)) return false;
    const moved = await prisma.$transaction(async (tx) => {
        const updated = await tx.album.updateMany({
            where: { id: album.id, location: LIBRARY_LOCATION },
            data: { location: 'DISCOVER' },
        });
        if (updated.count > 0) {
            await tx.ownedAlbum.deleteMany({ where: { artistId: album.artistId, rgMbid: album.rgMbid } });
        }
        return updated.count > 0;
    });
    if (moved) await updateArtistCounts(album.artistId);
    return moved;
}
