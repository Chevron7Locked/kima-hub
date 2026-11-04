import * as fs from "fs";
import { logger } from "../utils/logger";
import * as path from "path";
import { parseFile, type IAudioMetadata, type ITag } from "music-metadata";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import PQueue from "p-queue";
import { CoverArtExtractor } from "./coverArtExtractor";
import { findAlbumArtwork } from "./artwork";
import { isPlaceholderArtistName, sanitizeTagString } from "../utils/artistNormalization";
import { artistIdentityKey, isMbid, resolveArtist } from "./artistIdentity";
import { JointCreditFiler, leadingParts } from "./jointCredit";
import { albumFolder, electAlbumArtist, fileCredit, type ArtistCandidate, type FileCredit } from "./albumArtistVote";
import { normalizeIsrc } from "./recordingMatch";
import { albumIdentityKey, resolveAlbum } from "./albumIdentity";
import { backfillAllArtistCounts } from "./artistCountsService";
import { findLocalArtistImage } from "./imageStorage";
import { closeStagesForMissingTracks } from "./missingFileStages";
import { runReconcile } from "./libraryReconcile";
import { pruneEmptyAlbumsAndArtists } from "./libraryPrune";
import { askedAgain } from "./stageReopen";
import { discoverEvidence, isDiscoverEvidence, loadDiscoverRecords } from "./discovery/discoverEvidence";

/**
 * A replaced file reopens its stage records as `pending` with evidence "file
 * changed". `blocked` records (a human decision) stay. A `working` record reopens
 * too: the job on the old file then holds a stale claim, and its answer is dropped.
 */
async function reopenStagesForChangedFile(trackId: string): Promise<void> {
    const reopened = await prisma.$executeRaw`
        UPDATE "TrackStage"
           SET ${askedAgain},
               "decidedAt" = NULL,
               "decidedBy" = NULL,
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
           SET ${askedAgain}, evidence = jsonb_build_object('reason', 'file returned')
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

/** What filing a song reads of its tags: kept between the vote step and filing, so nothing else (the quality report, the other native tags) is held. */
export interface SlimMetadata {
    common: IAudioMetadata["common"];
    format: { duration?: number; codec?: string };
    /** Only the lyrics tags. */
    native: Record<string, ITag[]>;
}

export function slimMetadata(metadata: IAudioMetadata): SlimMetadata {
    const native: Record<string, ITag[]> = {};
    for (const [format, tags] of Object.entries(metadata.native ?? {})) {
        const lyrics = tags.filter((tag) => tag.id === "LYRICS");
        if (lyrics.length > 0) native[format] = lyrics;
    }
    return { common: metadata.common, format: { duration: metadata.format.duration, codec: metadata.format.codec }, native };
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
     * Scans the music folder: adds and updates songs, flags missing files, retires confirmed-gone ones (in delete
     * mode) and prunes empty albums and artists.
     */
    async scanLibrary(musicPath: string): Promise<ScanResult> {
        const startTime = Date.now();
        // What a scan decided about a joint credit holds for that scan only: the next asks again.
        this.groupFilings = new Map();
        this.jointFiler = new JointCreditFiler();
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

        const existingTracks = await prisma.track.findMany({
            select: {
                id: true,
                filePath: true,
                fileModified: true,
                missingSince: true,
            },
        });

        const audioFiles = await this.findAudioFiles(musicPath, existingTracks.map((t) => t.filePath));
        logger.debug(`Found ${audioFiles.length} audio files`);

        const tracksByPath = new Map(
            existingTracks.map((t) => [t.filePath, t])
        );

        // An empty music folder (nothing in it at all, not even the artist folders) while the library holds songs is
        // a drive that is not mounted, not a deletion: the scan stops before anything is flagged, so nothing can be
        // retired, and fails so whoever started it is told.
        const present = existingTracks.filter((t) => !t.missingSince).length;
        if (present > 0 && (await fs.promises.readdir(musicPath)).length === 0) {
            const message = `The music folder (${musicPath}) is empty, but the library has ${present} songs; nothing was marked missing. Is the drive mounted?`;
            throw new Error(message);
        }

        const progress: ScanProgress = {
            filesScanned: 0,
            filesTotal: audioFiles.length,
            currentFile: "",
            errors: [],
        };

        const markFailed = async (audioFile: string, err: any) => {
            const error = { file: audioFile, error: err.message || String(err) };
            result.errors.push(error);
            progress.errors.push(error);
            logger.error(`Error processing ${audioFile}:`, err);

            const existingTrack = tracksByPath.get(path.relative(musicPath, audioFile));
            if (existingTrack) {
                await prisma.track.update({ where: { id: existingTrack.id }, data: { corrupt: true } });
                result.tracksCorrupt++;
                logger.debug(`Marked track as corrupt: ${path.relative(musicPath, audioFile)}`);
            }
        };

        // 1. The files to read: new ones, and ones changed since they were read.
        const changed: string[] = [];
        for (const audioFile of audioFiles) {
            this.scanQueue.add(async () => {
                try {
                    const relativePath = path.relative(musicPath, audioFile);
                    const stats = await fs.promises.stat(audioFile);
                    // An empty file is an unfinished download or a stub.
                    if (stats.size === 0) return finished();
                    const existingTrack = tracksByPath.get(relativePath);
                    if (existingTrack?.fileModified && existingTrack.fileModified >= stats.mtime) return finished();
                    changed.push(audioFile);
                } catch (err: any) {
                    await markFailed(audioFile, err).catch((markErr) =>
                        logger.error(`Could not record the failure for ${audioFile}:`, markErr),
                    );
                    finished();
                }
            });
        }
        await this.scanQueue.onIdle();

        function finished() {
            progress.filesScanned++;
        }

        // 2. Each album those files belong to elects its artist from all of its songs, the unchanged ones included,
        // so a song added to an album is filed with it.
        const touched = new Set(changed.map((f) => albumFolder(path.relative(musicPath, f))));
        const voters = audioFiles.filter((f) => touched.has(albumFolder(path.relative(musicPath, f))));
        const credits = new Map<string, FileCredit>();
        // A changed file's tags, read once here and handed to the filing step below.
        const changedSet = new Set(changed);
        const parsed = new Map<string, SlimMetadata>();
        for (const audioFile of voters) {
            this.scanQueue.add(async () => {
                try {
                    progress.currentFile = path.relative(musicPath, audioFile);
                    this.progressCallback?.(progress);
                    const metadata = await parseFile(audioFile, { skipCovers: true });
                    credits.set(audioFile, fileCredit(metadata.common, path.relative(musicPath, audioFile)));
                    if (changedSet.has(audioFile)) parsed.set(audioFile, slimMetadata(metadata));
                } catch {
                    // A file whose tags cannot be read has no vote; if it is to be filed, filing it reports the error.
                }
            });
        }
        await this.scanQueue.onIdle();

        const albums = new Map<string, FileCredit[]>();
        for (const audioFile of [...voters].sort()) {
            const credit = credits.get(audioFile);
            if (!credit) continue;
            const group = albums.get(credit.groupKey);
            if (group) group.push(credit);
            else albums.set(credit.groupKey, [credit]);
        }
        const elected = new Map<string, ArtistCandidate>();
        for (const [key, group] of albums) {
            const artist = electAlbumArtist(group);
            if (artist) elected.set(key, artist);
        }

        // 3. File each changed song under its album's artist, one at a time: filing reads and writes rows other
        // songs of the album share.
        // In path order, so which song of an album is filed first does not depend on which check finished first.
        changed.sort();
        for (const audioFile of changed) {
            await this.scanQueue.add(async () => {
                const relativePath = path.relative(musicPath, audioFile);
                try {
                    progress.currentFile = relativePath;
                    this.progressCallback?.(progress);

                    const existingTrack = tracksByPath.get(relativePath);
                    // Every recorded answer came from the old content, so every stage is asked again.
                    if (existingTrack) await reopenStagesForChangedFile(existingTrack.id);

                    await this.processAudioFile(audioFile, relativePath, musicPath, elected, parsed.get(audioFile));
                    if (existingTrack) result.tracksUpdated++;
                    else result.tracksAdded++;
                } catch (err: any) {
                    await markFailed(audioFile, err);
                } finally {
                    parsed.delete(audioFile);
                    finished();
                    this.progressCallback?.(progress);
                }
            });
        }
        await this.scanQueue.onIdle();

        const scannedPaths = new Set(
            audioFiles.map((f) => path.relative(musicPath, f))
        );

        // A file the walk did not list may still be on disk (a second path to a song it
        // listed, a path that normalises differently): those are checked there.
        const pathCandidates = existingTracks.filter(
            (t) => !scannedPaths.has(t.filePath)
        );
        const existChecks = await Promise.all(
            pathCandidates.map(async (t) => {
                const fullPath = path.join(musicPath, t.filePath);
                try {
                    await fs.promises.access(fullPath);
                    return { track: t, exists: true };
                } catch (err) {
                    // Only "no such file" is gone. Anything else (no permission, an I/O error, a stale network
                    // share) says nothing about the file, so it is not flagged.
                    return { track: t, exists: (err as NodeJS.ErrnoException).code !== "ENOENT" };
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

        // A missing file is flagged, never deleted on sight: deleting the row would take its plays, likes, stage
        // records and embedding with it, and the scan that finds the file again clears the flag.
        if (pathCandidates.length > 0) {
            const vanished = existChecks.filter((c) => !c.exists).map((c) => c.track);
            const pathMismatches = pathCandidates.length - vanished.length;
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

        // Retires tracks flagged by the previous scan and still gone (RemovalLog records them; the `flag` mode only
        // flags). Before the album and artist pruning below, so what it empties goes too.
        const reconcile = await runReconcile(new Date(startTime));
        result.tracksRemoved = reconcile.removed;

        // Albums with no songs, then artists with no albums, go.
        await pruneEmptyAlbumsAndArtists();

        result.duration = Date.now() - startTime;
        logger.debug(
            `Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} missing:${result.tracksMissing} corrupt:${result.tracksCorrupt} removed:${result.tracksRemoved} (${result.duration}ms)`
        );

        // The artists' stored counts, recomputed in the background.
        backfillAllArtistCounts().catch((err) => {
            logger.error("[Scan] Artist counts update failed:", err);
        });

        return result;
    }

    /**
     * Every audio file under the music folder, following links. A linked song is listed where the link stands, so
     * it moves with the link and not with its target. One real file is one song, however many paths reach it: real
     * paths come first, then links, the ones already holding a recorded song before the rest, so a new link never
     * takes a song from the path it is filed under. A link that cannot be followed is skipped and logged, never fatal;
     * a real folder that cannot be read still stops the scan, since nothing it holds could be told from gone.
     */
    private async findAudioFiles(dirPath: string, recordedPaths: string[]): Promise<string[]> {
        const realRoot = await fs.promises.realpath(dirPath);
        const files: string[] = [];
        const walkedFolders = new Set<string>();
        const takenFiles = new Set<string>();
        const links: string[] = [];
        const skipped: string[] = [];

        // `real` is `dir` with its links resolved. Below it nothing is a link until one is queued, so real paths are
        // joined, not asked of the disk: a library with no links pays nothing.
        async function walk(dir: string, real: string, viaLink: boolean) {
            if (walkedFolders.has(real)) return;
            walkedFolders.add(real);

            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch (err) {
                if (!viaLink) throw err;
                skipped.push(`${dir}: ${(err as Error).message}`);
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const realPath = path.join(real, entry.name);

                if (entry.isDirectory()) {
                    await walk(fullPath, realPath, viaLink);
                } else if (entry.isSymbolicLink()) {
                    links.push(fullPath);
                } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                    if (takenFiles.has(realPath)) continue;
                    takenFiles.add(realPath);
                    files.push(fullPath);
                }
            }
        }

        async function follow(link: string) {
            let target: string;
            let stats: fs.Stats;
            try {
                target = await fs.promises.realpath(link);
                stats = await fs.promises.stat(target);
            } catch (err) {
                skipped.push(`${link}: ${(err as Error).message}`);
                return;
            }
            if (stats.isDirectory()) {
                // The folder holding the music folder is a loop by another name, and could be the whole disk.
                if (realRoot.startsWith(target.endsWith(path.sep) ? target : target + path.sep)) {
                    skipped.push(`${link}: it points above the music folder`);
                    return;
                }
                await walk(link, target, true);
            } else if (stats.isFile() && AUDIO_EXTENSIONS.has(path.extname(link).toLowerCase())) {
                if (takenFiles.has(target)) return;
                takenFiles.add(target);
                files.push(link);
            }
        }

        await walk(dirPath, realRoot, false);

        if (links.length > 0) {
            // Each recorded song's path and every folder on the way to it.
            const recorded = new Set<string>();
            for (const recordedPath of recordedPaths) {
                for (let at = recordedPath; path.dirname(at) !== at; at = path.dirname(at)) recorded.add(at);
            }
            const order = (link: string) => (recorded.has(path.relative(dirPath, link)) ? 0 : 1);
            // A followed folder can hold more links, which are a round of their own.
            while (links.length > 0) {
                const round = links.splice(0).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
                for (const link of round) await follow(link);
            }
        }

        if (skipped.length > 0) {
            logger.warn(`[Scanner] ${skipped.length} link(s) could not be followed, first: ${skipped[0]}`);
        }
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

    /** Where each album group's joint credit is filed, decided once per group per scan (see filedCredit). */
    private groupFilings = new Map<string, Promise<ArtistCandidate>>();
    private jointFiler = new JointCreditFiler();

    /**
     * The artist an album group's credit is filed under, decided once for the group so its songs never split between
     * two artists. A credit that is not a joint one is filed as it is. For a joint credit: an album Discover holds is
     * left alone; an album that already has songs keeps them together where they sit, the joint-credit artist or the
     * first artist (the re-file moves a whole album when the rule says it belongs elsewhere); a new album takes the
     * joint-credit rule (jointCredit.ts), except one Discover's records say is Discover's, which keeps its credit.
     */
    private filedCredit(groupKey: string, chosen: ArtistCandidate, albumTitle: string, rgMbid: string | null): Promise<ArtistCandidate> {
        const memo = `${groupKey}\n${chosen.mbid ?? artistIdentityKey(chosen.name)}`;
        let filed = this.groupFilings.get(memo);
        if (!filed) {
            filed = this.decideFiling(groupKey, chosen, albumTitle, rgMbid);
            this.groupFilings.set(memo, filed);
        }
        return filed;
    }

    private async decideFiling(groupKey: string, chosen: ArtistCandidate, albumTitle: string, rgMbid: string | null): Promise<ArtistCandidate> {
        const leads = chosen.mbid ? [] : leadingParts(chosen.name);
        if (!leads.length) return chosen;

        const [folder, ...rest] = groupKey.split("\n");
        const sameAlbum: Prisma.TrackWhereInput =
            folder === "file"
                ? { filePath: rest.join("\n") }
                : {
                      filePath: folder === "." ? { not: { contains: "/" } } : { startsWith: `${folder}/` },
                      album: { identityKey: albumIdentityKey(albumTitle) },
                  };
        const whole = artistIdentityKey(chosen.name);
        const leadKeys = leads.map(artistIdentityKey);
        // Loose files in the music root are one group by album title whoever made them, so only the songs this credit
        // could have been filed with count as this album's.
        const sitting = (
            await prisma.track.findMany({
                where: sameAlbum,
                select: { album: { select: { location: true, artist: { select: { identityKey: true, name: true, mbid: true } } } } },
            })
        ).filter((t) => folder !== "." || t.album.artist.identityKey === whole || leadKeys.includes(t.album.artist.identityKey));
        if (sitting.some((t) => t.album.location !== "LIBRARY")) return chosen;
        if (sitting.some((t) => t.album.artist.identityKey === whole)) return chosen;
        for (const key of leadKeys) {
            const lead = sitting.map((t) => t.album.artist).find((a) => a.identityKey === key);
            if (lead) return lead.mbid ? { name: lead.name, mbid: lead.mbid } : { name: lead.name };
        }

        const evidence = discoverEvidence({ artistName: chosen.name, title: albumTitle, rgMbid }, await loadDiscoverRecords());
        if (isDiscoverEvidence(evidence)) return chosen;
        return (await this.jointFiler.file(chosen)).candidate;
    }

    private async processAudioFile(
        absolutePath: string,
        relativePath: string,
        musicPath: string,
        elected: ReadonlyMap<string, ArtistCandidate> = new Map(),
        read?: SlimMetadata
    ): Promise<void> {
        // The tags the vote step already read; a file it could not read is read again, to report why. Nothing here
        // uses the embedded pictures (the cover is extracted from the file itself), so they are never read.
        const metadata = read ?? slimMetadata(await parseFile(absolutePath, { skipCovers: true }));
        const stats = await fs.promises.stat(absolutePath);

        // Parse basic info
        const title =
            sanitizeTagString(metadata.common.title) ||
            path.basename(relativePath, path.extname(relativePath));
        const trackNo = metadata.common.track.no || 0;
        const discNumber = metadata.common.disk.no || null;
        // Usually a string; some tag formats (several Vorbis DISCSUBTITLE frames) give an array.
        const rawDiscSubtitle = metadata.common.discsubtitle as unknown;
        const discSubtitleInput = Array.isArray(rawDiscSubtitle)
            ? (rawDiscSubtitle[0] as string | null | undefined)
            : (rawDiscSubtitle as string | null | undefined);
        const discSubtitle = sanitizeTagString(discSubtitleInput) || null;
        const duration = Math.floor(metadata.format.duration || 0);
        const mime = metadata.format.codec || "audio/mpeg";
        // A tag that is not an ISRC (e.g. "PMEDIA") is dropped, never stored or sent.
        const isrc = normalizeIsrc(metadata.common.isrc?.[0]?.split(/[;,]/)[0]);

        // The album's artist is elected from all of its songs before any is filed (albumArtistVote.ts); with no
        // leader the song keeps its own.
        const credit = fileCredit(metadata.common, relativePath);
        const credited = elected.get(credit.groupKey) ?? credit.candidate;
        const albumTitle = credit.albumTitle;
        const year = metadata.common.year || null;
        // The file's release-group tag names the album; an untagged album keeps a placeholder id until identification
        // names it (albumIdentification.ts), and a tag later replaces that id, never the reverse. resolveAlbum matches
        // by id before title and retries on a unique violation.
        const taggedRgMbid = metadata.common.musicbrainz_releasegroupid?.trim();
        const tagged = isMbid(taggedRgMbid) ? taggedRgMbid : null;

        // A joint credit with no ids may be filed under its first artist (jointCredit.ts); Discover's records still
        // match the credit as the files give it.
        const chosen = await this.filedCredit(credit.groupKey, credited, albumTitle, tagged);
        const artistName = chosen.name;
        const artistMbid = chosen.mbid;

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

        const album = await resolveAlbum(prisma, {
            artistId: artist.id,
            title: albumTitle,
            rgMbid: tagged,
            year,
            isCompilation: Boolean(metadata.common.compilation),
            // Only for a new row: the checks cost several queries. Discover's records say whether it is Discover's (it
            // has no folder of its own); read fresh, as Discover writes its download record before the download starts.
            createData: async () => {
                const evidence = discoverEvidence(
                    { artistName: credited.name, title: albumTitle, rgMbid: tagged },
                    await loadDiscoverRecords(),
                );
                return { primaryType: "Album", location: isDiscoverEvidence(evidence) ? "DISCOVER" : "LIBRARY" };
            },
        });

        // A library album is the listener's, a Discover one no one's, by the album row's own location (so every later
        // scan agrees). Keyed on the row's own rgMbid, so an album resolveAlbum matched by identity is credited right.
        if (album.location === "LIBRARY") {
            // Songs of one album are filed side by side, so the row may appear between a look and a write: an insert
            // that skips an existing row cannot collide where an upsert can.
            await prisma.ownedAlbum.createMany({
                data: [{ rgMbid: album.rgMbid, artistId: artist.id, source: "native_scan" }],
                skipDuplicates: true,
            });
        }

        // MusicBrainz is asked about a name with the artist's album titles as proof, so an artist it could not find
        // is asked again once it gains an album title (an album with no song yet), never a placeholder like
        // Unknown Artist or Various Artists.
        if (
            artist.enrichmentStatus === "unresolvable" &&
            !isPlaceholderArtistName(artist.name) &&
            (await prisma.track.count({ where: { albumId: album.id } })) === 0
        ) {
            await prisma.artist.updateMany({
                where: { id: artist.id, enrichmentStatus: "unresolvable" },
                data: { enrichmentStatus: "pending", enrichmentFailures: 0 },
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
