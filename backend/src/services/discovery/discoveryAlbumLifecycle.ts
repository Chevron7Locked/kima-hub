/**
 * Discovery Album Lifecycle Module
 *
 * Handles lifecycle management for discovery albums:
 * - Moving liked albums to permanent library
 * - Deleting rejected/active albums from DB and Lidarr
 * - Processing albums before new discovery generation
 */

import axios from 'axios';
import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { updateArtistCounts } from '../artistCountsService';

export interface DiscoveryAlbumInfo {
    id: string;
    rgMbid: string;
    artistName: string;
    albumTitle: string;
    lidarrAlbumId?: number | null;
}

export interface LidarrSettings {
    lidarrEnabled?: boolean;
    lidarrUrl?: string;
    lidarrApiKey?: string;
}

export class DiscoveryAlbumLifecycle {
    /**
     * Moves a LIKED discovery album to the permanent LIBRARY.
     * Updates album location, creates OwnedAlbum record, updates artist counts.
     */
    async moveLikedAlbumToLibrary(album: DiscoveryAlbumInfo): Promise<void> {
        const dbAlbum = await prisma.album.findFirst({
            where: { rgMbid: album.rgMbid },
            include: { artist: true },
        });

        if (dbAlbum) {
            await prisma.album.update({
                where: { id: dbAlbum.id },
                data: { location: 'LIBRARY' },
            });

            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: dbAlbum.artistId,
                        rgMbid: dbAlbum.rgMbid,
                    },
                },
                create: {
                    artistId: dbAlbum.artistId,
                    rgMbid: dbAlbum.rgMbid,
                    source: 'discover_liked',
                },
                update: {},
            });

            await updateArtistCounts(dbAlbum.artistId);

            logger.debug(
                `[DiscoveryLifecycle] Moved to library: ${album.artistName} - ${album.albumTitle}`
            );
        }

        await prisma.discoveryAlbum.update({
            where: { id: album.id },
            data: { status: 'MOVED' },
        });
    }

    /**
     * Deletes a rejected/active discovery album.
     * Removes from Lidarr (if enabled), deletes tracks and album from DB,
     * deletes discovery tracks, marks as DELETED.
     */
    async deleteRejectedAlbum(
        album: DiscoveryAlbumInfo,
        settings: LidarrSettings
    ): Promise<void> {
        // Cheap read-only pre-check before any destructive action. If the user
        // liked this album after the cleanup snapshot was taken, its status is no
        // longer ACTIVE -- skip the Lidarr file delete and the DB deletes entirely.
        // This guards the FILES: the in-transaction claim below only guards DB
        // rows, and the Lidarr HTTP delete must stay outside the transaction (so a
        // Lidarr timeout cannot roll back the claim). Without this pre-check a
        // like landing during the Lidarr round-trip would lose its files while the
        // claim left the row LIKED. The window is now one DB read, not an HTTP
        // round-trip; the in-tx claim closes the residual race on the row itself.
        const current = await prisma.discoveryAlbum.findUnique({
            where: { id: album.id },
            select: { status: true },
        });
        if (!current || current.status !== 'ACTIVE') {
            logger.debug(
                `[DiscoveryLifecycle] Skipped delete (pre-check) -- ${album.albumTitle} no longer ACTIVE (liked?)`
            );
            return;
        }

        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey &&
            album.lidarrAlbumId
        ) {
            try {
                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                    {
                        params: { deleteFiles: true },
                        headers: { 'X-Api-Key': settings.lidarrApiKey },
                        timeout: 10000,
                    }
                );
            } catch (lidarrError: any) {
                if (lidarrError.response?.status !== 404) {
                    logger.debug(
                        `[DiscoveryLifecycle] Lidarr delete failed: ${lidarrError.message}`
                    );
                }
            }
        }

        await prisma.$transaction(async (tx) => {
            // Claim the row atomically: only delete if it is still ACTIVE.
            // If the user liked it concurrently, count === 0 and we abort.
            const claimed = await tx.discoveryAlbum.updateMany({
                where: { id: album.id, status: 'ACTIVE' },
                data: { status: 'DELETED' },
            });
            if (claimed.count === 0) {
                logger.debug(
                    `[DiscoveryLifecycle] Skipped delete -- ${album.albumTitle} no longer ACTIVE (liked?)`
                );
                return;
            }
            // Read the owned Album inside the tx (after the claim) so the read and
            // the deletes share one snapshot and only DISCOVER albums are touched
            // -- a same-rgMbid LIBRARY album must never be deleted here.
            // AlbumLocation is a non-null enum of exactly {LIBRARY, DISCOVER}
            // (schema.prisma:882, default LIBRARY), so this filter cannot skip a
            // null-location row -- none exist. The only intentionally-skipped case
            // is a discovery album mislabeled LIBRARY; protecting genuine LIBRARY
            // albums from deletion outweighs leaving that benign Album row behind
            // (its DiscoveryAlbum/DiscoveryTrack rows are still cleaned). rgMbid
            // alone cannot distinguish the two, so we err toward never destroying
            // library data.
            const dbAlbum = await tx.album.findFirst({
                where: { rgMbid: album.rgMbid, location: 'DISCOVER' },
            });
            if (dbAlbum) {
                await tx.track.deleteMany({ where: { albumId: dbAlbum.id } });
                await tx.album.delete({ where: { id: dbAlbum.id } });
            }
            await tx.discoveryTrack.deleteMany({
                where: { discoveryAlbumId: album.id },
            });
        });

        logger.debug(
            `[DiscoveryLifecycle] Deleted: ${album.artistName} - ${album.albumTitle}`
        );
    }

    /**
     * Processes all previous discovery albums before generating new ones.
     * - LIKED albums are moved to library
     * - ACTIVE albums are deleted
     * - Cleans up unavailable albums for user
     */
    async processBeforeGeneration(
        userId: string,
        settings: LidarrSettings
    ): Promise<{ moved: number; deleted: number }> {
        logger.debug(`[DiscoveryLifecycle] Processing previous discovery albums...`);

        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ['ACTIVE', 'LIKED'] },
            },
        });

        if (discoveryAlbums.length === 0) {
            logger.debug(`[DiscoveryLifecycle] No previous discovery albums to process`);
            await prisma.unavailableAlbum.deleteMany({ where: { userId } });
            return { moved: 0, deleted: 0 };
        }

        const likedAlbums = discoveryAlbums.filter((a) => a.status === 'LIKED');
        const activeAlbums = discoveryAlbums.filter((a) => a.status === 'ACTIVE');

        logger.debug(
            `[DiscoveryLifecycle] Found ${likedAlbums.length} liked albums to keep`
        );
        logger.debug(
            `[DiscoveryLifecycle] Found ${activeAlbums.length} non-liked albums to remove`
        );

        let moved = 0;
        let deleted = 0;

        for (const album of likedAlbums) {
            try {
                await this.moveLikedAlbumToLibrary({
                    id: album.id,
                    rgMbid: album.rgMbid,
                    artistName: album.artistName,
                    albumTitle: album.albumTitle,
                    lidarrAlbumId: album.lidarrAlbumId,
                });
                moved++;
            } catch (error: any) {
                logger.error(
                    `[DiscoveryLifecycle] Failed to move ${album.albumTitle}: ${error.message}`
                );
            }
        }

        // Each delete does an axios call to Lidarr with a 10s timeout; running
        // them fully serially made cleanup of a large batch take minutes. Run
        // in small bounded-concurrency chunks instead of one at a time (DISC-13).
        const DELETE_CONCURRENCY = 5;
        for (let i = 0; i < activeAlbums.length; i += DELETE_CONCURRENCY) {
            const chunk = activeAlbums.slice(i, i + DELETE_CONCURRENCY);
            await Promise.all(
                chunk.map(async (album) => {
                    try {
                        await this.deleteRejectedAlbum(
                            {
                                id: album.id,
                                rgMbid: album.rgMbid,
                                artistName: album.artistName,
                                albumTitle: album.albumTitle,
                                lidarrAlbumId: album.lidarrAlbumId,
                            },
                            settings
                        );
                        deleted++;
                    } catch (error: any) {
                        logger.error(
                            `[DiscoveryLifecycle] Failed to delete ${album.albumTitle}: ${error.message}`
                        );
                    }
                })
            );
        }

        await prisma.unavailableAlbum.deleteMany({ where: { userId } });

        logger.debug(`[DiscoveryLifecycle] Previous discovery cleanup complete`);

        return { moved, deleted };
    }
}

export const discoveryAlbumLifecycle = new DiscoveryAlbumLifecycle();
