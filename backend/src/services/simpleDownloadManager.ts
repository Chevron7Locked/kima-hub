/**
 * Album downloads with automatic retry, blocklisting and completion tracking. Holds no
 * in-memory state: the database is the single source of truth, so it survives restarts.
 */

import { logger } from "../utils/logger";
import { retryOnConflict } from "../utils/dbConflict";
import { prisma } from "../utils/db";
import { Prisma, PrismaClient } from "@prisma/client";
import { lidarrService, AcquisitionError, AcquisitionErrorType, albumComplete, downloadProgress, type ReconciliationSnapshot } from "./lidarr";
import { musicBrainzService } from "./musicbrainz";
import { getSystemSettings } from "../utils/systemSettings";
import * as downloadJobs from "./downloads/jobs";
import { requestScan } from "../workers/scanRequest";
import { config } from "../config";
import * as crypto from "crypto";
import { activeDownloads } from "../utils/metrics";
import { sourcePauseController } from "./sourcePauseController";
import { isRateLimited } from "./enrichmentErrorCodeClassifier";
import { failureCause } from "../utils/outcome";
import { ensureDiscoverTag } from "./discovery/lidarrRemoval";
import { failImportedDownload, removeFailedDownload } from "./lidarrFailures";
import type { LidarrQueueItem } from "../types/lidarr";

type CompletableJob = {
    id: string;
    userId: string;
    subject: string;
    metadata: Prisma.JsonValue;
    discoveryBatchId: string | null;
};

/** A transaction that conflicts with another is run again, up to this many runs in all. */
const TRANSACTION_RUNS = 3;

const LIDARR_RETRY_DELAYS_MS = [5_000, 20_000];

type TransactionClient = Omit<
    PrismaClient,
    "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

/** Fails the jobs through the download-jobs module and counts the ones it settled. */
async function failCount(
    jobs: { id: string }[],
    error: string,
    patch: Record<string, unknown> = {}
): Promise<number> {
    return (await downloadJobs.fail(jobs, error, patch)).length;
}

function generateCorrelationId(): string {
    return crypto.randomUUID();
}

class SimpleDownloadManager {
    private readonly PENDING_TIMEOUT_MS = 10 * 60 * 1000;
    // After Lidarr's last search for an album, how long a job waits for a download to appear.
    private readonly GRAB_WAIT_MS = 15 * 60 * 1000;
    private readonly QUEUE_MISSING_CYCLES = 3;

    private async updateActiveDownloadsMetric(): Promise<void> {
        try {
            const [lidarrCount, soulseekCount] = await Promise.all([
                prisma.downloadJob.count({
                    where: {
                        status: 'processing',
                        metadata: { path: ['currentSource'], equals: 'lidarr' },
                    },
                }),
                prisma.downloadJob.count({
                    where: {
                        status: 'processing',
                        metadata: { path: ['currentSource'], equals: 'soulseek' },
                    },
                }),
            ]);

            activeDownloads.set({ source: 'lidarr' }, lidarrCount);
            activeDownloads.set({ source: 'soulseek' }, soulseekCount);
        } catch (error) {
            logger.error('Failed to update active downloads metric:', error);
        }
    }

    /**
     * Runs a transaction at least once, and again after a conflict with another transaction, up to three runs in all,
     * each retry after a short random wait. A conflict on the last run is thrown as it came.
     */
    private async withTransaction<T>(
        operation: (tx: TransactionClient) => Promise<T>,
        options?: { logPrefix?: string }
    ): Promise<T> {
        const logPrefix = options?.logPrefix ?? "[TX]";

        return retryOnConflict(
            () =>
                prisma.$transaction(operation, {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                    maxWait: 5000,
                    timeout: 10000,
                }),
            {
                runs: TRANSACTION_RUNS,
                onLostRun: ({ run, runs, waitMs }) =>
                    logger.debug(
                        `${logPrefix} Transaction conflict, run ${run}/${runs} lost, again after ${Math.round(waitMs)}ms`
                    ),
            }
        );
    }

    /**
     * Starts a download and returns the correlation id webhooks are matched by.
     * `isDiscovery` tags the artist in Lidarr so discovery cleanup can find it.
     */
    async startDownload(
        jobId: string,
        artistName: string,
        albumTitle: string,
        albumMbid: string,
        isDiscovery: boolean = false
    ): Promise<{ success: boolean; correlationId?: string; error?: string; errorType?: AcquisitionErrorType; isRecoverable?: boolean }> {
        logger.debug(`\nStarting download: ${artistName} - ${albumTitle}${isDiscovery ? " (discovery)" : ""}`);

        const correlationId = generateCorrelationId();

        try {
            if (await this.joinActiveDownload(jobId, correlationId, albumMbid, artistName, albumTitle)) {
                return { success: true, correlationId };
            }

            const musicPath = config.music.musicPath;

            // MusicBrainz answers a merged album's old id with the album it became,
            // so Lidarr is asked for the id it knows.
            let artistMbid: string | undefined;
            let lidarrMbid = albumMbid;
            const rgOutcome = await musicBrainzService.getReleaseGroup(albumMbid);
            if (rgOutcome.kind === "answered") {
                artistMbid = rgOutcome.value?.["artist-credit"]?.[0]?.artist?.id;
                if (rgOutcome.value?.id && rgOutcome.value.id !== albumMbid) {
                    lidarrMbid = rgOutcome.value.id;
                    logger.debug(`   ${albumMbid} was merged into ${lidarrMbid}`);
                }
                if (artistMbid) await downloadJobs.noteArtist(jobId, artistMbid);
            } else if (rgOutcome.kind === "absent") {
                logger.warn(`   Release group ${albumMbid} is not on MusicBrainz`);
            } else {
                logger.error(`   Artist-MBID lookup ${rgOutcome.kind}: ${failureCause(rgOutcome)}`);
            }

            const { album, searchCommandId } = await this.addAlbumToLidarr(
                lidarrMbid,
                artistName,
                albumTitle,
                musicPath,
                artistMbid,
                isDiscovery ? { restoreTag: ensureDiscoverTag } : undefined
            );

            await downloadJobs.start(jobId, {
                correlationId,
                lidarrAlbumId: album.id,
                artistMbid,
                metadata: {
                    albumTitle,
                    artistName,
                    artistMbid,
                    albumMbid,
                    lidarrMbid: album.foreignAlbumId,
                    currentSource: "lidarr",
                    statusText: searchCommandId ? "Searching" : "Lidarr #1",
                    searchCommandId: searchCommandId ?? null,
                },
            });

            this.updateActiveDownloadsMetric().catch(() => {});
            return { success: true, correlationId };
        } catch (error: any) {
            const errorType = error instanceof AcquisitionError ? error.type : undefined;
            const isRecoverable = error instanceof AcquisitionError ? error.isRecoverable : undefined;

            const job = await prisma.downloadJob.findUnique({ where: { id: jobId } });

            if (job && errorType === AcquisitionErrorType.ALREADY_OWNED) {
                await this.completeAlreadyOwned(job, error.message);
                return { success: true };
            }

            if (job && errorType === AcquisitionErrorType.LIDARR_UNAVAILABLE) {
                await this.holdForLidarr(job, artistName, albumTitle, error.message);
                return { success: true };
            }

            logger.error(`   Failed to start download:`, error.message);
            const message = error.message || "Failed to add album to Lidarr";
            if (job) {
                await downloadJobs.fail([job], message, {
                    statusText:
                        errorType === AcquisitionErrorType.NO_RELEASES_AVAILABLE
                            ? "No sources available"
                            : errorType === AcquisitionErrorType.ALBUM_NOT_FOUND
                              ? "Not in Lidarr"
                              : "Failed to start",
                });
            }
            return { success: false, error: message, errorType, isRecoverable };
        }
    }

    /** Retries twice when Lidarr is down or locked, unless it is paused; null from addAlbum means it did not take the album. */
    private async addAlbumToLidarr(
        ...args: Parameters<typeof lidarrService.addAlbum>
    ): Promise<NonNullable<Awaited<ReturnType<typeof lidarrService.addAlbum>>>> {
        for (let attempt = 0; ; attempt++) {
            try {
                const album = await lidarrService.addAlbum(...args);
                if (!album) {
                    throw new AcquisitionError(
                        "Lidarr did not add the album",
                        AcquisitionErrorType.ALBUM_NOT_FOUND
                    );
                }
                return album;
            } catch (error) {
                const unavailable =
                    error instanceof AcquisitionError &&
                    error.type === AcquisitionErrorType.LIDARR_UNAVAILABLE;
                if (
                    !unavailable ||
                    attempt >= LIDARR_RETRY_DELAYS_MS.length ||
                    (await sourcePauseController.isPaused("lidarr"))
                ) {
                    throw error;
                }
                const delayMs = LIDARR_RETRY_DELAYS_MS[attempt];
                logger.warn(`   ${error.message}; retrying in ${delayMs / 1000}s`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }

    /** Lidarr is down or unhealthy: the job waits as pending until the health monitor resumes it. */
    private async holdForLidarr(
        job: { id: string },
        artistName: string,
        albumTitle: string,
        reason: string
    ): Promise<void> {
        logger.warn(`   ${reason}; waiting for Lidarr`);
        await downloadJobs.hold([job], { artistName, albumTitle });
    }

    /** Start every download that was held while Lidarr was unavailable. */
    async resumeHeldDownloads(): Promise<number> {
        const held = await prisma.downloadJob.findMany({
            where: { status: "pending", metadata: { path: ["waitingForLidarr"], equals: true } },
            orderBy: { createdAt: "asc" },
        });
        let resumed = 0;
        for (const job of held) {
            if (await sourcePauseController.isPaused("lidarr")) break;
            const [claimed] = await downloadJobs.resume([job]);
            if (!claimed) continue;
            const metadata = claimed.metadata as any;
            await this.startDownload(
                job.id,
                metadata.artistName,
                metadata.albumTitle,
                job.targetMbid!,
                !!job.discoveryBatchId
            );
            resumed++;
        }
        if (resumed > 0) logger.info(`[LIDARR] Resumed ${resumed} download(s) held while Lidarr was unavailable`);
        return resumed;
    }

    /** Lidarr already has this album at or above the wanted quality: the job is done. */
    private async completeAlreadyOwned(job: CompletableJob, reason: string): Promise<void> {
        await downloadJobs.complete([job], { statusText: "Already in library", alreadyOwnedReason: reason });
        logger.debug(`   ${reason} - job ${job.id} complete`);
    }

    /**
     * Another job already has Lidarr fetching this album, so this one takes the
     * same download instead of starting a second search, which Lidarr would turn
     * away because the album is already in its queue.
     */
    private async joinActiveDownload(
        jobId: string,
        correlationId: string,
        albumMbid: string,
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        const active = await prisma.downloadJob.findFirst({
            where: { id: { not: jobId }, targetMbid: albumMbid, status: "processing", lidarrAlbumId: { not: null } },
            select: { lidarrAlbumId: true, lidarrRef: true, artistMbid: true, metadata: true },
        });
        if (!active) return false;

        const activeMeta = (active.metadata as any) ?? {};
        const started = await downloadJobs.start(jobId, {
            correlationId,
            lidarrAlbumId: active.lidarrAlbumId,
            lidarrRef: active.lidarrRef,
            artistMbid: active.artistMbid,
            metadata: {
                albumTitle,
                artistName,
                albumMbid,
                lidarrMbid: activeMeta.lidarrMbid,
                downloadId: active.lidarrRef ?? undefined,
                searchCommandId: activeMeta.searchCommandId,
                currentSource: "lidarr",
                statusText: activeMeta.statusText ?? "Lidarr #1",
            },
        });
        if (started) logger.debug(`   Joined the download already running for ${albumMbid}`);
        return true;
    }

    /**
     * The jobs a Lidarr event about an album belongs to: those carrying its
     * MusicBrainz id or Lidarr album id. Several users can each have a job on one album.
     */
    private jobsForAlbum<J extends { targetMbid: string | null; lidarrAlbumId: number | null; metadata: Prisma.JsonValue }>(
        jobs: J[],
        album: { albumMbid?: string; lidarrAlbumId?: number }
    ): J[] {
        return jobs.filter((j) => {
            const meta = (j.metadata as any) ?? {};
            const mbidMatch = !!album.albumMbid && (j.targetMbid === album.albumMbid || meta.lidarrMbid === album.albumMbid);
            const idMatch = !!album.lidarrAlbumId && j.lidarrAlbumId === album.lidarrAlbumId;
            return mbidMatch || idMatch;
        });
    }

    /**
     * Lidarr grabbed a release: every job waiting for that album takes the
     * download. A grab no job asked for is Lidarr's own and stays untracked.
     */
    async onDownloadGrabbed(
        downloadId: string,
        albumMbid: string,
        albumTitle: string,
        artistName: string,
        lidarrAlbumId: number,
        opts?: { bundle?: boolean }
    ): Promise<{ matched: boolean; jobId?: string }> {
        logger.debug(`[DOWNLOAD] Grabbed: ${artistName} - ${albumTitle} (${downloadId})`);

        const waiting = await prisma.downloadJob.findMany({
            where: { status: { in: downloadJobs.ACTIVE_STATUSES }, lidarrRef: null },
            orderBy: { createdAt: "asc" },
        });
        const jobs = this.jobsForAlbum(waiting, { albumMbid, lidarrAlbumId });
        const taken = await downloadJobs.grab(jobs, {
            downloadId,
            lidarrAlbumId,
            albumMbid,
            bundle: !!opts?.bundle,
        });
        if (taken.length === 0) {
            // A bundle's other albums, this grab replayed, or a grab that raced another: already linked.
            const tracked = await prisma.downloadJob.findFirst({
                where: { metadata: { path: ["downloadId"], equals: downloadId } },
                select: { id: true },
            });
            if (tracked) return { matched: true, jobId: tracked.id };
            logger.debug(`   No job asked for this album; Lidarr grabbed it on its own`);
            return { matched: false };
        }
        logger.debug(`   ${taken.length} job(s) took the download`);
        const first = jobs.find((j) => taken.some((t) => t.id === j.id))!;
        return { matched: true, jobId: first.id };
    }

    /**
     * Lidarr imported a download: every job waiting for that album completes,
     * and each job's user and batch are told.
     */
    async onDownloadComplete(
        downloadId: string,
        albumMbid?: string,
        lidarrAlbumId?: number,
        albumTitle?: string,
        filesImported?: number,
        /** Why no files came, when Lidarr said; otherwise the message says none came. */
        noFilesReason?: string
    ): Promise<{
        jobId?: string;
        batchId?: string;
        downloadBatchId?: string;
        spotifyImportJobId?: string;
    }> {
        logger.debug(`[COMPLETE] Download completed: ${downloadId}`);

        // Lidarr's webhook comes for an album that got files, but its history records the download
        // against every album the release was grabbed for. Each album is decided by its own import
        // record and arrives only when Lidarr holds all its tracks: an incomplete one waits, as
        // Lidarr parks it; one with no files is a failed release. Lidarr's error propagates.
        const whole = lidarrAlbumId ? await lidarrService.albumWhole(lidarrAlbumId) : true;

        const empty: Awaited<ReturnType<typeof prisma.downloadJob.findMany>> = [];
        const partial: typeof empty = [];
        const thisAlbum = [
            ...(lidarrAlbumId ? [{ lidarrAlbumId }] : []),
            ...(albumMbid ? [{ targetMbid: albumMbid }] : []),
        ];
        const jobs = await this.withTransaction(
            async (tx) => {
                empty.length = 0;
                partial.length = 0;
                const done = await tx.downloadJob.findFirst({
                    where: {
                        metadata: { path: ["downloadId"], equals: downloadId },
                        status: "completed",
                        ...(thisAlbum.length > 0 && { OR: thisAlbum }),
                    },
                });
                if (done) return { replayed: [done], matched: [] };

                const active = await tx.downloadJob.findMany({
                    where: { status: { in: downloadJobs.ACTIVE_STATUSES } },
                    orderBy: { createdAt: "asc" },
                });
                const byDownload = active.filter(
                    (j) => j.lidarrRef === downloadId || (j.metadata as any)?.previousDownloadIds?.includes(downloadId)
                );
                // Lidarr goes by the files: a download can go in as another album
                // than the one it was grabbed for, whose own record then says so.
                const imported = (j: (typeof active)[number]) =>
                    (!lidarrAlbumId && !albumMbid) || this.jobsForAlbum([j], { albumMbid, lidarrAlbumId }).length > 0;
                if (!whole) {
                    (filesImported === 0 ? empty : partial).push(...byDownload.filter(imported));
                    return { replayed: [], matched: [] };
                }
                const albumIds = new Set(
                    [lidarrAlbumId, ...byDownload.filter(imported).map((j) => j.lidarrAlbumId)].filter((id): id is number => !!id)
                );
                const matched = [
                    ...new Set([
                        ...byDownload.filter(imported),
                        ...active.filter((j) => j.lidarrAlbumId !== null && albumIds.has(j.lidarrAlbumId)),
                        ...this.jobsForAlbum(active, { albumMbid }),
                    ]),
                ];
                if (matched.length === 0) {
                    logger.debug(`   No job wanted the album it imported as`);
                }
                return { replayed: [], matched };
            },
            { logPrefix: "[COMPLETE-TX]" }
        );

        if (empty.length > 0) {
            await this.onFailedRelease(
                empty,
                downloadId,
                noFilesReason ?? `Lidarr found no tracks of "${albumTitle ?? "the album"}" in the download`
            );
        }
        if (partial.length > 0) {
            // Lidarr is done with the download; the job now waits for the album's
            // missing tracks, and completes when Lidarr holds it whole.
            for (const job of partial) await downloadJobs.releaseDownload(job.id, downloadId);
            await this.onImportParked(downloadId, "Tracks missing", partial.map((j) => j.id));
        }

        const completed = await downloadJobs.complete(jobs.matched);
        logger.debug(`   ${completed.length} job(s) marked complete`);

        // A job another path completed first (a webhook replay, the reconciler) is still
        // this download's job: the caller scans for its user, as it does for a replay.
        const settledElsewhere =
            completed.length === 0 && jobs.matched.length > 0
                ? await prisma.downloadJob.findFirst({
                      where: { id: { in: jobs.matched.map((j) => j.id) }, status: "completed" },
                      orderBy: { createdAt: "asc" },
                  })
                : null;
        const first = jobs.replayed[0] ?? completed[0] ?? settledElsewhere;
        if (!first) return {};
        const meta = first.metadata as any;
        return {
            jobId: first.id,
            batchId: first.discoveryBatchId || undefined,
            downloadBatchId: meta?.batchId,
            spotifyImportJobId: meta?.spotifyImportJobId,
        };
    }

    /**
     * A download Lidarr imported brought none of the jobs' album. With junk removal off the jobs fail
     * saying so. With it on, a single-album release is marked failed in Lidarr (blocklisted; a bundle
     * is left alone) and each album under its retry limit is searched again; one at the limit is not,
     * because Lidarr's album search ignores monitoring.
     */
    private async onFailedRelease(
        jobs: { id: string; userId: string; subject: string; discoveryBatchId: string | null; metadata: Prisma.JsonValue; lidarrAlbumId: number | null }[],
        downloadId: string,
        reason: string
    ): Promise<void> {
        logger.debug(`[COMPLETE] ${downloadId}: ${reason}`);
        if (!((await getSystemSettings())?.lidarrRemoveJunk ?? true)) {
            await downloadJobs.fail(jobs, reason);
            return;
        }
        const { retryingAlbumIds } = await this.onImportFailed(downloadId, reason, undefined, jobs.map((j) => j.id));
        if (retryingAlbumIds.length === 0) return;
        await failImportedDownload(downloadId, reason);
        for (const albumId of retryingAlbumIds) {
            const searchCommandId = await lidarrService.startAlbumSearch(albumId);
            for (const job of jobs.filter((j) => j.lidarrAlbumId === albumId)) {
                await downloadJobs.mergeMetadata(job.id, { searchCommandId });
            }
        }
    }

    /**
     * Counts a failed download once against every job on its album, ignoring Lidarr's report of a
     * removal Kima made. Lidarr searches again while any job is under its user's retry limit; one at
     * its limit moves on or fails, and the album is unmonitored once none wants it.
     */
    async onImportFailed(
        downloadId: string,
        reason: string,
        albumMbid?: string,
        onlyJobs?: string[]
    ): Promise<{ jobId?: string; searchAgain: boolean; retryingAlbumIds: number[] }> {
        logger.debug(`[RETRY] Download failed: ${downloadId} (${reason})`);

        if (isRateLimited({ message: reason })) {
            await sourcePauseController.handleRateLimit("lidarr", { message: reason });
            return { searchAgain: false, retryingAlbumIds: [] };
        }

        // Lidarr's report of a download Kima itself removed or marked failed is not
        // counted; Kima's own finding about some of a download's albums is.
        if (!onlyJobs && (await prisma.handledDownload.findUnique({ where: { downloadId } }))) {
            logger.debug(`   Kima removed this download itself, not counting it`);
            return { searchAgain: false, retryingAlbumIds: [] };
        }

        const counted = await this.withTransaction(
            async (tx) => {
                const jobs = await tx.downloadJob.findMany({
                    where: {
                        status: "processing",
                        ...(onlyJobs && { id: { in: onlyJobs } }),
                        OR: [
                            { lidarrRef: downloadId },
                            { metadata: { path: ["previousDownloadIds"], array_contains: [downloadId] } },
                        ],
                    },
                    orderBy: { createdAt: "asc" },
                });
                if (jobs.length === 0 && albumMbid) {
                    jobs.push(
                        ...(await tx.downloadJob.findMany({
                            where: { status: "processing", targetMbid: albumMbid, lidarrRef: null },
                            orderBy: { createdAt: "asc" },
                        }))
                    );
                }

                const albumIds = [
                    ...new Set(
                        jobs.filter((j) => j.lidarrRef === downloadId).map((j) => j.lidarrAlbumId).filter((id): id is number => !!id)
                    ),
                ];
                if (albumIds.length > 0) {
                    jobs.push(
                        ...(await tx.downloadJob.findMany({
                            where: {
                                status: "processing",
                                lidarrAlbumId: { in: albumIds },
                                lidarrRef: null,
                                id: { notIn: jobs.map((j) => j.id) },
                            },
                            orderBy: { createdAt: "asc" },
                        }))
                    );
                }

                const results = [];
                for (const job of jobs) {
                    const release = await downloadJobs.countFailedRelease(job, { downloadId, reason }, tx);
                    if (release) results.push({ job, metadata: release.metadata, exhausted: release.exhausted });
                }
                return results;
            },
            { logPrefix: "[FAIL-TX]" }
        );

        if (counted.length === 0) return { searchAgain: false, retryingAlbumIds: [] };
        const searchAgain = counted.some((c) => !c.exhausted);

        if (!searchAgain) {
            const albumIds = new Set(counted.map((c) => c.job.lidarrAlbumId).filter((id): id is number => !!id));
            for (const id of albumIds) await lidarrService.unmonitorAlbum(id);
        }
        const exhausted = counted.filter((c) => c.exhausted).map(({ job, metadata }) => ({ ...job, metadata }));
        for (const job of exhausted) {
            logger.debug(`[RETRY] ${job.subject}: retry limit reached after ${job.attempts} releases`);
            if (await this.completeFromDuplicate(job)) continue;
            await downloadJobs.fail([job], `Every release failed: ${reason}`);
        }
        const retryingAlbumIds = [
            ...new Set(counted.filter((c) => !c.exhausted).map((c) => c.job.lidarrAlbumId).filter((id): id is number => !!id)),
        ];
        return { jobId: counted[0].job.id, searchAgain, retryingAlbumIds };
    }

    /**
     * Lidarr parked a download for a person (tracks missing, or junk left to the user's own setup) or
     * imported only part of an album: the job waits until the album is whole or a new grab carries on.
     * The user is told once, when the job first waits. `onlyJobs` limits it to those jobs.
     */
    async onImportParked(downloadId: string, reason: string, onlyJobs?: string[]): Promise<number> {
        const jobs = await prisma.downloadJob.findMany({
            where: { status: "processing", ...(onlyJobs ? { id: { in: onlyJobs } } : { lidarrRef: downloadId }) },
        });
        return (await downloadJobs.park(jobs, reason)).length;
    }

    /**
     * The user cancelled these jobs: a running download leaves Lidarr's queue without a blocklist or new search
     * unless another active job shares it or wants its album (even one with no download yet), and an album no other
     * active job wants is unmonitored. Each download and album is handled on its own: a failure is logged and the
     * rest still go. The caller deletes the rows.
     */
    async cancelJobs(jobs: { id: string; status: string; lidarrRef: string | null; lidarrAlbumId: number | null }[]): Promise<void> {
        const active = jobs.filter((j) => downloadJobs.isActive(j.status));
        const cancelled = active.map((j) => j.id);
        const stillWanted = (where: Prisma.DownloadJobWhereInput) =>
            prisma.downloadJob.count({
                where: { ...where, status: { in: downloadJobs.ACTIVE_STATUSES }, id: { notIn: cancelled } },
            });

        // Each ref and album is handled on its own: one that fails is logged and the rest still go.
        // Another job (another user's, or one with no download yet) can share the download or its album; it keeps them.
        for (const ref of new Set(active.map((j) => j.lidarrRef).filter((r): r is string => !!r))) {
            try {
                const albumIds = [...new Set(active.filter((j) => j.lidarrRef === ref).map((j) => j.lidarrAlbumId).filter((id): id is number => !!id))];
                const wanted = await stillWanted({ OR: [{ lidarrRef: ref }, ...(albumIds.length > 0 ? [{ lidarrAlbumId: { in: albumIds } }] : [])] });
                if (wanted === 0) await removeFailedDownload(ref, "Cancelled", { searchAgain: false, blocklist: false });
            } catch (error) {
                logger.error(`[CANCEL] Could not remove download ${ref} from Lidarr's queue:`, error);
            }
        }
        for (const albumId of new Set(active.map((j) => j.lidarrAlbumId).filter((id): id is number => !!id))) {
            try {
                if ((await stillWanted({ lidarrAlbumId: albumId })) === 0) await lidarrService.unmonitorAlbum(albumId);
            } catch (error) {
                logger.error(`[CANCEL] Could not stop watching album ${albumId} in Lidarr:`, error);
            }
        }
    }

    /**
     * The user removes these jobs: Lidarr lets go of the running ones (a Lidarr that cannot be reached does not stop the
     * removal), then the rows go (`downloadJobs.remove`). Returns how many rows came off the list.
     */
    async removeJobs(jobs: { id: string; status: string; lidarrRef: string | null; lidarrAlbumId: number | null }[]): Promise<number> {
        try {
            await this.cancelJobs(jobs);
        } catch (error) {
            logger.warn("Could not stop the downloads in Lidarr before removing them:", error);
        }
        return downloadJobs.remove(jobs);
    }

    /** Lidarr was turned off or its settings cleared: downloads held for it fail with that reason. */
    async failHeldDownloads(): Promise<number> {
        const held = await prisma.downloadJob.findMany({
            where: { status: "pending", metadata: { path: ["waitingForLidarr"], equals: true } },
        });
        return failCount(held, "Lidarr is turned off");
    }

    /**
     * Lidarr deleted the album: fail the jobs downloading it without falling
     * back to another album, and forget the id on Discover rows.
     */
    async onAlbumDeleted(lidarrAlbumId: number): Promise<string | undefined> {
        const jobs = await prisma.downloadJob.findMany({
            where: { lidarrAlbumId, status: { in: downloadJobs.ACTIVE_STATUSES } },
            orderBy: { createdAt: "asc" },
        });
        const settled = new Set((await downloadJobs.fail(jobs, "Album removed from Lidarr")).map((j) => j.id));
        await prisma.discoveryAlbum.updateMany({
            where: { lidarrAlbumId },
            data: { lidarrAlbumId: null },
        });
        return jobs.find((j) => settled.has(j.id))?.id;
    }

    /** A job is completed when another job brought in the same album id while this one was running. */
    private async completeFromDuplicate(job: CompletableJob & { targetMbid: string | null; createdAt: Date }): Promise<boolean> {
        if (!job.targetMbid) return false;
        const duplicate = await prisma.downloadJob.findFirst({
            where: { id: { not: job.id }, status: "completed", targetMbid: job.targetMbid, completedAt: { gte: job.createdAt } },
            select: { id: true },
        });
        if (!duplicate) return false;
        logger.debug(`   Completed by duplicate job ${duplicate.id}`);
        return (await downloadJobs.complete([job], { mergedWithJob: duplicate.id })).length > 0;
    }

    /**
     * Jobs waiting on something other than a running download. A pending job not started in 10 minutes
     * fails unless held for Lidarr. A job with no download takes the one Lidarr queued for its album,
     * waits while a search runs, and fails with Lidarr's reason when the search grabs nothing or 15
     * minutes pass since the last search. Returns how many failed.
     */
    async checkWaitingJobs(snapshot: ReconciliationSnapshot | null): Promise<number> {
        const now = Date.now();
        const active = await prisma.downloadJob.findMany({
            where: { status: { in: downloadJobs.ACTIVE_STATUSES } },
            orderBy: { createdAt: "asc" },
        });

        const neverStarted = active.filter((job) => {
            const meta = (job.metadata as any) ?? {};
            const since = meta.pendingSince ? new Date(meta.pendingSince).getTime() : job.createdAt.getTime();
            return job.status === "pending" && !meta.waitingForLidarr && now - since > this.PENDING_TIMEOUT_MS;
        });
        let failed = await failCount(neverStarted, "Download never started - timed out");
        if (!snapshot) return failed;

        const queuedForAlbum = new Map<number, LidarrQueueItem[]>();
        for (const item of snapshot.queueItems) {
            if (!item.albumId) continue;
            queuedForAlbum.set(item.albumId, [...(queuedForAlbum.get(item.albumId) ?? []), item]);
        }

        let searching: Set<number> | undefined;
        for (const job of active) {
            if (job.status !== "processing") continue;
            const meta = (job.metadata as any) ?? {};

            if (job.lidarrRef) {
                const item = snapshot.queue.get(job.lidarrRef);
                if (item) await this.recordProgress(job.id, meta, item);
                continue;
            }

            const queued = (job.lidarrAlbumId ? queuedForAlbum.get(job.lidarrAlbumId) : undefined)?.find(
                (item) => !meta.previousDownloadIds?.includes(item.downloadId)
            );
            if (queued) {
                await this.onDownloadGrabbed(queued.downloadId, job.targetMbid ?? "", meta.albumTitle ?? "", meta.artistName ?? "", job.lidarrAlbumId!);
                continue;
            }
            if (!job.lidarrAlbumId) continue;
            // Waiting for an album's missing tracks, not for a grab.
            if (meta.parked) continue;

            if (meta.searchCommandId) {
                const search = await lidarrService.searchStatus(meta.searchCommandId);
                if (search.status === "running") continue;
                try {
                    await lidarrService.finishSearch(
                        search,
                        job.lidarrAlbumId,
                        meta.albumTitle ?? job.subject,
                        !job.discoveryBatchId && !meta.hadBundle,
                        meta.lastError
                    );
                } catch (error: any) {
                    if (!(error instanceof AcquisitionError)) throw error;
                    failed += await failCount([job], error.message, { statusText: "No sources available" });
                    continue;
                }
                await downloadJobs.mergeMetadata(job.id, { searchCommandId: null, searchFinishedAt: new Date().toISOString() });
                continue;
            }

            searching ??= await lidarrService.albumsBeingSearched();
            if (searching.has(job.lidarrAlbumId)) continue;
            const since = new Date(meta.searchFinishedAt ?? meta.startedAt ?? job.createdAt).getTime();
            if (now - since < this.GRAB_WAIT_MS) continue;
            if (await this.completeFromDuplicate(job)) continue;
            failed += await failCount(
                [job],
                meta.lastError ? `${meta.lastError} - no other release found` : "Lidarr's search grabbed nothing",
                { statusText: "No sources available" }
            );
        }
        return failed;
    }

    /** Copy Lidarr's view of a running download onto its job, writing only when it changed. */
    private async recordProgress(jobId: string, meta: any, item: LidarrQueueItem): Promise<void> {
        const progress = downloadProgress(item);
        const warning =
            item.errorMessage ||
            (item.trackedDownloadStatus === "warning" ? item.statusMessages?.[0]?.messages?.[0] || item.statusMessages?.[0]?.title : undefined);
        const statusText = meta.parked
            ? meta.statusText
            : warning || (item.status === "downloading" && progress !== undefined ? `Downloading ${progress}%` : `Lidarr: ${item.status}`);
        if (meta.progress === progress && meta.statusText === statusText) return;
        await downloadJobs.mergeMetadata(jobId, { progress, downloadStatus: item.status, statusText });
    }

    /**
     * Complete processing jobs whose album Lidarr now holds in full, matched by
     * Lidarr's album id or the album's MusicBrainz id, catching imports whose
     * webhook never arrived, and scan each album into the library.
     */
    async reconcileWithLidarr(snapshot: ReconciliationSnapshot | null): Promise<{ reconciled: number }> {
        if (!snapshot) return { reconciled: 0 };
        const processing = await prisma.downloadJob.findMany({ where: { status: "processing" } });
        const done = processing.filter((job) =>
            albumComplete(snapshot, { lidarrAlbumId: job.lidarrAlbumId, mbid: job.targetMbid ?? (job.metadata as any)?.lidarrMbid })
        );
        const reconciled = (await downloadJobs.complete(done)).length;
        for (const job of done) {
            await requestScan({
                userId: job.userId,
                source: "lidarr-reconcile",
                albumMbid: job.targetMbid ?? undefined,
                downloadId: job.id,
            });
        }
        if (reconciled > 0) logger.debug(`[RECONCILE] ${reconciled} job(s) complete in Lidarr`);
        return { reconciled };
    }

    /**
     * A job whose download left Lidarr's queue without completing: when Lidarr
     * queued another release for the same album, the job follows it; otherwise
     * it fails after missing from the queue for three cycles in a row.
     */
    async syncWithLidarrQueue(snapshot: ReconciliationSnapshot | null): Promise<{ cancelled: number }> {
        if (!snapshot) return { cancelled: 0 };
        const processing = await prisma.downloadJob.findMany({
            where: { status: "processing", lidarrRef: { not: null } },
        });

        let cancelled = 0;
        for (const job of processing) {
            const meta = (job.metadata as any) ?? {};
            if (snapshot.queue.has(job.lidarrRef!)) {
                if (meta.queueSyncMissingCount) await downloadJobs.mergeMetadata(job.id, { queueSyncMissingCount: null });
                continue;
            }

            const replacement = snapshot.queueItems.find(
                (item) =>
                    !!job.lidarrAlbumId &&
                    item.albumId === job.lidarrAlbumId &&
                    item.downloadId !== job.lidarrRef &&
                    !meta.previousDownloadIds?.includes(item.downloadId)
            );
            if (replacement) {
                logger.debug(`   Job ${job.id}: Lidarr replaced its download with ${replacement.downloadId}`);
                if (await downloadJobs.releaseDownload(job.id, job.lidarrRef!, replacement.downloadId)) {
                    await downloadJobs.mergeMetadata(job.id, {
                        downloadId: replacement.downloadId,
                        parked: null,
                        queueSyncMissingCount: null,
                    });
                }
                continue;
            }

            const missing = (meta.queueSyncMissingCount ?? 0) + 1;
            if (missing < this.QUEUE_MISSING_CYCLES) {
                await downloadJobs.mergeMetadata(job.id, { queueSyncMissingCount: missing });
                continue;
            }
            cancelled += await failCount([job], "Lidarr removed the download without importing it", {
                statusText: "Removed in Lidarr",
            });
        }
        return { cancelled };
    }
}

export const simpleDownloadManager = new SimpleDownloadManager();
