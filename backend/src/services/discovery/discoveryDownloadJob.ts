import type { Prisma } from '@prisma/client';
import * as downloadJobs from '../downloads/jobs';

interface DiscoveryJobAlbum {
    artistName: string;
    artistMbid?: string | null;
    albumTitle: string;
    albumMbid: string;
    tier?: string;
}

export interface DiscoveryDownloadJobInput {
    userId: string;
    batchId: string;
    musicPath: string;
    album: DiscoveryJobAlbum;
    similarity: number;
    extraMetadata?: Prisma.InputJsonObject;
}

export function createDiscoveryDownloadJob(
    tx: Prisma.TransactionClient,
    { userId, batchId, musicPath, album, similarity, extraMetadata }: DiscoveryDownloadJobInput
) {
    return downloadJobs.create(
        {
            userId,
            subject: `${album.artistName} - ${album.albumTitle}`,
            type: 'album',
            targetMbid: album.albumMbid,
            discoveryBatchId: batchId,
            artistMbid: album.artistMbid,
            metadata: {
                downloadType: 'discovery',
                rootFolderPath: musicPath,
                artistName: album.artistName,
                artistMbid: album.artistMbid,
                albumTitle: album.albumTitle,
                albumMbid: album.albumMbid,
                similarity,
                tier: album.tier,
                ...extraMetadata,
            },
        },
        tx
    );
}
