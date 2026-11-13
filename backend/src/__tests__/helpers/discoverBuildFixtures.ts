/**
 * Rows for tests of the Discover playlist build on the real database: a scanning batch, the completed download jobs
 * Lidarr finished for it, and the songs the scan filed on Discover albums. Every id starts with the file's own prefix,
 * so a file cleans up only what it made.
 */
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../../services/artistIdentity";

export const BUILD_WEEK = new Date("2026-11-02T00:00:00.000Z");

export interface JobSeed {
    artistName: string;
    albumTitle: string;
    albumMbid?: string;
    lidarrAlbumId?: number;
    similarity?: number;
    tier?: string;
}

export interface ScannedSeed {
    artistName: string;
    albumTitle: string;
    rgMbid: string;
}

export function discoverBuildFixtures(prefix: string) {
    const userId = `${prefix}user`;

    /** Removes everything this file's rows hang from; batches, jobs, suggestions and exclusions go with the user. */
    async function wipe() {
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.track.deleteMany({ where: { id: { startsWith: prefix } } });
        await prisma.album.deleteMany({ where: { id: { startsWith: prefix } } });
        await prisma.artist.deleteMany({ where: { id: { startsWith: prefix } } });
    }

    /** A batch (its id starts with the file's prefix) that is scanning, with one completed download job per entry of `jobs`. */
    async function seedScanningBatch(batchId: string, jobs: JobSeed[]) {
        await prisma.user.upsert({
            where: { id: userId },
            create: { id: userId, username: userId, passwordHash: "x" },
            update: {},
        });
        await prisma.discoveryBatch.create({
            data: { id: batchId, userId, weekStart: BUILD_WEEK, targetSongCount: 30, status: "scanning" },
        });
        let n = 0;
        for (const job of jobs) {
            n += 1;
            await prisma.downloadJob.create({
                data: {
                    id: `${batchId}-job-${n}`,
                    userId,
                    subject: `${job.artistName} - ${job.albumTitle}`,
                    type: "album",
                    status: "completed",
                    discoveryBatchId: batchId,
                    targetMbid: job.albumMbid,
                    lidarrAlbumId: job.lidarrAlbumId,
                    metadata: {
                        artistName: job.artistName,
                        albumTitle: job.albumTitle,
                        albumMbid: job.albumMbid,
                        similarity: job.similarity,
                        tier: job.tier,
                    },
                },
            });
        }
    }

    /** A playable song on a Discover album, named as the scan read the files. */
    async function seedDiscoverSong(batchId: string, scanned: ScannedSeed) {
        const artistId = `${batchId}-art`;
        const albumId = `${batchId}-alb`;
        await prisma.artist.create({
            data: { id: artistId, name: scanned.artistName, identityKey: artistIdentityKey(scanned.artistName) },
        });
        await prisma.album.create({
            data: {
                id: albumId, artistId, title: scanned.albumTitle, identityKey: albumId,
                rgMbid: scanned.rgMbid, primaryType: "Album", location: "DISCOVER",
            },
        });
        await prisma.track.create({
            data: {
                id: `${batchId}-t1`, albumId, title: "T", trackNo: 1, duration: 200,
                filePath: `/m/${batchId}/t1.flac`, fileModified: new Date(), fileSize: 1000,
            },
        });
    }

    const batch = (batchId: string) => prisma.discoveryBatch.findUnique({ where: { id: batchId } });

    return { userId, wipe, seedScanningBatch, seedDiscoverSong, batch };
}
