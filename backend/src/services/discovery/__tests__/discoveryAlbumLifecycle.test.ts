import { DiscoveryAlbumLifecycle, DiscoveryAlbumInfo } from '../discoveryAlbumLifecycle';
import { prisma } from '../../../utils/db';
import { removeDiscoveryAlbum } from '../lidarrRemoval';
import { updateArtistCounts } from '../../artistCountsService';

jest.mock('../../../utils/db', () => ({
    prisma: {
        album: {
            findFirst: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        ownedAlbum: {
            upsert: jest.fn(),
        },
        discoveryAlbum: {
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        track: {
            deleteMany: jest.fn(),
        },
        // Which playlists held the album's songs (read before they are deleted): none here.
        playlistItem: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        discoveryTrack: {
            deleteMany: jest.fn(),
        },
        unavailableAlbum: {
            deleteMany: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

jest.mock('../lidarrRemoval', () => ({ removeDiscoveryAlbum: jest.fn() }));
jest.mock('../../artistCountsService', () => ({
    updateArtistCounts: jest.fn(),
}));

const mockRemoveAlbum = removeDiscoveryAlbum as jest.Mock;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockUpdateArtistCounts = updateArtistCounts as jest.Mock;

describe('DiscoveryAlbumLifecycle', () => {
    let lifecycle: DiscoveryAlbumLifecycle;

    beforeEach(() => {
        jest.clearAllMocks();
        lifecycle = new DiscoveryAlbumLifecycle();
        (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
            cb(mockPrisma)
        );
    });

    describe('moveLikedAlbumToLibrary', () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: 'discovery-album-1',
            rgMbid: 'rg-mbid-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: 456,
        };

        it('should update album location to LIBRARY', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.album.update).toHaveBeenCalledWith({
                where: { id: 'album-db-1' },
                data: { location: 'LIBRARY' },
            });
        });

        it('should create OwnedAlbum record', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.ownedAlbum.upsert).toHaveBeenCalledWith({
                where: {
                    artistId_rgMbid: {
                        artistId: 'artist-1',
                        rgMbid: 'rg-mbid-123',
                    },
                },
                create: {
                    artistId: 'artist-1',
                    rgMbid: 'rg-mbid-123',
                    source: 'discovery_liked',
                },
                update: {},
            });
        });

        it('should update artist counts after move', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockUpdateArtistCounts).toHaveBeenCalledWith('artist-1');
        });

        it('should mark discovery album as MOVED', async () => {
            const dbAlbum = {
                id: 'album-db-1',
                artistId: 'artist-1',
                rgMbid: 'rg-mbid-123',
            };

            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1' },
                data: { status: 'MOVED' },
            });
        });

        it('should still mark as MOVED even if album not found in DB', async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});

            await lifecycle.moveLikedAlbumToLibrary(mockAlbum);

            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1' },
                data: { status: 'MOVED' },
            });
            expect(mockPrisma.album.update).not.toHaveBeenCalled();
        });

        it('should throw error when operation fails', async () => {
            (mockPrisma.album.findFirst as jest.Mock).mockRejectedValue(new Error('DB Error'));

            await expect(lifecycle.moveLikedAlbumToLibrary(mockAlbum)).rejects.toThrow('DB Error');
        });
    });

    describe('deleteRejectedAlbum', () => {
        const mockAlbum: DiscoveryAlbumInfo = {
            id: 'discovery-album-1',
            rgMbid: 'rg-mbid-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: 456,
        };


        it('removes the album from Lidarr through the identity check', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockRemoveAlbum).toHaveBeenCalledWith(456, 'rg-mbid-123');
        });

        it('should skip Lidarr deletion when album has no lidarrAlbumId', async () => {
            const albumWithoutLidarr: DiscoveryAlbumInfo = {
                ...mockAlbum,
                lidarrAlbumId: null,
            };
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(albumWithoutLidarr);

            expect(mockRemoveAlbum).not.toHaveBeenCalled();
        });

        it('still clears the rows when Lidarr keeps the files', async () => {
            mockRemoveAlbum.mockResolvedValue(false);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalled();
        });

        it('should delete tracks and album from database', async () => {
            const dbAlbum = { id: 'album-db-1' };
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.track.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.album.delete as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.track.deleteMany).toHaveBeenCalledWith({
                where: { albumId: 'album-db-1' },
            });
            expect(mockPrisma.album.delete).toHaveBeenCalledWith({
                where: { id: 'album-db-1' },
            });
        });

        it('should delete discovery track records', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.discoveryTrack.deleteMany).toHaveBeenCalledWith({
                where: { discoveryAlbumId: 'discovery-album-1' },
            });
        });

        it('should mark discovery album as DELETED via the conditional claim', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(mockAlbum);

            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: 'discovery-album-1', status: 'ACTIVE' },
                data: { status: 'DELETED' },
            });
        });

        it('should throw error when database operation fails', async () => {
            mockRemoveAlbum.mockResolvedValue(true);
            // Claim succeeds so execution reaches the owned-album read inside the
            // transaction, where the DB error is raised and must propagate out.
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockRejectedValue(new Error('DB Error'));

            await expect(lifecycle.deleteRejectedAlbum(mockAlbum)).rejects.toThrow('DB Error');
        });
    });

    describe('deleteRejectedAlbum when a like races the cleanup', () => {
        const album: DiscoveryAlbumInfo = {
            id: 'da-1',
            rgMbid: 'rg-123',
            artistName: 'Test Artist',
            albumTitle: 'Test Album',
            lidarrAlbumId: 99,
        };

        it('leaves the files and rows alone when the like landed first', async () => {
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

            await lifecycle.deleteRejectedAlbum(album);

            expect(mockRemoveAlbum).not.toHaveBeenCalled();
            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
            expect(mockPrisma.discoveryAlbum.update).not.toHaveBeenCalled();
        });

        it('claims the album before removing its files and rows', async () => {
            const order: string[] = [];
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockImplementation(async () => {
                order.push('claim');
                return { count: 1 };
            });
            mockRemoveAlbum.mockImplementation(async () => {
                order.push('lidarr');
                return true;
            });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({ id: 'alb-1', rgMbid: 'rg-123' });
            (mockPrisma.track.deleteMany as jest.Mock).mockImplementation(async () => {
                order.push('tracks');
                return {};
            });
            (mockPrisma.album.delete as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.deleteRejectedAlbum(album);

            expect(order).toEqual(['claim', 'lidarr', 'tracks']);
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledTimes(1);
            expect(mockPrisma.discoveryAlbum.update).not.toHaveBeenCalled();
        });
    });

    describe('processBeforeGeneration', () => {
        const userId = 'user-123';

        it('should return early when no discovery albums exist', async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result).toEqual({ moved: 0, deleted: 0 });
            expect(mockPrisma.album.findFirst).not.toHaveBeenCalled();
        });

        it('should process liked albums and mark them as moved', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'LIKED',
                    lidarrAlbumId: 100,
                },
            ];
            const dbAlbum = { id: 'album-1', artistId: 'artist-1', rgMbid: 'rg-1' };

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result.moved).toBe(1);
            expect(mockPrisma.discoveryAlbum.update).toHaveBeenCalledWith({
                where: { id: 'da-1' },
                data: { status: 'MOVED' },
            });
        });

        it('should process active albums and delete them', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'ACTIVE',
                    lidarrAlbumId: 100,
                },
            ];

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            mockRemoveAlbum.mockResolvedValue(true);
            (mockPrisma.discoveryAlbum.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result.deleted).toBe(1);
            expect(mockPrisma.discoveryAlbum.updateMany).toHaveBeenCalledWith({
                where: { id: 'da-1', status: 'ACTIVE' },
                data: { status: 'DELETED' },
            });
        });

        it('should clean up unavailable albums for user', async () => {
            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue([]);
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});

            await lifecycle.processBeforeGeneration(userId);

            expect(mockPrisma.unavailableAlbum.deleteMany).toHaveBeenCalledWith({
                where: { userId },
            });
        });

        it('should continue processing even when individual album fails', async () => {
            const discoveryAlbums = [
                {
                    id: 'da-1',
                    rgMbid: 'rg-1',
                    artistName: 'Artist 1',
                    albumTitle: 'Album 1',
                    status: 'LIKED',
                    lidarrAlbumId: 100,
                },
                {
                    id: 'da-2',
                    rgMbid: 'rg-2',
                    artistName: 'Artist 2',
                    albumTitle: 'Album 2',
                    status: 'LIKED',
                    lidarrAlbumId: 101,
                },
            ];
            const dbAlbum = { id: 'album-2', artistId: 'artist-2', rgMbid: 'rg-2' };

            (mockPrisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValue(discoveryAlbums);
            (mockPrisma.album.findFirst as jest.Mock)
                .mockRejectedValueOnce(new Error('DB Error'))
                .mockResolvedValueOnce(dbAlbum);
            (mockPrisma.album.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.ownedAlbum.upsert as jest.Mock).mockResolvedValue({});
            (mockPrisma.discoveryAlbum.update as jest.Mock).mockResolvedValue({});
            (mockPrisma.unavailableAlbum.deleteMany as jest.Mock).mockResolvedValue({});
            mockUpdateArtistCounts.mockResolvedValue(undefined);

            const result = await lifecycle.processBeforeGeneration(userId);

            expect(result.moved).toBe(1);
        });
    });
});
