/**
 * The artist enrichment job: everything the scheduler's artist phase and its worker do, behind a few calls.
 *
 *   queueOwedArtists()          the scheduler's turn each cycle: asks again an artist whose job was lost, then
 *                               queues a batch of the artists still owed (a library album; pending, failed, or
 *                               unresolvable for a week) and returns how many it queued
 *   artistProgress()            how far along the artists are: counts by status, the share done, and how many are
 *                               still owed (the progress readout and "core enrichment complete" read this)
 *   startArtistWorker()         the queue's worker: one artist per job
 *   enrichSimilarArtist(artist) one artist's whole enrichment (the worker's work, callable on its own)
 *   failedArtistStatus(n)       the status an artist takes after its nth failure in a row
 *   processArtistJob(job)       the worker's job handler: finds the artist and enriches it (callable without a queue)
 *   recordArtistJobFailure(job, err)  what the worker does with a failed job: an artist deleted since is let go,
 *                               any other failure is recorded
 *   ARTIST_BATCH_SIZE           artists queued per cycle (the scheduler's startup line prints it)
 *
 * Artists have no stage record: `Artist.enrichmentStatus` and `enrichmentFailures` are the truth, and a failed
 * job's id keeps blocking a re-add until a grace cleans it. The scheduler keeps the order of phases, the locks and
 * the run state; it only calls this module.
 */
import { Worker, Job } from "bullmq";
import { Artist, Prisma } from "@prisma/client";
import { config } from "../../config";
import { artistsAgree } from "../../services/recordingMatch";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { wikidataService } from "../../services/wikidata";
import { findSimilarArtists } from "../../services/artistSimilarity";
import { STAGE_RETRY_CAP } from "../stageRetry";
import { musicBrainzService } from "../../services/musicbrainz";
import { isMbid, normalizeArtistName } from "../../services/artistIdentity";
import { forgetOwnedIndex } from "../../services/discovery/ownedIndexVersion";
import { findAlbumArtwork, findArtistArtwork } from "../../services/artwork";
import { redisClient } from "../../utils/redis";
import { downloadAndStoreImage, findLocalArtistImage, isNativePath, nativeFileExists } from "../../services/imageStorage";
import { failureCause } from "../../utils/outcome";
import { withShutdownSignal } from "../../utils/stopCheck";
import { resolveArtistMbidFromDiscography } from "../../services/artistCorrection";
import { enrichmentFailureService } from "../../services/enrichmentFailureService";
import { artistQueue, createWorkerConnection, QUEUE_NAMES } from "../enrichmentQueues";
import { entityGoneError, isEntityGone } from "../entityGone";
import { getSystemSettings } from "../../utils/systemSettings";

/** One MusicBrainz genre with its vote count. */
type GenreVote = { name: string; count?: number };

/**
 * An artist row's MusicBrainz id must name this artist (its name, sort name or an alias agrees with the row's): a track
 * artist's id tagged under an album artist's name puts another artist's id on the row. Such an id and everything
 * learned through it are dropped, and the name resolution that follows finds the right one; a local folder image is
 * kept, and an outage leaves the row as it is.
 */
async function dropMbidOfAnotherArtist(artist: Artist, logPrefix: string): Promise<void> {
    const held = await musicBrainzService.getArtist(artist.mbid!, ["aliases"]);
    if (held.kind !== "answered" && held.kind !== "absent") return;
    if (held.kind === "answered") {
        const names = [
            held.value?.name,
            held.value?.["sort-name"],
            ...((held.value?.aliases ?? []) as Array<{ name?: string; "sort-name"?: string }>).flatMap((a) => [a.name, a["sort-name"]]),
        ].filter((n): n is string => typeof n === "string" && n !== "");
        if (artistsAgree([artist.name], names)) return;
        logger.warn(`${logPrefix} MusicBrainz id ${artist.mbid} names "${held.value?.name}", not this artist: dropped`);
    } else {
        logger.warn(`${logPrefix} MusicBrainz does not know id ${artist.mbid}: dropped`);
    }

    const track = await prisma.track.findFirst({
        where: { album: { artistId: artist.id } },
        select: { filePath: true },
    });
    const localImage = track
        ? await findLocalArtistImage(config.music.musicPath, track.filePath, artist.id)
        : null;
    await prisma.$transaction([
        prisma.similarArtist.deleteMany({ where: { fromArtistId: artist.id } }),
        prisma.artist.update({
            where: { id: artist.id },
            data: { mbid: null, summary: null, genres: Prisma.DbNull, similarArtistsJson: Prisma.DbNull, heroUrl: localImage },
        }),
    ]);
    forgetOwnedIndex();
    artist.mbid = null;
    artist.summary = null;
    artist.heroUrl = localImage;
}

/** An artist whose enrichment failed: retried by the next cycles until STAGE_RETRY_CAP
 * failures in a row, then set aside as unresolvable (asked again after a week). */
export function failedArtistStatus(failuresSoFar: number): { enrichmentStatus: string; enrichmentFailures: number } {
    const enrichmentFailures = (failuresSoFar || 0) + 1;
    return {
        enrichmentStatus: enrichmentFailures >= STAGE_RETRY_CAP ? "unresolvable" : "failed",
        enrichmentFailures,
    };
}

/**
 * Enriches an artist with metadata from Wikidata
 * - Fetches artist bio/summary and hero image from Wikidata
 * - Similar artists from ListenBrainz, then Deezer, nudged by the matching formula
 */
export async function enrichSimilarArtist(artist: Artist): Promise<void> {
    const logPrefix = `[ENRICH ${artist.name}]`;
    // A MusicBrainz question that got no answer: waiting on its rate limit asks again next cycle
    // without counting; an outage counts as a failed try (the cap closes it, as for every source).
    let musicbrainzWaiting = false;
    let musicbrainzFailed = false;
    const musicbrainzUnanswered = (kind: string) => {
        if (kind === "rateLimited") musicbrainzWaiting = true;
        else musicbrainzFailed = true;
    };
    logger.debug(`${logPrefix} Starting enrichment (MBID: ${artist.mbid})`);

    // Mark as enriching
    await prisma.artist.update({
        where: { id: artist.id },
        data: { enrichmentStatus: "enriching" },
    });

    // Track which source provided data
    let imageSource = "none";
    let summarySource = "none";

    try {
        if (isMbid(artist.mbid)) {
            await dropMbidOfAnotherArtist(artist, logPrefix);
        }

        if (!isMbid(artist.mbid)) {
            const found = await resolveArtistMbidFromDiscography(
                artist.id,
                artist.name
            );
            if (found.kind === "answered") {
                const realMbid = found.value.mbid;
                logger.debug(
                    `${logPrefix} MusicBrainz: ${realMbid} (${found.evidence.by})`
                );
                try {
                    await prisma.artist.update({
                        where: { id: artist.id },
                        data: { mbid: realMbid },
                    });
                    forgetOwnedIndex();
                    artist.mbid = realMbid;
                } catch (mbidError) {
                    if ((mbidError as { code?: string }).code === "P2002") {
                        logger.debug(
                            `${logPrefix} MBID ${realMbid} already used by another artist, keeping temp`
                        );
                    } else {
                        throw mbidError;
                    }
                }
            } else if (found.kind === "absent") {
                logger.debug(
                    `${logPrefix} MusicBrainz: No verified match, marking as unresolvable`
                );
                await prisma.artist.update({
                    where: { id: artist.id },
                    data: { enrichmentStatus: "unresolvable", lastEnriched: new Date() },
                });
                return;
            } else {
                // An outage keeps the question open for the next cycle.
                musicbrainzUnanswered(found.kind);
                logger.debug(
                    `${logPrefix} MusicBrainz ${found.kind}: ${failureCause(found)}`
                );
            }
        }

        // Try Wikidata first (only if we have a real MBID)
        // Preserve existing heroUrl (e.g., from local file found during scan)
        let summary: string | null = null;
        let wikidataFailed = false;
        // Only preserve existing heroUrl if the file actually exists on disk
        let heroUrl = (artist.heroUrl && (!isNativePath(artist.heroUrl) || nativeFileExists(artist.heroUrl)))
            ? artist.heroUrl
            : null;
        let genres: string[] = [];

        if (isMbid(artist.mbid)) {
            logger.debug(
                `${logPrefix} Wikidata: Fetching for MBID ${artist.mbid}...`
            );
            const wikidataInfo = await wikidataService.getArtistInfo(
                artist.name,
                artist.mbid
            );
            if (wikidataInfo) {
                summary = wikidataInfo.summary ?? null;
                if (!heroUrl && wikidataInfo.heroUrl) {
                    heroUrl = wikidataInfo.heroUrl;
                    imageSource = "wikidata";
                }
                if (summary) summarySource = "wikidata";
            } else {
                // A failed lookup is not "no bio": the stored one stays and the artist is asked again.
                wikidataFailed = true;
            }
        } else {
            logger.debug(`${logPrefix} Wikidata: Skipped (temp MBID)`);
        }

        // findArtistArtwork owns the source order and caching.
        if (!heroUrl) {
            const found = await findArtistArtwork({
                name: artist.name,
                mbid: isMbid(artist.mbid) ? artist.mbid : undefined,
            });
            if (found) {
                heroUrl = found.url;
                imageSource = found.source;
                logger.debug(
                    `${logPrefix} Image: found via ${found.source} - ${heroUrl.substring(0, 60)}...`
                );
            } else {
                logger.debug(`${logPrefix} Image: no source had one`);
            }
        }

        // Genre fallback: MusicBrainz curated genres
        if (genres.length === 0 && isMbid(artist.mbid)) {
            const mbArtist = await musicBrainzService.getArtist(artist.mbid, ["genres"]);
            if (mbArtist.kind === "answered") {
                if (Array.isArray(mbArtist.value.genres)) {
                    genres = mbArtist.value.genres
                        .sort((a: GenreVote, b: GenreVote) => (b.count || 0) - (a.count || 0))
                        .slice(0, 5)
                        .map((g: GenreVote) => g.name)
                        .filter(Boolean);
                    if (genres.length > 0) {
                        logger.debug(`${logPrefix} MusicBrainz: ${genres.length} genres: ${genres.join(', ')}`);
                    }
                }
            } else if (mbArtist.kind !== "absent") {
                musicbrainzUnanswered(mbArtist.kind);
                logger.debug(`${logPrefix} MusicBrainz genres: ${failureCause(mbArtist)}`);
            }
        }

        // Similar artists (ListenBrainz, then Deezer)
        let similarArtists: Array<{
            name: string;
            mbid?: string;
            match: number;
        }> = [];
        let similarFetchFailed = false;
        try {
            // Filter out temp MBIDs
            const validMbid = isMbid(artist.mbid) ? artist.mbid : "";
            const found = await findSimilarArtists(validMbid, artist.name);
            similarArtists = found.artists;
            similarFetchFailed = found.failed;
            logger.debug(
                `${logPrefix} Similar artists: Found ${similarArtists.length}${found.failed ? " (a source failed)" : ""}`
            );
        } catch (error) {
            similarFetchFailed = true;
            logger.warn(
                `${logPrefix} Similar artists: FAILED - ${
                    (error as Error | undefined)?.message || error
                }`
            );
        }

        // Log enrichment summary
        logger.debug(
            `${logPrefix} SUMMARY: image=${imageSource}, summary=${summarySource}, heroUrl=${
                heroUrl ? "set" : "null"
            }`
        );

        // Download image locally if we have an external URL
        let localHeroUrl: string | null = null;
        if (heroUrl && !isNativePath(heroUrl)) {
            logger.debug(`${logPrefix} Downloading image locally...`);
            localHeroUrl = await withShutdownSignal((signal) =>
                downloadAndStoreImage(heroUrl, artist.id, "artist", signal),
            );
            if (localHeroUrl) {
                logger.debug(`${logPrefix} Image saved locally: ${localHeroUrl}`);
            } else {
                // Download failed -- fall back to external URL; re-read below will prefer any native path
                localHeroUrl = heroUrl;
                logger.debug(`${logPrefix} Failed to download image, using: ${localHeroUrl}`);
            }
        } else if (heroUrl) {
            localHeroUrl = heroUrl; // Already a native path
        }

        // Prepare similar artists JSON for storage (from the similarity source)
        // `any`: the column is a nullable Json and this stores a plain null, which Prisma's types only accept as DbNull;
        // the write's behaviour must not change under a lint fix.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const similarArtistsJson: any =
            similarArtists.length > 0
                ? similarArtists.map((s) => ({
                      name: s.name,
                      mbid: s.mbid || null,
                      match: s.match,
                  }))
                : null;

        // Re-read current heroUrl to avoid clobbering scanner-written local images
        // But only if the file actually exists on disk
        const currentArtist = await prisma.artist.findUnique({
            where: { id: artist.id },
            select: { heroUrl: true },
        });
        const finalHeroUrl = (currentArtist?.heroUrl && isNativePath(currentArtist.heroUrl) && nativeFileExists(currentArtist.heroUrl))
            ? currentArtist.heroUrl
            : localHeroUrl;

        // A source that failed keeps what was stored before; the artist is asked again.
        await prisma.artist.update({
            where: { id: artist.id },
            data: {
                ...(wikidataFailed ? {} : { summary }),
                heroUrl: finalHeroUrl,
                ...(similarFetchFailed ? {} : { similarArtistsJson }),
                genres: genres.length > 0 ? genres : undefined,
                lastEnriched: new Date(),
                ...(similarFetchFailed || wikidataFailed || musicbrainzFailed
                    ? failedArtistStatus(artist.enrichmentFailures)
                    : musicbrainzWaiting
                      ? { enrichmentStatus: "pending" }
                      : { enrichmentStatus: "completed", enrichmentFailures: 0 }),
            },
        });
        if (!(similarFetchFailed || wikidataFailed || musicbrainzFailed || musicbrainzWaiting)) {
            // An earlier failure of this artist is answered now; the failures list stops counting it.
            await enrichmentFailureService.resolveByEntity("artist", artist.id);
        }

        // Store similar artists
        if (!similarFetchFailed && similarArtists.length > 0) {
            // Delete existing similar artist relationships
            await prisma.similarArtist.deleteMany({
                where: { fromArtistId: artist.id },
            });

            // Create new relationships
            for (const similar of similarArtists) {
                // Find existing similar artist (don't create new ones)
                let similarArtistRecord = null;

                if (similar.mbid) {
                    // Try to find by MBID first
                    similarArtistRecord = await prisma.artist.findUnique({
                        where: { mbid: similar.mbid },
                    });
                }

                if (!similarArtistRecord) {
                    // Try to find by normalized name (case-insensitive)
                    const normalizedSimilarName = normalizeArtistName(
                        similar.name
                    );
                    similarArtistRecord = await prisma.artist.findFirst({
                        where: { normalizedName: normalizedSimilarName },
                    });
                }

                // Only create similarity relationship if the similar artist already exists in our database
                // This prevents endless crawling of similar artists
                if (similarArtistRecord) {
                    await prisma.similarArtist.upsert({
                        where: {
                            fromArtistId_toArtistId: {
                                fromArtistId: artist.id,
                                toArtistId: similarArtistRecord.id,
                            },
                        },
                        create: {
                            fromArtistId: artist.id,
                            toArtistId: similarArtistRecord.id,
                            weight: similar.match,
                        },
                        update: {
                            weight: similar.match,
                        },
                    });
                }
            }

            logger.debug(
                `${logPrefix} Stored ${similarArtists.length} similar artist relationships`
            );
        }

        // Fetch covers for all albums belonging to this artist that don't have covers yet
        await enrichAlbumCovers(artist.id, artist.name);

        // Cache artist image path in Redis for faster access
        if (localHeroUrl) {
            try {
                await redisClient.setex(
                    `hero:${artist.id}`,
                    7 * 24 * 60 * 60,
                    localHeroUrl
                );
            } catch {
                // Redis errors are non-critical
            }
        }
    } catch (error) {
        logger.error(
            `${logPrefix} ENRICHMENT FAILED:`,
            (error as Error | undefined)?.message || error
        );

        await prisma.artist.update({
            where: { id: artist.id },
            data: failedArtistStatus(artist.enrichmentFailures),
        });

        throw error;
    }
}

/**
 * Enrich album covers for an artist
 * Fetches covers from Cover Art Archive for albums without covers
 */
async function enrichAlbumCovers(
    artistId: string,
    artistName: string,
): Promise<void> {
    try {
        // Find albums with no cover, or with a native cover file missing from disk
        const allAlbums = await prisma.album.findMany({
            where: {
                artistId,
            },
            select: {
                id: true,
                rgMbid: true,
                title: true,
                coverUrl: true,
            },
        });
        const albumsWithoutCovers = allAlbums.filter(
            (a) => !a.coverUrl || a.coverUrl === "" || (isNativePath(a.coverUrl) && !nativeFileExists(a.coverUrl))
        );

        if (albumsWithoutCovers.length === 0) {
            logger.debug(`    All albums already have covers`);
            return;
        }

        logger.debug(
            `    Fetching covers for ${albumsWithoutCovers.length} albums...`
        );

        let fetchedCount = 0;
        const BATCH_SIZE = 3; // Limit concurrent requests

        // Process in batches to avoid overwhelming Cover Art Archive
        for (let i = 0; i < albumsWithoutCovers.length; i += BATCH_SIZE) {
            const batch = albumsWithoutCovers.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (album) => {
                    // A placeholder id only rules out the id-keyed sources; Deezer searches by name.
                    if (!album.rgMbid && !album.title) return;

                    try {
                        const coverUrl = (
                            await findAlbumArtwork({
                                rgMbid: album.rgMbid,
                                artistName,
                                albumTitle: album.title,
                            })
                        )?.url ?? null;

                        if (coverUrl) {
                            // Save to database
                            await prisma.album.update({
                                where: { id: album.id },
                                data: { coverUrl },
                            });

                            // Cache in Redis
                            try {
                                await redisClient.setex(
                                    `album-cover:${album.id}`,
                                    30 * 24 * 60 * 60, // 30 days
                                    coverUrl
                                );
                            } catch {
                                // Redis errors are non-critical
                            }

                            fetchedCount++;
                        }
                    } catch {
                        // Cover art fetch failed, continue with next album
                        logger.debug(`      No cover found for: ${album.title}`);
                    }
                })
            );
        }

        logger.debug(
            `    Fetched ${fetchedCount}/${albumsWithoutCovers.length} album covers`
        );
    } catch (error) {
        logger.error(`    Failed to enrich album covers:`, error);
        // Don't throw - album cover failures shouldn't fail the entire enrichment
    }
}

// ── Queueing: the scheduler's artist phase ───────────────────────────────

/** Artists queued per cycle. */
export const ARTIST_BATCH_SIZE = 10;
// A failed job keeps its jobId, and the queueing skips an artist whose jobId is still held, so a failure backs
// off until this grace cleans the job. Completed jobs are cleaned immediately so a reset artist can be queued again.
const FAILED_JOB_RETRY_GRACE_MS = 15 * 60 * 1000; // 15 minutes

/** An artist known only from Discover is not enriched (Discover shows its name, nothing more): only artists with a library album are. */
const ENRICHED_ARTISTS = { albums: { some: { location: "LIBRARY" as const } } };

/**
 * How far along the artists are, over the artists enrichment works on. `completed` counts unresolvable ones (closed
 * for now); `owed` is what is still to answer: waiting, in flight, or failed and due a retry.
 */
export async function artistProgress() {
    const counts = await prisma.artist.groupBy({
        by: ["enrichmentStatus"],
        where: ENRICHED_ARTISTS,
        _count: true,
    });
    const of = (status: string) => counts.find((c) => c.enrichmentStatus === status)?._count ?? 0;
    const total = counts.reduce((sum, c) => sum + c._count, 0);
    const completed = of("completed") + of("unresolvable");
    return {
        total,
        completed,
        pending: of("pending"),
        failed: of("failed"),
        owed: of("pending") + of("enriching") + of("failed"),
        progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
}

export async function queueOwedArtists(): Promise<number> {
    // Reset temp-MBID artists that have been unresolvable for >24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.artist.updateMany({
        where: {
            mbid: { startsWith: "temp-" },
            enrichmentStatus: "unresolvable",
            lastEnriched: { lt: oneDayAgo },
        },
        data: { enrichmentStatus: "pending", enrichmentFailures: 0 },
    });

    // With nothing queued or running, no artist is really being enriched: one still marked so
    // lost its job (Redis emptied, a crash) and is asked again.
    const inQueue = await artistQueue.getJobCounts("waiting", "active", "delayed", "prioritized");
    if (Object.values(inQueue).every((n) => n === 0)) {
        await prisma.artist.updateMany({
            where: { enrichmentStatus: "enriching" },
            data: { enrichmentStatus: "pending" },
        });
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pendingArtists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
                { enrichmentStatus: "unresolvable", lastEnriched: { lt: sevenDaysAgo } },
            ],
            ...ENRICHED_ARTISTS,
        },
        select: { id: true, name: true },
        take: ARTIST_BATCH_SIZE,
    });

    if (pendingArtists.length === 0) return 0;

    // Free reusable jobIds: completed immediately, failed after a backoff grace.
    // Without this a failed artist's `artist-<id>` marker blocks every re-add
    // until BullMQ's removeOnFail age (24h) expires -- far slower than intended.
    try {
        await artistQueue.clean(0, 0, "completed");
        await artistQueue.clean(FAILED_JOB_RETRY_GRACE_MS, 0, "failed");
    } catch (err) {
        logger.warn(`[Enrichment] artistQueue clean failed: ${(err as Error).message}`);
    }

    let queued = 0;
    for (const artist of pendingArtists) {
        try {
            // Enqueue and mark "enriching" only when the jobId slot is free. A failed job
            // inside the grace still holds it, so add() would no-op and the artist would sit
            // "enriching" until restart.
            const jobId = `artist-${artist.id}`;
            if (await artistQueue.getJob(jobId)) continue;
            // Add FIRST — if Redis is down, status stays "pending" and retries naturally
            await artistQueue.add(
                "enrich",
                { artistId: artist.id, artistName: artist.name },
                { jobId },
            );
            // Update AFTER successful add
            await prisma.artist.update({
                where: { id: artist.id },
                data: { enrichmentStatus: "enriching" },
            });
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue artist ${artist.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} artists`);
    }
    return queued;
}

// ── The worker ───────────────────────────────────────────────────────────

interface ArtistJobData {
    artistId: string;
    artistName: string;
}

/** One artist's job. An artist deleted since the job was queued throws the entity-gone error. */
export async function processArtistJob(job: Job<ArtistJobData>): Promise<void> {
    const { artistId, artistName } = job.data ?? {};
    // A job hash stripped by Redis arrives without data.
    if (!artistId) {
        throw new Error("[ArtistWorker] Job has no artistId -- corrupt job data");
    }
    logger.debug(`[ArtistWorker] Processing ${artistId} (${artistName})`);

    const artist = await prisma.artist.findUnique({ where: { id: artistId } });
    if (!artist) {
        throw entityGoneError("Artist", artistId);
    }

    // enrichSimilarArtist records the artist's status: completed, or failed and
    // counted toward unresolvable.
    await enrichSimilarArtist(artist);
}

/** A job that failed: an artist that no longer exists resolves silently; any other failure is recorded. */
export async function recordArtistJobFailure(job: Job<ArtistJobData>, err: Error): Promise<void> {
    const { artistId } = job.data ?? {};
    if (!artistId) {
        // A data-less job has nothing to record against; the cleaned jobId lets the next cycle queue it again.
        logger.error(`[ArtistWorker] A job with no artistId failed: ${err.message}`);
        return;
    }

    if (isEntityGone(err)) {
        logger.info(`[ArtistWorker] Artist ${artistId} no longer exists, resolving silently`);
        return;
    }

    logger.error(`[ArtistWorker] Artist ${artistId} failed: ${err.message}`);

    // enrichSimilarArtist records its own failures; one that threw before it could
    // (still pending or enriching) is recorded here the same way.
    try {
        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            select: { enrichmentStatus: true, enrichmentFailures: true },
        });
        if (artist && (artist.enrichmentStatus === "pending" || artist.enrichmentStatus === "enriching")) {
            await prisma.artist.update({
                where: { id: artistId },
                data: failedArtistStatus(artist.enrichmentFailures),
            });
        }
        await enrichmentFailureService.recordFailure({
            entityType: "artist",
            entityId: artistId,
            entityName: job.data.artistName,
            errorMessage: err.message,
        });
    } catch (reportErr) {
        logger.warn(`[ArtistWorker] Could not record artist ${artistId}'s failure: ${(reportErr as Error).message}`);
    }
}

export async function startArtistWorker(): Promise<Worker> {
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency ?? 3;

    const worker = new Worker<ArtistJobData>(QUEUE_NAMES.ARTISTS, processArtistJob, {
        connection: createWorkerConnection(),
        concurrency,
        lockDuration: 120000,
        stalledInterval: 30000,
        maxStalledCount: 2,
    });

    worker.on("failed", async (job, err) => {
        if (!job) return;
        await recordArtistJobFailure(job, err);
    });

    worker.on("error", (err) => logger.error(`[ArtistWorker] Error: ${err.message}`));
    logger.info(`[ArtistWorker] Started (concurrency: ${concurrency})`);
    return worker;
}
