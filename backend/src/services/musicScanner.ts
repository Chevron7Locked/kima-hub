import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";
import { parseFile } from "music-metadata";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import PQueue from "p-queue";
import { CoverArtExtractor } from "./coverArtExtractor";
import { findAlbumArtwork } from "./artwork";
import {
    canonicalizeVariousArtists,
    extractArtistFromRelativePath,
    extractAlbumFromRelativePath,
    sanitizeTagString,
} from "../utils/artistNormalization";
import { isMbid, parseCredit, resolveArtist, type ParsedCredit } from "./artistIdentity";
import { normalizeIsrc } from "./recordingMatch";
import { resolveAlbum } from "./albumIdentity";
import { backfillAllArtistCounts } from "./artistCountsService";
import { findLocalArtistImage } from "./imageStorage";
import { LIBRARY_LOCATION } from "./libraryFilters";
import { closeStagesForMissingTracks } from "./missingFileStages";
import { runReconcile } from "./libraryReconcile";

/**
 * The MusicBrainz id of a credit's primary artist, from the same tag the name came
 * from. A tag's ids follow the credit's order, so the first is the primary's only
 * when there is one id per credited name; a joint name with several ids gets none.
 */
function primaryArtistMbid(ids: readonly string[] | undefined, credit: ParsedCredit): string | undefined {
    if (!ids || ids.length === 0) return undefined;
    return ids.length === 1 + credit.featured.length ? ids[0] : undefined;
}

/**
 * A replaced file reopens its stage records as `pending` with evidence "file
 * changed". `blocked` records (a human decision) stay. A `working` record reopens
 * too: the job on the old file then holds a stale claim, and its answer is dropped.
 */
async function reopenStagesForChangedFile(trackId: string): Promise<void> {
    const reopened = await prisma.$executeRaw`
        UPDATE "TrackStage"
           SET status = 'pending',
               failures = 0,
               redelivered = 0,
               "nextRetryAt" = NULL,
               "startedAt" = NULL,
               "finishedAt" = NULL,
               "decidedAt" = NULL,
               "decidedBy" = NULL,
               "lastErrorCode" = NULL,
               "lastErrorMessage" = NULL,
               "failureClass" = NULL,
               retryable = true,
               evidence = jsonb_build_object('reason', 'file changed')
         WHERE "trackId" = ${trackId}
           AND status IN ('done', 'failed', 'pending', 'working')`;
    if (reopened > 0) {
        logger.debug(
            `[Scanner] Re-opened ${reopened} stage record(s) for ${trackId}: file changed`
        );
    }
}

/**
 * Reopen the FILE_MISSING records of a returned file at attempt 0. Records
 * closed for other reasons, or re-decided by a human, stay as they are.
 */
async function reopenStagesForReturnedTracks(
    client: Pick<Prisma.TransactionClient, "$executeRaw">,
    trackIds: string[]
): Promise<void> {
    if (trackIds.length === 0) return;
    const reopened = await client.$executeRaw`
        UPDATE "TrackStage"
           SET status = 'pending',
               failures = 0,
               redelivered = 0,
               "nextRetryAt" = NULL,
               "startedAt" = NULL,
               "finishedAt" = NULL,
               "lastErrorCode" = NULL,
               "lastErrorMessage" = NULL,
               "failureClass" = NULL,
               retryable = true,
               evidence = jsonb_build_object('reason', 'file returned')
         WHERE "trackId" = ANY(${trackIds}::text[])
           AND status = 'failed'
           AND NOT retryable
           AND "failureClass" = 'FILE_MISSING'
           AND "decidedAt" IS NULL`;
    if (reopened > 0) {
        logger.debug(
            `[Scanner] Re-opened ${reopened} stage record(s): files returned`
        );
    }
}

// Supported audio formats
const AUDIO_EXTENSIONS = new Set([
    ".mp3",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".ape",
    ".wv",
]);

interface ScanProgress {
    filesScanned: number;
    filesTotal: number;
    currentFile: string;
    errors: Array<{ file: string; error: string }>;
}

export interface ScanResult {
    tracksAdded: number;
    tracksUpdated: number;
    /** Tracks newly flagged missing this scan (file gone from disk). Never deletions. */
    tracksMissing: number;
    /** Tracks retired by the reconcile sweep; always 0 in `flag` mode. */
    tracksRemoved: number;
    tracksCorrupt: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

export class MusicScannerService {
    private scanQueue = new PQueue({ concurrency: 10 });
    private progressCallback?: (progress: ScanProgress) => void;
    private coverArtExtractor?: CoverArtExtractor;
    private coverCachePath?: string;

    constructor(
        progressCallback?: (progress: ScanProgress) => void,
        coverCachePath?: string
    ) {
        this.progressCallback = progressCallback;
        if (coverCachePath) {
            this.coverCachePath = coverCachePath;
            this.coverArtExtractor = new CoverArtExtractor(coverCachePath);
        }
    }

    /**
     * Scan the music directory and update the database
     */
    async scanLibrary(musicPath: string): Promise<ScanResult> {
        const startTime = Date.now();
        const result: ScanResult = {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksMissing: 0,
            tracksRemoved: 0,
            tracksCorrupt: 0,
            errors: [],
            duration: 0,
        };

        logger.debug(`Starting library scan: ${musicPath}`);

        // Step 1: Find all audio files
        const audioFiles = await this.findAudioFiles(musicPath);
        logger.debug(`Found ${audioFiles.length} audio files`);

        // Step 2: Get existing tracks from database
        const existingTracks = await prisma.track.findMany({
            select: {
                id: true,
                filePath: true,
                fileModified: true,
                missingSince: true,
            },
        });

        const tracksByPath = new Map(
            existingTracks.map((t) => [t.filePath, t])
        );

        // Step 3: Process each audio file
        let filesScanned = 0;
        const progress: ScanProgress = {
            filesScanned: 0,
            filesTotal: audioFiles.length,
            currentFile: "",
            errors: [],
        };

        for (const audioFile of audioFiles) {
            await this.scanQueue.add(async () => {
                try {
                    const relativePath = path.relative(musicPath, audioFile);
                    progress.currentFile = relativePath;
                    this.progressCallback?.(progress);

                    const stats = await fs.promises.stat(audioFile);
                    const fileModified = stats.mtime;

                    // Skip 0-byte files (incomplete downloads, stubs)
                    if (stats.size === 0) return;

                    const existingTrack = tracksByPath.get(relativePath);

                    // Check if file needs updating
                    if (existingTrack) {
                        if (
                            existingTrack.fileModified &&
                            existingTrack.fileModified >= fileModified
                        ) {
                            // File hasn't changed, skip
                            return;
                        }
                        // File changed: every recorded answer was computed
                        // from the old content, so reopen the whole stage
                        // set before re-processing the row.
                        await reopenStagesForChangedFile(existingTrack.id);
                    }

                    await this.processAudioFile(
                        audioFile,
                        relativePath,
                        musicPath
                    );
                    if (existingTrack) result.tracksUpdated++;
                    else result.tracksAdded++;
                } catch (err: any) {
                    const error = {
                        file: audioFile,
                        error: err.message || String(err),
                    };
                    result.errors.push(error);
                    progress.errors.push(error);
                    logger.error(`Error processing ${audioFile}:`, err);

                    const relativePath = path.relative(musicPath, audioFile);
                    const existingTrack = tracksByPath.get(relativePath);
                    if (existingTrack) {
                        await prisma.track.update({
                            where: { id: existingTrack.id },
                            data: { corrupt: true },
                        });
                        result.tracksCorrupt++;
                        logger.debug(`Marked track as corrupt: ${relativePath}`);
                    }
                } finally {
                    filesScanned++;
                    progress.filesScanned = filesScanned;
                    this.progressCallback?.(progress);
                }
            });
        }

        await this.scanQueue.onIdle();

        // Missing files are flagged; in `flag` mode (default) nothing is ever deleted:
        // deleting the row would cascade away its plays, likes, stage records and
        // embedding, and the flag is cleared by the scan that finds the file again.
        // In `delete` mode, Step 4b retires tracks confirmed gone — flagged by the
        // previous scan, still absent now — and RemovalLog records what was removed.
        const scannedPaths = new Set(
            audioFiles.map((f) => path.relative(musicPath, f))
        );

        // The walk lists regular files only, so a file it did not list may still be on
        // disk (a symlink, a path that normalises differently): those are checked there.
        const pathCandidates = existingTracks.filter(
            (t) => !scannedPaths.has(t.filePath)
        );
        const existChecks = await Promise.all(
            pathCandidates.map(async (t) => {
                const fullPath = path.join(musicPath, t.filePath);
                try {
                    await fs.promises.access(fullPath);
                    return { track: t, exists: true };
                } catch {
                    return { track: t, exists: false };
                }
            })
        );
        const onDisk = new Set(existChecks.filter((c) => c.exists).map((c) => c.track.id));

        // Cleared here, not in the per-file upsert: a restored mount can bring a file
        // back with its old mtime, and the unchanged-file skip would never reach it. A
        // flag stays only on a file this scan could not find, so the reconcile below
        // never retires a track whose file is there.
        const returned = existingTracks.filter(
            (t) => t.missingSince !== null && (scannedPaths.has(t.filePath) || onDisk.has(t.id))
        );
        if (returned.length > 0) {
            const returnedIds = returned.map((t) => t.id);
            await prisma.$transaction(async (tx) => {
                await tx.track.updateMany({
                    where: { id: { in: returnedIds } },
                    data: { missingSince: null },
                });
                await reopenStagesForReturnedTracks(tx, returnedIds);
            });
            logger.debug(
                `Cleared the missing flag on ${returned.length} track(s) whose files are back`
            );
        }

        if (pathCandidates.length > 0) {
            const beforeCount = pathCandidates.length;
            const vanished = existChecks
                .filter((c) => !c.exists)
                .map((c) => c.track);
            const pathMismatches = beforeCount - vanished.length;
            if (pathMismatches > 0) {
                logger.debug(
                    `${pathMismatches} track(s) had path mismatches but files exist on disk (skipped missing flag)`
                );
            }

            // Flag and stage records change together, so no reader sees a flagged track
            // whose questions are still owed.
            await prisma.$transaction(async (tx) => {
                if (vanished.length > 0) {
                    // Only rows not already flagged change: the timestamp is when
                    // THIS scan found the file gone, not a later one re-stamping
                    // an old fact.
                    const marked = await tx.track.updateMany({
                        where: {
                            id: { in: vanished.map((t) => t.id) },
                            missingSince: null,
                        },
                        data: { missingSince: new Date() },
                    });
                    result.tracksMissing = marked.count;
                    logger.debug(
                        `Flagged ${marked.count} track(s) missing (files not found on disk)`
                    );
                }
                const closed = await closeStagesForMissingTracks(tx);
                if (closed > 0) {
                    logger.debug(
                        `[Scanner] Closed ${closed} stage record(s) for files not in the library`
                    );
                }
            });
        }

        // Step 4b: Reconcile (opt-in). Retires tracks confirmed gone by consecutive
        // scans; inert in `flag` mode. Runs BEFORE Steps 5-6 so their orphan cleanup
        // cascades the newly-emptied albums and artists for free.
        const reconcile = await runReconcile(new Date(startTime));
        result.tracksRemoved = reconcile.removed;

        // Step 5: Clean up orphaned albums (albums with no tracks)
        const orphanedAlbums = await prisma.album.findMany({
            where: {
                tracks: { none: {} },
            },
            select: { id: true, title: true, artistId: true },
        });

        if (orphanedAlbums.length > 0) {
            logger.debug(`Removing ${orphanedAlbums.length} orphaned albums...`);
            await prisma.album.deleteMany({
                where: {
                    id: { in: orphanedAlbums.map((a) => a.id) },
                },
            });
        }

        // Step 6: Clean up orphaned artists (artists with no albums)
        const orphanedArtists = await prisma.artist.findMany({
            where: {
                albums: { none: {} },
            },
            select: { id: true, name: true },
        });

        if (orphanedArtists.length > 0) {
            logger.debug(
                `Removing ${
                    orphanedArtists.length
                } orphaned artists: ${orphanedArtists
                    .map((a) => a.name)
                    .join(", ")}`
            );
            await prisma.artist.deleteMany({
                where: {
                    id: { in: orphanedArtists.map((a) => a.id) },
                },
            });
        }

        result.duration = Date.now() - startTime;
        logger.debug(
            `Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} missing:${result.tracksMissing} corrupt:${result.tracksCorrupt} removed:${result.tracksRemoved} (${result.duration}ms)`
        );

        // Update artist counts in background (non-blocking)
        // This ensures denormalized counts are accurate after scan
        backfillAllArtistCounts().catch((err) => {
            logger.error("[Scan] Artist counts update failed:", err);
        });

        return result;
    }

    /**
     * Check if a file path is within the discovery folder
     * Discovery albums are stored in paths like "discovery/Artist/Album/track.flac"
     * or "Discover/Artist/Album/track.flac" (case-insensitive)
     */
    private isDiscoveryPath(relativePath: string): boolean {
        const normalizedPath = relativePath.toLowerCase().replace(/\\/g, "/");
        // Check if path starts with "discovery/" or "discover/"
        return (
            normalizedPath.startsWith("discovery/") ||
            normalizedPath.startsWith("discover/")
        );
    }

    /**
     * Normalize string for matching - handles encoding differences between
     * file metadata and database records
     */
    private normalizeForMatching(str: string): string {
        return str
            .toLowerCase()
            .trim()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") // Remove diacritics (café → cafe)
            .replace(/[''´`]/g, "'") // Normalize apostrophes
            .replace(/[""„]/g, '"') // Normalize quotes
            .replace(/[–—−]/g, "-") // Normalize dashes
            .replace(/\s+/g, " ") // Collapse whitespace
            .replace(/[^\w\s'"-]/g, ""); // Remove other special chars
    }

    /**
     * Check if an album is part of a discovery download by matching artist name + album title.
     * Uses multi-pass matching: exact match first, then partial match as fallback.
     */
    private async isDiscoveryDownload(
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        if (!artistName || !albumTitle) return false;

        const normalizedArtist = this.normalizeForMatching(artistName);
        const normalizedAlbum = this.normalizeForMatching(albumTitle);

        // Also try without featured credits (handles "Artist A feat. Artist B")
        const primaryArtist = parseCredit(artistName).primary || artistName;
        const normalizedPrimaryArtist =
            this.normalizeForMatching(primaryArtist);

        logger.debug(
            `[Scanner] Checking discovery: "${artistName}" -> "${normalizedArtist}"`
        );
        if (primaryArtist !== artistName) {
            logger.debug(
                `[Scanner]   Primary artist: "${primaryArtist}" -> "${normalizedPrimaryArtist}"`
            );
        }
        logger.debug(
            `[Scanner]   Album: "${albumTitle}" -> "${normalizedAlbum}"`
        );

        try {
            // Get all discovery jobs (pending, processing, or recently completed)
            const discoveryJobs = await prisma.downloadJob.findMany({
                where: {
                    discoveryBatchId: { not: null },
                    status: { in: ["pending", "processing", "completed"] },
                },
            });

            logger.debug(
                `[Scanner]   Found ${discoveryJobs.length} discovery jobs to check`
            );

            // Pass 1: Exact match after normalization
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(
                    metadata?.artistName || ""
                );
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || ""
                );

                if (
                    (jobArtist === normalizedArtist ||
                        jobArtist === normalizedPrimaryArtist) &&
                    jobAlbum === normalizedAlbum
                ) {
                    logger.debug(`[Scanner] EXACT MATCH: job ${job.id}`);
                    return true;
                }
            }

            // Pass 2: Partial match fallback (handles "Album" vs "Album (Deluxe)")
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(
                    metadata?.artistName || ""
                );
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || ""
                );

                // Try matching both full artist name and extracted primary artist
                const artistMatch =
                    jobArtist === normalizedArtist ||
                    jobArtist === normalizedPrimaryArtist ||
                    normalizedArtist.includes(jobArtist) ||
                    jobArtist.includes(normalizedArtist) ||
                    normalizedPrimaryArtist.includes(jobArtist) ||
                    jobArtist.includes(normalizedPrimaryArtist);
                const albumMatch =
                    jobAlbum === normalizedAlbum ||
                    normalizedAlbum.includes(jobAlbum) ||
                    jobAlbum.includes(normalizedAlbum);

                if (artistMatch && albumMatch) {
                    logger.debug(`[Scanner] PARTIAL MATCH: job ${job.id}`);
                    logger.debug(
                        `[Scanner]   Job: "${jobArtist}" - "${jobAlbum}"`
                    );
                    return true;
                }
            }

            // Pass 3: Album-only match (handles featured artists on discovery albums)
            // If the album title matches exactly, this track is likely a featured artist on a discovery album
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || ""
                );

                if (
                    jobAlbum === normalizedAlbum &&
                    normalizedAlbum.length > 3
                ) {
                    logger.debug(
                        `[Scanner] ALBUM-ONLY MATCH (featured artist): job ${job.id}`
                    );
                    logger.debug(
                        `[Scanner]   Track artist "${normalizedArtist}" is likely featured on "${jobAlbum}"`
                    );
                    return true;
                }
            }

            // Pass 4: Check DiscoveryAlbum table (for already processed albums) by album title
            const discoveryAlbumByTitle = await prisma.discoveryAlbum.findFirst(
                {
                    where: {
                        albumTitle: { equals: albumTitle, mode: "insensitive" },
                        status: { in: ["ACTIVE", "LIKED"] },
                    },
                }
            );

            if (discoveryAlbumByTitle) {
                logger.debug(
                    `[Scanner] DiscoveryAlbum match (by title): ${discoveryAlbumByTitle.id}`
                );
                return true;
            }

            // Pass 5: Check if artist name matches any discovery album
            // This catches cases where Lidarr downloads a different album than requested
            // e.g., requested "Broods - Broods" but got "Broods - Evergreen"
            const discoveryAlbumByArtist =
                await prisma.discoveryAlbum.findFirst({
                    where: {
                        artistName: { equals: artistName, mode: "insensitive" },
                        status: { in: ["ACTIVE", "LIKED", "DELETED"] }, // Include DELETED to catch cleanup scenarios
                    },
                });

            if (discoveryAlbumByArtist) {
                // Double-check: only match if this artist has NO library albums yet
                // This prevents marking albums from artists that exist in both library and discovery
                const existingLibraryAlbum = await prisma.album.findFirst({
                    where: {
                        artist: {
                            name: { equals: artistName, mode: "insensitive" },
                        },
                        location: LIBRARY_LOCATION,
                    },
                });

                if (!existingLibraryAlbum) {
                    logger.debug(
                        `[Scanner] DiscoveryAlbum match (by artist): ${discoveryAlbumByArtist.id}`
                    );
                    logger.debug(
                        `[Scanner]   Artist "${artistName}" is a discovery-only artist`
                    );
                    return true;
                }
            }

            logger.debug(`[Scanner] No discovery match found`);
            return false;
        } catch (error) {
            logger.error(`[Scanner] Error checking discovery status:`, error);
            return false;
        }
    }

    /**
     * Recursively find all audio files in a directory
     */
    private async findAudioFiles(dirPath: string): Promise<string[]> {
        const files: string[] = [];

        async function walk(dir: string) {
            const entries = await fs.promises.readdir(dir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (AUDIO_EXTENSIONS.has(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        }

        await walk(dirPath);
        return files;
    }

    /**
     * Ensure the album has a cover: art embedded in the file first, since it is
     * free and exact, then every artwork source. Re-extracts when the cached
     * native file has gone missing.
     */
    private async ensureAlbumCover(
        album: { id: string; coverUrl: string | null; rgMbid: string | null },
        absolutePath: string,
        artistName: string,
        albumTitle: string
    ): Promise<void> {
        if (!this.coverArtExtractor || !this.coverCachePath) return;

        let needsExtraction = !album.coverUrl;

        if (album.coverUrl?.startsWith("native:")) {
            const nativePath = album.coverUrl.replace("native:", "");
            const extractorCachePath = path.join(
                this.coverCachePath,
                nativePath
            );
            if (!fs.existsSync(extractorCachePath)) {
                needsExtraction = true;
            }
        }

        if (!needsExtraction) return;

        const coverPath = await this.coverArtExtractor.extractCoverArt(
            absolutePath,
            album.id
        );

        if (coverPath) {
            await prisma.album.update({
                where: { id: album.id },
                data: { coverUrl: `native:${coverPath}` },
            });
            return;
        }

        try {
            const found = await findAlbumArtwork({
                rgMbid: album.rgMbid,
                artistName,
                albumTitle,
            });
            if (found) {
                await prisma.album.update({
                    where: { id: album.id },
                    data: { coverUrl: found.url },
                });
            }
        } catch (error) {
            // Cover art is optional; a scan must not fail over a picture.
        }
    }

    private async processAudioFile(
        absolutePath: string,
        relativePath: string,
        musicPath: string
    ): Promise<void> {
        // Extract metadata
        const metadata = await parseFile(absolutePath);
        const stats = await fs.promises.stat(absolutePath);

        // Parse basic info
        const title =
            sanitizeTagString(metadata.common.title) ||
            path.basename(relativePath, path.extname(relativePath));
        const trackNo = metadata.common.track.no || 0;
        const discNumber = metadata.common.disk.no || null;
        // music-metadata's runtime usually returns `discsubtitle` as a single string,
        // but the type declarations leave the shape ambiguous and some tag formats
        // (e.g., Vorbis with multiple DISCSUBTITLE frames) can produce an array.
        // Guard explicitly so a future shape change doesn't silently write bad data.
        const rawDiscSubtitle = metadata.common.discsubtitle as unknown;
        const discSubtitleInput = Array.isArray(rawDiscSubtitle)
            ? (rawDiscSubtitle[0] as string | null | undefined)
            : (rawDiscSubtitle as string | null | undefined);
        const discSubtitle = sanitizeTagString(discSubtitleInput) || null;
        const duration = Math.floor(metadata.format.duration || 0);
        const mime = metadata.format.codec || "audio/mpeg";
        // A tag that is not an ISRC (e.g. "PMEDIA") is dropped, never stored or sent.
        const isrc = normalizeIsrc(metadata.common.isrc?.[0]?.split(/[;,]/)[0]);

        // The album artist groups the album under one artist ("A feat. B" tracks stay on A's
        // album); the track artist stands in when there is none. Each name is paired only with
        // its own tag's MusicBrainz ids, never the other tag's.
        const albumArtistTag = sanitizeTagString(metadata.common.albumartist);
        const trackArtistTag = sanitizeTagString(metadata.common.artist);
        let rawArtistName = albumArtistTag || trackArtistTag;
        let nameTag: "albumartist" | "artist" | null = albumArtistTag ? "albumartist" : trackArtistTag ? "artist" : null;

        // Folder/filename fallback: If metadata is empty, try to parse from path structure
        if (!rawArtistName || rawArtistName.trim() === "") {
            const parsedArtist = extractArtistFromRelativePath(relativePath);

            if (parsedArtist) {
                logger.debug(
                    `[Scanner] No metadata artist found, using path: "${relativePath}" -> "${parsedArtist}"`
                );
                rawArtistName = parsedArtist;
                nameTag = null;
            } else {
                rawArtistName = "Unknown Artist";
                nameTag = null;
                logger.warn(
                    `[Scanner] Unknown Artist assigned for: ${relativePath} (no metadata, path parse failed)`
                );
            }
        }

        // Singles directory override: If metadata says "Various Artists" but the file
        // is in the Singles/ directory (Soulseek downloads), prefer the folder-derived
        // artist name. Soulseek files often have compilation metadata tags.
        if (
            canonicalizeVariousArtists(rawArtistName) === "Various Artists" &&
            relativePath.startsWith("Singles/")
        ) {
            const folderArtist = extractArtistFromRelativePath(relativePath);
            if (folderArtist && canonicalizeVariousArtists(folderArtist) !== "Various Artists") {
                logger.debug(
                    `[Scanner] Singles override: "${rawArtistName}" -> "${folderArtist}" for ${relativePath}`
                );
                rawArtistName = folderArtist;
                nameTag = null;
            }
        }

        const albumTitle = sanitizeTagString(metadata.common.album)
            || extractAlbumFromRelativePath(relativePath)
            || "Unknown Album";
        const year = metadata.common.year || null;

        // Resolve the artist through the single identity path, which trusts a
        // MusicBrainz id tag first and never splits band names on "&" or "and".
        const credit = parseCredit(
            rawArtistName,
            nameTag === "artist" ? (metadata.common.artists as string[] | undefined) : undefined
        );
        const artistName = credit.primary || rawArtistName;
        const artistMbid = primaryArtistMbid(
            nameTag === "albumartist"
                ? metadata.common.musicbrainz_albumartistid
                : nameTag === "artist"
                  ? metadata.common.musicbrainz_artistid
                  : undefined,
            credit
        );

        let artist = await resolveArtist(prisma, {
            name: artistName,
            mbid: artistMbid,
        });

        // Prefer better capitalisation when the tag has it and the stored row
        // does not (e.g. a row created from a lowercase folder name).
        if (
            artist.name !== artistName &&
            artist.name[0] === artist.name[0].toLowerCase() &&
            artistName[0] === artistName[0].toUpperCase()
        ) {
            artist = await prisma.artist.update({
                where: { id: artist.id },
                data: { name: artistName },
            });
        }

        // Check for local artist image if none set yet
        if (!artist.heroUrl) {
            const localImage = await findLocalArtistImage(musicPath, relativePath, artist.id);
            if (localImage) {
                const updated = await prisma.artist.updateMany({
                    where: { id: artist.id, heroUrl: null },
                    data: { heroUrl: localImage },
                });
                if (updated.count > 0) {
                    artist = { ...artist, heroUrl: localImage };
                }
            }
        }

        // Resolve the album through resolveAlbum, which checks rgMbid before the
        // normalised title so a release-group id always wins, and retries on a unique
        // violation.
        let isDiscoveryAlbum = false;

        // Album identity comes from the file's own release-group tag; an untagged album keeps
        // a placeholder until identification's album step names it from its songs' AcoustID
        // answers (services/albumIdentification.ts). A tag later replaces that id, never the reverse.
        const taggedRgMbid = metadata.common.musicbrainz_releasegroupid?.trim();

        const album = await resolveAlbum(prisma, {
            artistId: artist.id,
            title: albumTitle,
            rgMbid: isMbid(taggedRgMbid) ? taggedRgMbid : null,
            year,
            isCompilation: Boolean(metadata.common.compilation),
            // Runs only when a row is actually created: these checks cost several
            // queries and are pointless on a lookup hit.
            createData: async () => {
                // 1. legacy /music/discovery/ folder
                // 2. artist+album matches a discovery download job
                // 3. artist is discovery-only (has albums, none LIBRARY)
                const isDiscoveryByPath = this.isDiscoveryPath(relativePath);
                const isDiscoveryByJob = await this.isDiscoveryDownload(
                    artistName,
                    albumTitle
                );

                let isDiscoveryArtist = false;
                if (!isDiscoveryByPath && !isDiscoveryByJob) {
                    const artistAlbums = await prisma.album.findMany({
                        where: { artistId: artist.id },
                        select: { location: true },
                    });
                    if (artistAlbums.length > 0) {
                        isDiscoveryArtist = !artistAlbums.some(
                            (a) => a.location === "LIBRARY"
                        );
                        if (isDiscoveryArtist) {
                            logger.debug(
                                `[Scanner] Discovery-only artist detected: ${artistName}`
                            );
                        }
                    }
                }

                isDiscoveryAlbum =
                    isDiscoveryByPath || isDiscoveryByJob || isDiscoveryArtist;

                return {
                    primaryType: "Album",
                    location: isDiscoveryAlbum ? "DISCOVER" : "LIBRARY",
                };
            },
        });

        // Only track ownership for library albums; discovery albums are
        // provisional and must not appear as owned. Keyed on the album's OWN
        // rgMbid rather than a locally recomputed one, so a row that resolveAlbum
        // matched by identity is credited correctly.
        if (!isDiscoveryAlbum) {
            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: artist.id,
                        rgMbid: album.rgMbid,
                    },
                },
                create: {
                    rgMbid: album.rgMbid,
                    artistId: artist.id,
                    source: "native_scan",
                },
                update: {},
            });
        }

        await this.ensureAlbumCover(album, absolutePath, artistName, albumTitle);

        // Upsert track
        const track = await prisma.track.upsert({
            where: { filePath: relativePath },
            create: {
                albumId: album.id,
                title,
                trackNo,
                discNumber,
                discSubtitle,
                duration,
                mime,
                filePath: relativePath,
                fileModified: stats.mtime,
                fileSize: stats.size,
                isrc,
                isrcSource: isrc ? "id3" : null,
            },
            update: {
                albumId: album.id,
                title,
                trackNo,
                discNumber,
                discSubtitle,
                duration,
                mime,
                fileModified: stats.mtime,
                fileSize: stats.size,
                corrupt: false,
                ...(isrc ? { isrc, isrcSource: "id3" as const } : {}),
            },
        });

        // Extract embedded lyrics
        try {
            let plainLyrics: string | null = null;
            let syncedLyrics: string | null = null;

            // Check metadata.common.lyrics (ILyricsTag[])
            const lyricsArr = metadata.common.lyrics;
            if (lyricsArr && lyricsArr.length > 0) {
                for (const tag of lyricsArr) {
                    // Synced lyrics: convert syncText[] to LRC format
                    if (tag.syncText && tag.syncText.length > 0 && !syncedLyrics) {
                        syncedLyrics = tag.syncText
                            .map((entry) => {
                                const totalMs = entry.timestamp ?? 0;
                                const mins = Math.floor(totalMs / 60000);
                                const secs = Math.floor((totalMs % 60000) / 1000);
                                const cs = Math.floor((totalMs % 1000) / 10);
                                return `[${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}] ${entry.text}`;
                            })
                            .join("\n");
                    }
                    // Plain lyrics
                    if (tag.text && !plainLyrics) {
                        plainLyrics = tag.text;
                    }
                }
            }

            // Check raw Vorbis LYRICS tag for FLAC (may contain LRC directly)
            if (!syncedLyrics) {
                const nativeTags = metadata.native;
                for (const format of Object.keys(nativeTags)) {
                    const tags = nativeTags[format];
                    for (const tag of tags) {
                        if (tag.id === "LYRICS" && typeof tag.value === "string") {
                            const val = tag.value.trim();
                            // Detect LRC format by timestamp pattern
                            if (/^\[\d{2}:\d{2}/.test(val)) {
                                syncedLyrics = val;
                            } else if (!plainLyrics && val.length > 0) {
                                plainLyrics = val;
                            }
                        }
                    }
                }
            }

            if (plainLyrics || syncedLyrics) {
                await prisma.trackLyrics.upsert({
                    where: { track_id: track.id },
                    create: {
                        track_id: track.id,
                        plain_lyrics: plainLyrics,
                        synced_lyrics: syncedLyrics,
                        source: "embedded",
                    },
                    update: {
                        plain_lyrics: plainLyrics,
                        synced_lyrics: syncedLyrics,
                        source: "embedded",
                    },
                });
            }
        } catch (error) {
            // Non-critical -- don't fail the scan for lyrics
            logger.debug(`[Scanner] Failed to extract lyrics for ${relativePath}:`, error);
        }
    }
}
