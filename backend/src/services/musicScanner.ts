import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../utils/db";
import PQueue from "p-queue";
import { CoverArtExtractor } from "./coverArtExtractor";
import { deezerService } from "./deezer";
import {
    normalizeArtistName,
    areArtistNamesSimilar,
    canonicalizeVariousArtists,
    extractPrimaryArtist,
    parseArtistFromPath,
    extractArtistFromRelativePath,
    extractAlbumFromRelativePath,
    collapseForComparison,
    sanitizeTagString,
} from "../utils/artistNormalization";
import { backfillAllArtistCounts } from "./artistCountsService";

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

interface ScanResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksRemoved: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

export class MusicScannerService {
    private scanQueue = new PQueue({ concurrency: 10 });
    private progressCallback?: (progress: ScanProgress) => void;
    private coverArtExtractor?: CoverArtExtractor;

    constructor(
        progressCallback?: (progress: ScanProgress) => void,
        coverCachePath?: string
    ) {
        this.progressCallback = progressCallback;
        if (coverCachePath) {
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
            tracksRemoved: 0,
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
                    if (stats.size === 0) {
                        filesScanned++;
                        progress.filesScanned = filesScanned;
                        return;
                    }

                    const existingTrack = tracksByPath.get(relativePath);

                    // Check if file needs updating
                    if (existingTrack) {
                        if (
                            existingTrack.fileModified &&
                            existingTrack.fileModified >= fileModified
                        ) {
                            // File hasn't changed, skip
                            filesScanned++;
                            progress.filesScanned = filesScanned;
                            return;
                        }
                        // File changed, will update
                        result.tracksUpdated++;
                    } else {
                        // New file
                        result.tracksAdded++;
                    }

                    // Extract metadata and update database
                    await this.processAudioFile(
                        audioFile,
                        relativePath,
                        musicPath
                    );
                } catch (err: any) {
                    const error = {
                        file: audioFile,
                        error: err.message || String(err),
                    };
                    result.errors.push(error);
                    progress.errors.push(error);
                    logger.error(`Error processing ${audioFile}:`, err);
                } finally {
                    filesScanned++;
                    progress.filesScanned = filesScanned;
                    this.progressCallback?.(progress);
                }
            });
        }

        await this.scanQueue.onIdle();

        // Step 4: Remove tracks for files that no longer exist
        const scannedPaths = new Set(
            audioFiles.map((f) => path.relative(musicPath, f))
        );
        let tracksToRemove = existingTracks.filter(
            (t) => !scannedPaths.has(t.filePath)
        );

        if (tracksToRemove.length > 0) {
            // Safety: verify files are truly missing (guard against path normalization issues)
            const beforeCount = tracksToRemove.length;
            const existChecks = await Promise.all(
                tracksToRemove.map(async (t) => {
                    const fullPath = path.join(musicPath, t.filePath);
                    try {
                        await fs.promises.access(fullPath);
                        return { track: t, exists: true };
                    } catch {
                        return { track: t, exists: false };
                    }
                })
            );
            tracksToRemove = existChecks.filter((c) => !c.exists).map((c) => c.track);
            const pathMismatches = beforeCount - tracksToRemove.length;
            if (pathMismatches > 0) {
                logger.debug(
                    `${pathMismatches} track(s) had path mismatches but files exist on disk (skipped removal)`
                );
            }

            if (tracksToRemove.length > 0) {
                // Safety: don't delete tracks referenced by playlists
                const playlistProtected = await prisma.playlistItem.findMany({
                    where: { trackId: { in: tracksToRemove.map((t) => t.id) } },
                    select: { trackId: true },
                });
                const protectedIds = new Set(playlistProtected.map((p) => p.trackId));

                const safeToRemove = tracksToRemove.filter((t) => !protectedIds.has(t.id));
                const skipped = tracksToRemove.length - safeToRemove.length;

                if (skipped > 0) {
                    logger.debug(
                        `Skipped ${skipped} track(s) from removal (referenced by playlists)`
                    );
                }

                if (safeToRemove.length > 0) {
                    await prisma.track.deleteMany({
                        where: { id: { in: safeToRemove.map((t) => t.id) } },
                    });
                    result.tracksRemoved = safeToRemove.length;
                    logger.debug(`Removed ${safeToRemove.length} missing tracks`);
                }
            }
        }

        // Step 5: Clean up orphaned albums (albums with no tracks)
        // Note: playlist-referenced tracks are protected in Step 4 above,
        // so albums here should genuinely have no content
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
            `Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved} (${result.duration}ms)`
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

        // Also try with primary artist extracted (handles "Artist A feat. Artist B")
        const primaryArtist = extractPrimaryArtist(artistName);
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
                        location: "LIBRARY",
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
     * Process a single audio file and update database
     */
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
        const duration = Math.floor(metadata.format.duration || 0);
        const mime = metadata.format.codec || "audio/mpeg";

        // Artist and album info
        // IMPORTANT: Prefer albumartist over artist to keep albums grouped under the primary artist
        // This prevents featured artists from creating separate album entries
        // e.g., "Artist A feat. Artist B" track should still be under "Artist A"'s album
        let rawArtistName = sanitizeTagString(
            metadata.common.albumartist || metadata.common.artist
        );

        // Folder/filename fallback: If metadata is empty, try to parse from path structure
        if (!rawArtistName || rawArtistName.trim() === "") {
            const parsedArtist = extractArtistFromRelativePath(relativePath);

            if (parsedArtist) {
                logger.debug(
                    `[Scanner] No metadata artist found, using path: "${relativePath}" -> "${parsedArtist}"`
                );
                rawArtistName = parsedArtist;
            } else {
                rawArtistName = "Unknown Artist";
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
            }
        }

        const albumTitle = sanitizeTagString(metadata.common.album)
            || extractAlbumFromRelativePath(relativePath)
            || "Unknown Album";
        const year = metadata.common.year || null;

        // ALWAYS extract primary artist first - this handles both:
        // - Featured artists: "Artist A feat. Artist B" -> "Artist A"
        // - Collaborations: "Artist A & Artist B" -> "Artist A"
        // Band names like "Of Mice & Men" are preserved because extractPrimaryArtist
        // only splits on " feat.", " ft.", " featuring ", " & ", etc. (with spaces)
        const extractedPrimaryArtist = extractPrimaryArtist(rawArtistName);
        let artistName = extractedPrimaryArtist;

        // Canonicalize Various Artists variations (VA, V.A., <Various Artists>, etc.)
        artistName = canonicalizeVariousArtists(artistName);

        // Try to find artist with the canonicalized name first
        // This ensures "VA", "V.A.", etc. all find the canonical "Various Artists"
        const normalizedPrimaryName = normalizeArtistName(artistName);
        let artist = await prisma.artist.findFirst({
            where: { normalizedName: normalizedPrimaryName },
        });

        // If no match with primary name and we actually extracted something,
        // also try the full raw name (for bands like "Of Mice & Men")
        if (!artist && extractedPrimaryArtist !== rawArtistName) {
            const normalizedRawName = normalizeArtistName(rawArtistName);
            artist = await prisma.artist.findFirst({
                where: { normalizedName: normalizedRawName },
            });
            // If full name matches an existing artist, use that instead
            if (artist) {
                artistName = rawArtistName;
            }
        }

        // Update normalized name for use below
        const normalizedArtistName = normalizeArtistName(artistName);

        // If we found an artist, optionally update to better capitalization
        if (artist && artist.name !== artistName) {
            // Check if the new name has better capitalization (starts with uppercase)
            const currentNameIsLowercase =
                artist.name[0] === artist.name[0].toLowerCase();
            const newNameIsCapitalized =
                artistName[0] === artistName[0].toUpperCase();

            if (currentNameIsLowercase && newNameIsCapitalized) {
                logger.debug(
                    `Updating artist name capitalization: "${artist.name}" -> "${artistName}"`
                );
                artist = await prisma.artist.update({
                    where: { id: artist.id },
                    data: { name: artistName },
                });
            }
        }

        // Space-collapsed matching: catches "Dead Mau5" vs "Deadmau5"
        if (!artist) {
            const collapsedName = collapseForComparison(normalizedArtistName);
            const collapsedCandidates = await prisma.artist.findMany({
                where: {
                    normalizedName: {
                        startsWith: normalizedArtistName.substring(
                            0,
                            Math.min(5, normalizedArtistName.length)
                        ),
                    },
                },
                take: 50,
                select: {
                    id: true,
                    name: true,
                    normalizedName: true,
                    mbid: true,
                },
            });

            for (const candidate of collapsedCandidates) {
                if (collapseForComparison(candidate.normalizedName) === collapsedName) {
                    logger.debug(
                        `Space-collapsed match found: "${artistName}" -> "${candidate.name}"`
                    );
                    artist = candidate as any;
                    break;
                }
            }
        }

        if (!artist) {
            // Try fuzzy matching to catch typos like "the weeknd" vs "the weekend"
            // Only check artists with similar normalized names (performance optimization)
            const similarArtists = await prisma.artist.findMany({
                where: {
                    normalizedName: {
                        // Get artists whose normalized names start with similar prefix
                        startsWith: normalizedArtistName.substring(
                            0,
                            Math.min(3, normalizedArtistName.length)
                        ),
                    },
                },
                select: {
                    id: true,
                    name: true,
                    normalizedName: true,
                    mbid: true,
                },
            });

            // Check for fuzzy matches
            for (const candidate of similarArtists) {
                if (areArtistNamesSimilar(artistName, candidate.name, 95)) {
                    logger.debug(
                        `Fuzzy match found: "${artistName}" -> "${candidate.name}"`
                    );
                    artist = candidate as any;
                    break;
                }
            }
        }

        if (!artist) {
            // Try to find by MusicBrainz ID if available
            const artistMbid = metadata.common.musicbrainz_artistid?.[0];
            if (artistMbid) {
                artist = await prisma.artist.findUnique({
                    where: { mbid: artistMbid },
                });

                // If we have a real MBID but no artist exists, check if there's a temp artist we should consolidate
                if (!artist) {
                    const tempArtist = await prisma.artist.findFirst({
                        where: {
                            normalizedName: normalizedArtistName,
                            mbid: { startsWith: "temp-" },
                        },
                    });

                    if (tempArtist) {
                        // Consolidate: update temp artist to real MBID
                        logger.debug(
                            `[SCANNER] Consolidating temp artist "${tempArtist.name}" with real MBID: ${artistMbid}`
                        );
                        artist = await prisma.artist.update({
                            where: { id: tempArtist.id },
                            data: { mbid: artistMbid },
                        });
                    }
                }
            }

            if (!artist) {
                // Create new artist (use a temporary MBID for now)
                artist = await prisma.artist.create({
                    data: {
                        name: artistName,
                        normalizedName: normalizedArtistName,
                        mbid:
                            artistMbid || `temp-${Date.now()}-${Math.random()}`,
                        enrichmentStatus: "pending",
                    },
                });
            }
        }

        // Get or create album
        let album = await prisma.album.findFirst({
            where: {
                artistId: artist.id,
                title: albumTitle,
            },
        });

        if (!album) {
            // Try to find by release group MBID if available
            const albumMbid = metadata.common.musicbrainz_releasegroupid;
            if (albumMbid) {
                album = await prisma.album.findUnique({
                    where: { rgMbid: albumMbid },
                });
            }

            // Cross-artist fallback: if an album with the same title and year already
            // exists under any artist in the library, reuse it to prevent splitting
            // multi-artist / VA albums when albumartist tags are inconsistent.
            // Guards: title must not be generic, year must be known (non-null).
            if (!album && albumTitle !== "Unknown Album" && albumTitle !== "Unknown" && year !== null) {
                album = await prisma.album.findFirst({
                    where: {
                        title: albumTitle,
                        year: year,
                        location: "LIBRARY",
                    },
                });
                if (album) {
                    logger.debug(
                        `[Scanner] Cross-artist album match: "${albumTitle}" (${year}) -> album ${album.id} (artist ${album.artistId})`,
                    );
                }
            }

            if (!album) {
                // Create new album (use a temporary MBID for now)
                const rgMbid =
                    albumMbid || `temp-${Date.now()}-${Math.random()}`;

                // Determine if this is a discovery album:
                // 1. Check file path (legacy: /music/discovery/ folder)
                // 2. Check if artist+album matches a discovery download job
                // 3. Check if artist is a discovery-only artist (has DISCOVER albums but no LIBRARY albums)
                const isDiscoveryByPath = this.isDiscoveryPath(relativePath);
                const isDiscoveryByJob = await this.isDiscoveryDownload(
                    artistName,
                    albumTitle
                );

                // Check if this artist is discovery-only (has no LIBRARY albums)
                // If so, any new albums from them should also be DISCOVER
                let isDiscoveryArtist = false;
                if (!isDiscoveryByPath && !isDiscoveryByJob) {
                    const artistAlbums = await prisma.album.findMany({
                        where: { artistId: artist.id },
                        select: { location: true },
                    });

                    // Artist is discovery-only if they have albums but NONE are LIBRARY
                    if (artistAlbums.length > 0) {
                        const hasLibraryAlbums = artistAlbums.some(
                            (a) => a.location === "LIBRARY"
                        );
                        isDiscoveryArtist = !hasLibraryAlbums;
                        if (isDiscoveryArtist) {
                            logger.debug(
                                `[Scanner] Discovery-only artist detected: ${artistName}`
                            );
                        }
                    }
                }

                const isDiscoveryAlbum =
                    isDiscoveryByPath || isDiscoveryByJob || isDiscoveryArtist;

                album = await prisma.album.create({
                    data: {
                        title: albumTitle,
                        artistId: artist.id,
                        rgMbid,
                        year,
                        primaryType: "Album",
                        location: isDiscoveryAlbum ? "DISCOVER" : "LIBRARY",
                    },
                });

                // Only create OwnedAlbum record for library albums (not discovery)
                // Discovery albums are temporary and should not appear in the user's library
                if (!isDiscoveryAlbum) {
                    await prisma.ownedAlbum.create({
                        data: {
                            rgMbid,
                            artistId: artist.id,
                            source: "native_scan",
                        },
                    });
                }
            }

            // Extract cover art if we have an extractor
            // Re-extract if: no cover, OR native cover file is missing
            if (this.coverArtExtractor) {
                let needsExtraction = !album.coverUrl;

                // Check if existing native cover file is missing
                if (album.coverUrl?.startsWith("native:")) {
                    const nativePath = album.coverUrl.replace("native:", "");
                    const coverCachePath = path.join(
                        path.dirname(absolutePath),
                        "..",
                        "..",
                        "cache",
                        "covers",
                        nativePath
                    );
                    // Use the extractor's cache path instead
                    const extractorCachePath = path.join(
                        (this.coverArtExtractor as any).coverCachePath,
                        nativePath
                    );
                    if (!fs.existsSync(extractorCachePath)) {
                        needsExtraction = true;
                    }
                }

                if (needsExtraction) {
                    const coverPath =
                        await this.coverArtExtractor.extractCoverArt(
                            absolutePath,
                            album.id
                        );
                    if (coverPath) {
                        await prisma.album.update({
                            where: { id: album.id },
                            data: { coverUrl: `native:${coverPath}` },
                        });
                    } else {
                        // No embedded art, try fetching from Deezer
                        try {
                            const deezerCover =
                                await deezerService.getAlbumCover(
                                    artistName,
                                    albumTitle
                                );
                            if (deezerCover) {
                                await prisma.album.update({
                                    where: { id: album.id },
                                    data: { coverUrl: deezerCover },
                                });
                            }
                        } catch (error) {
                            // Silently fail - cover art is optional
                        }
                    }
                }
            }
        }

        // Upsert track
        const track = await prisma.track.upsert({
            where: { filePath: relativePath },
            create: {
                albumId: album.id,
                title,
                trackNo,
                duration,
                mime,
                filePath: relativePath,
                fileModified: stats.mtime,
                fileSize: stats.size,
            },
            update: {
                albumId: album.id,
                title,
                trackNo,
                duration,
                mime,
                fileModified: stats.mtime,
                fileSize: stats.size,
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
