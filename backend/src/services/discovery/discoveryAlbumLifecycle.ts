/**
 * Discovery album lifecycle: move liked albums into the library and delete
 * rejected or expired ones from the database and Lidarr.
 */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { updateArtistCounts } from '../artistCountsService';
import { LIBRARY_LOCATION } from '../libraryFilters';
import { removeDiscoveryAlbum } from './lidarrRemoval';
import { announcePlaylistsChanged, playlistsHoldingTracks } from '../playlistEvents';

export interface DiscoveryAlbumInfo {
    id: string;
    rgMbid: string;
    artistName: string;
    albumTitle: string;
    lidarrAlbumId?: number | null;
}

export class DiscoveryAlbumLifecycle {
    /** Moves a LIKED discovery album to the LIBRARY: its location, an OwnedAlbum row and the artist's counts. */
    async moveLikedAlbumToLibrary(album: DiscoveryAlbumInfo): Promise<void> {
        const dbAlbum = await prisma.album.findFirst({
            where: { rgMbid: album.rgMbid },
            include: { artist: true },
        });

        if (dbAlbum) {
            await prisma.album.update({
                where: { id: dbAlbum.id },
                data: { location: LIBRARY_LOCATION },
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
                    source: 'discovery_liked',
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
     * Deletes a rejected discovery album: its Lidarr album through the identity
     * check in lidarrRemoval, then its tracks and rows, marking it DELETED.
     */
    async deleteRejectedAlbum(album: DiscoveryAlbumInfo): Promise<void> {
        // Claiming the row before touching files means a like either lands first and
        // keeps the album, or finds it DELETED and is refused; never a liked album
        // whose files are gone.
        const claimed = await prisma.discoveryAlbum.updateMany({
            where: { id: album.id, status: 'ACTIVE' },
            data: { status: 'DELETED' },
        });
        if (claimed.count === 0) {
            logger.debug(
                `[DiscoveryLifecycle] Skipped delete -- ${album.albumTitle} no longer ACTIVE (liked?)`
            );
            return;
        }

        if (album.lidarrAlbumId) {
            await removeDiscoveryAlbum(album.lidarrAlbumId, album.rgMbid);
        }

        const playlists = await prisma.$transaction(async (tx) => {
            // Only DISCOVER albums: a LIBRARY album with the same rgMbid is never deleted here.
            const dbAlbum = await tx.album.findFirst({
                where: { rgMbid: album.rgMbid, location: 'DISCOVER' },
            });
            // The songs' playlist entries go with them: told once the transaction commits.
            const holding = dbAlbum ? await playlistsHoldingTracks(tx, { albumId: dbAlbum.id }) : [];
            if (dbAlbum) {
                await tx.track.deleteMany({ where: { albumId: dbAlbum.id } });
                await tx.album.delete({ where: { id: dbAlbum.id } });
            }
            await tx.discoveryTrack.deleteMany({
                where: { discoveryAlbumId: album.id },
            });
            return holding;
        });
        announcePlaylistsChanged(playlists);

        logger.debug(
            `[DiscoveryLifecycle] Deleted: ${album.artistName} - ${album.albumTitle}`
        );
    }

    /** Before a new generation: liked albums move to the library, active ones are deleted, and the user's unavailable albums are cleared. */
    async processBeforeGeneration(userId: string): Promise<{ moved: number; deleted: number }> {
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

        // Each delete is a Lidarr call with a 10 s timeout, so run a few at a time.
        const DELETE_CONCURRENCY = 5;
        for (let i = 0; i < activeAlbums.length; i += DELETE_CONCURRENCY) {
            const chunk = activeAlbums.slice(i, i + DELETE_CONCURRENCY);
            await Promise.all(
                chunk.map(async (album) => {
                    try {
                        await this.deleteRejectedAlbum({
                            id: album.id,
                            rgMbid: album.rgMbid,
                            artistName: album.artistName,
                            albumTitle: album.albumTitle,
                            lidarrAlbumId: album.lidarrAlbumId,
                        });
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
