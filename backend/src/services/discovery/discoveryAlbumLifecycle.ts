/**
 * Discovery album lifecycle: move liked albums into the library and clear
 * rejected or expired ones (discoverClearing).
 */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';
import { updateArtistCounts } from '../artistCountsService';
import { LIBRARY_LOCATION } from '../libraryFilters';
import { markLibraryChangedQuietly } from '../libraryChanged';
import { forgetOwnedIndex } from './ownedIndexVersion';
import {
    clearOrphanedDiscoverAlbums,
    clearSuggestion,
    clearUnsuggestedDownloads,
    errorReason,
    findDiscoverAlbum,
    reportLidarrFailures,
    reportOrphanFailures,
    type ClearFailure,
} from './discoverClearing';
import { removeDiscoverArtists, type ArtistsTurn } from './discoverArtistCleanup';
import { albumHasPlaylistTrack, discoverEvidence, loadDiscoverRecords } from './discoverEvidence';
import { distributedLock } from '../../utils/distributedLock';
import { LockHeldError } from '../../utils/lockErrors';
import * as downloadJobs from '../downloads/jobs';

/** The lock one clear of a person's Discover holds, so two clears never work on the same albums at once. */
export const clearTurnKey = (userId: string) => `discover:clear:${userId}`;
const CLEAR_TURN_TTL_MS = 60_000;
const CLEAR_TURN_POLL_MS = 250;
/** How long a weekly generation waits for a clear the person started. A clear rarely runs past a few minutes. */
const GENERATION_CLEAR_WAIT_MS = 15 * 60_000;

/**
 * Runs `work` in the person's clear turn, so it never runs during a clear of their Discover (an unlike in the middle of
 * a clear could leave its album in Discover with no suggestion to show it). A running clear makes it throw LockHeldError.
 * `work` gets a signal that aborts if the turn is lost; long work checks it between steps.
 */
export function inClearTurn<T>(userId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return distributedLock.withLock(clearTurnKey(userId), CLEAR_TURN_TTL_MS, work);
}

type ClearSummary = {
    moved: number;
    deleted: number;
    orphansCleared: number;
    lidarrFailed: ClearFailure[];
    unnamedFailed: ClearFailure[];
};

interface DiscoveryAlbumInfo {
    id: string;
    rgMbid: string;
    artistName: string;
    artistMbid: string | null;
    albumTitle: string;
    lidarrAlbumId?: number | null;
}

class DiscoveryAlbumLifecycle {
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
     * Clears this listener's Discover down to what they liked: liked albums move to the library, every other suggestion is
     * cleared, then the downloads, albums, unavailable list, failed downloads and 30-day-old records. Lidarr artists are
     * not touched here: their removal is slow and runs after (discoverArtistCleanup). An album Lidarr did not delete stays and is reported (`lidarrFailed`; `unnamedFailed` for orphans no record names).
     */
    async clearDiscover(userId: string, options: { waitMs?: number } = {}): Promise<ClearSummary> {
        // One clear per person at a time. Without `waitMs` a running clear makes this one throw LockHeldError; with it,
        // this one waits that long for its turn (the weekly generation does, so it never fails over a clear).
        const deadline = Date.now() + (options.waitMs ?? 0);
        for (;;) {
            try {
                return await inClearTurn(userId, (signal) => this.clearUnlocked(userId, signal));
            } catch (error) {
                if (!(error instanceof LockHeldError) || Date.now() >= deadline) throw error;
                await new Promise((resolve) => setTimeout(resolve, CLEAR_TURN_POLL_MS));
            }
        }
    }

    // A lost turn (Redis could not renew it) stops the clear at its next step, so a second clear never overlaps it.
    private async clearUnlocked(userId: string, signal: AbortSignal): Promise<ClearSummary> {
        const suggestions = await prisma.discoveryAlbum.findMany({
            where: { userId, status: { in: ['ACTIVE', 'LIKED'] } },
        });

        let moved = 0;
        for (const album of suggestions.filter((a) => a.status === 'LIKED')) {
            try {
                if (await this.moveLikedAlbumToLibrary(album)) moved++;
            } catch (error: any) {
                logger.error(`[DiscoveryLifecycle] Failed to move ${album.albumTitle}: ${error.message}`);
            }
        }

        // Each clear can be a Lidarr call with a 10 s timeout, so run a few at a time.
        const CLEAR_CONCURRENCY = 5;
        // One clear per album, through its latest week's suggestion: it claims every week's (see clearSuggestion).
        const latest = new Map<string, (typeof suggestions)[number]>();
        for (const a of suggestions) {
            const seen = latest.get(a.rgMbid);
            if (a.status === 'ACTIVE' && a.rgMbid && (!seen || seen.weekStartDate < a.weekStartDate)) latest.set(a.rgMbid, a);
        }
        const active = suggestions.filter((a) => a.status === 'ACTIVE' && (!a.rgMbid || latest.get(a.rgMbid) === a));
        let deleted = 0;
        const lidarrFailed: ClearFailure[] = [];
        for (let i = 0; i < active.length; i += CLEAR_CONCURRENCY) {
            signal.throwIfAborted();
            await Promise.all(
                active.slice(i, i + CLEAR_CONCURRENCY).map(async (album) => {
                    try {
                        const result = await clearSuggestion(album);
                        if (result.outcome === 'cleared') deleted++;
                        if (result.outcome === 'kept') lidarrFailed.push(result.failure);
                    } catch (error: any) {
                        logger.error(`[DiscoveryLifecycle] Failed to delete ${album.albumTitle}: ${error.message}`);
                        lidarrFailed.push({ artistName: album.artistName, albumTitle: album.albumTitle, reason: errorReason(error) });
                    }
                }),
            );
        }

        // Albums Lidarr fetched that no suggestion names (they missed the final playlist).
        signal.throwIfAborted();
        lidarrFailed.push(...(await clearUnsuggestedDownloads(userId)));
        await prisma.unavailableAlbum.deleteMany({ where: { userId } });

        // DISCOVER albums no suggestion covers, left by failed downloads or a failed playlist build. Before the failed
        // download records go: they are what shows such an album is Discover's.
        signal.throwIfAborted();
        const orphans = await clearOrphanedDiscoverAlbums();
        await downloadJobs.remove(
            await prisma.downloadJob.findMany({
                where: { userId, discoveryBatchId: { not: null }, status: 'failed' },
                select: { id: true },
            }),
        );
        const strip = ({ userIds: _named, ...f }: (typeof orphans.failures)[number]): ClearFailure => f;
        lidarrFailed.push(...orphans.failures.filter((f) => f.userIds.includes(userId)).map(strip));
        const unnamedFailed = orphans.failures.filter((f) => f.userIds.length === 0).map(strip);
        await reportOrphanFailures(userId, orphans.failures);

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        await prisma.discoveryAlbum.deleteMany({
            where: { userId, status: { in: ['DELETED', 'MOVED'] }, downloadedAt: { lt: thirtyDaysAgo } },
        });

        return { moved, deleted, orphansCleared: orphans.cleared, lidarrFailed, unnamedFailed };
    }

    /**
     * Before a new generation, Discover is cleared (clearDiscover); what Lidarr kept is reported in the tray. The weekly
     * job is already in the background, so the artist removal runs here, inside the generation's artists turn, before
     * the new week sends anything to Lidarr.
     */
    async processBeforeGeneration(userId: string, artistsTurn: ArtistsTurn): Promise<void> {
        const { lidarrFailed } = await this.clearDiscover(userId, { waitMs: GENERATION_CLEAR_WAIT_MS });
        // A regeneration only retries the suggestions' albums, so it can add to the tray row but not clear it.
        await reportLidarrFailures(userId, lidarrFailed, { complete: false });
        await removeDiscoverArtists(artistsTurn);
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
    forgetOwnedIndex();
    await updateArtistCounts(album.artistId);
    // A client now lists the album.
    await markLibraryChangedQuietly('liked album joined the library');
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
    // Same evidence rule as the scanner and the integrity check: the listener's own download request, or a like on any
    // of the album's suggestions (matched by artist+title as well as release-group id, under both ids the album is
    // recorded by), makes the album theirs. Null evidence is not enough to keep it: Discover download records go after
    // 30 days, and an unliked album with no record goes back by its origin.
    const recorded = await prisma.album.findUnique({
        where: { id: album.id },
        select: { title: true, artist: { select: { name: true, mbid: true } } },
    });
    if (recorded) {
        const records = await loadDiscoverRecords();
        const keptByEvidence = [...new Set([album.rgMbid, suggestedAs])].some((rgMbid) => {
            const evidence = discoverEvidence({ artistName: recorded.artist.name, artistMbid: recorded.artist.mbid, title: recorded.title, rgMbid }, records);
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
    if (moved) {
        forgetOwnedIndex();
        await updateArtistCounts(album.artistId);
        // A client no longer lists the album.
        await markLibraryChangedQuietly('unliked album went back to Discover');
    }
    return moved;
}
