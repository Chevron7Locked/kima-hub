/**
 * Every path that removes a Discover album (clear, the weekly run, the orphan sweeps) goes through here. Lidarr deletes
 * the albums it holds; Kima deletes files only for an album a completed Soulseek download names; anything not deleted
 * stays as it is and is reported in the tray. Rows go only after the files, so a scan cannot bring them back.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { lidarrService } from "../lidarr";
import { artistNamed, isMbid } from "../artistIdentity";
import { updateArtistCounts } from "../artistCountsService";
import { notificationService } from "../notificationService";
import { announcePlaylistsChanged, playlistsHoldingTracks } from "../playlistEvents";
import { resolveWithinMusicRoot } from "../../routes/library/trackPath";
import { removeDiscoveryAlbum } from "./lidarrRemoval";
import { RUNNING_BATCH, lookupKey, sameName } from "./discoverEvidence";

/** A suggestion row's names, for comparing with a record's. */
interface NamedRow {
    artistName: string;
    albumTitle: string;
}

/** Whether a suggestion row names the same artist and title as the record, by `nameKey`. */
const namesRecord = (row: NamedRow, ref: NamedRow) =>
    sameName(row.artistName, ref.artistName) && sameName(row.albumTitle, ref.albumTitle);

/** What names a Discover album: the suggestion's or download job's release-group id, artist and title. */
export interface AlbumRef {
    rgMbid: string;
    artistName: string;
    albumTitle: string;
}

/** An album that was not deleted, with the reason in words for the listener. */
export interface ClearFailure {
    artistName: string;
    albumTitle: string;
    reason: string;
}

/**
 * The scanned album a Discover suggestion or download job became: by release-group id, else by artist and title
 * (sameName). When a listener's own copy has the same name, `at` picks: Discover for a like or a clear, the library for
 * an unlike.
 */
export async function findScannedAlbum(ref: AlbumRef, at: "DISCOVER" | "LIBRARY") {
    const exact = await prisma.album.findUnique({ where: { rgMbid: ref.rgMbid }, include: { artist: true } });
    if (exact) return exact;
    // By name: identification can give a liked album a new id after the suggestion recorded the old one.
    const ofArtist = await prisma.album.findMany({
        where: { artist: artistNamed(ref.artistName) },
        // AlbumLocation is declared LIBRARY, DISCOVER, so descending puts DISCOVER first.
        orderBy: [{ location: at === "DISCOVER" ? "desc" : "asc" }, { id: "asc" }],
        include: { artist: true },
    });
    const named = ofArtist.filter((a) => sameName(a.title, ref.albumTitle));
    if (at === "DISCOVER" || named.length < 2) return named[0] ?? null;
    // In the library, the album a like brought in carries the like's mark; a listener's own copy of the same name
    // does not.
    const liked = await prisma.ownedAlbum.findMany({
        where: { source: "discovery_liked", rgMbid: { in: named.map((a) => a.rgMbid) } },
        select: { artistId: true, rgMbid: true },
    });
    return named.find((a) => liked.some((o) => o.artistId === a.artistId && o.rgMbid === a.rgMbid)) ?? named[0];
}

/** The scanned album for a record, only when it is a DISCOVER album: a listener's own copy is never Discover's. */
export async function findDiscoverAlbum(ref: AlbumRef) {
    const album = await findScannedAlbum(ref, "DISCOVER");
    return album?.location === "DISCOVER" ? album : null;
}

/** Removes a folder inside the music root only when it is empty; the root itself and anything outside it are left. */
function removeEmptyDirectoryUnderMusicRoot(dirPath: string): void {
    const musicRoot = path.resolve(config.music.musicPath);
    if (!dirPath.startsWith(musicRoot + path.sep)) return;
    try {
        if (!fs.existsSync(dirPath)) return;
        fs.rmdirSync(dirPath);
    } catch (fsError: any) {
        // ENOTEMPTY is the normal answer for a folder that still holds other music.
        logger.debug(`[DiscoverClear] Folder kept ${dirPath}: ${fsError.message}`);
    }
}

/** A plain reason for a file Kima could not delete, from the error code. */
function fileFailureReason(error: NodeJS.ErrnoException): string {
    switch (error.code) {
        case "EACCES":
        case "EPERM":
            return "Kima isn't allowed to delete these files; check the music folder's permissions";
        case "EROFS":
            return "the music folder is read-only, so Kima cannot delete these files";
        case "EBUSY":
            return "a file is in use by another program, so Kima could not delete it";
        default:
            return `Kima could not delete a file (${error.code ?? "unknown error"}: ${error.message})`;
    }
}

/**
 * Deletes a DISCOVER album's song files inside the music root (a path outside it is skipped, a file already gone
 * counts as deleted). If any file stays, the reason comes back and no folder is touched; otherwise empty album and
 * artist folders go.
 */
async function deleteAlbumFiles(albumId: string): Promise<{ failed: string } | null> {
    const tracks = await prisma.track.findMany({ where: { albumId }, select: { filePath: true } });
    const albumDirs = new Set<string>();
    const reasons = new Set<string>();
    let deleted = 0;
    for (const track of tracks) {
        const filePath = track.filePath ? resolveWithinMusicRoot(track.filePath) : null;
        if (!filePath) {
            logger.debug(`[DiscoverClear] Refused file outside the music root: ${track.filePath}`);
            continue;
        }
        try {
            fs.rmSync(filePath, { force: true });
            deleted++;
        } catch (fileError: any) {
            logger.warn(`[DiscoverClear] File not deleted ${filePath}: ${fileError.message}`);
            reasons.add(fileFailureReason(fileError));
        }
        albumDirs.add(path.dirname(filePath));
    }
    if (reasons.size > 0) {
        const kept = deleted > 0 ? `; ${deleted} of ${tracks.length} files were deleted and stay gone` : "";
        return { failed: `${[...reasons].join("; ")}${kept}` };
    }
    for (const albumDir of albumDirs) {
        removeEmptyDirectoryUnderMusicRoot(albumDir);
        removeEmptyDirectoryUnderMusicRoot(path.dirname(albumDir));
    }
    return null;
}

/** The songs' Discover records, playlist entries, songs and album, in one transaction; playlists are told after it. */
async function deleteAlbumRows(albumId: string | null, suggestionId: string | null): Promise<void> {
    const { playlists, artistId } = await prisma.$transaction(async (tx) => {
        const album = albumId
            ? await tx.album.findFirst({ where: { id: albumId, location: "DISCOVER" }, include: { tracks: { select: { id: true } } } })
            : null;
        const trackIds = album?.tracks.map((t) => t.id) ?? [];
        const owners = [...(suggestionId ? [{ discoveryAlbumId: suggestionId }] : []), ...(trackIds.length ? [{ trackId: { in: trackIds } }] : [])];
        if (owners.length > 0) await tx.discoveryTrack.deleteMany({ where: { OR: owners } });
        if (!album) return { playlists: [], artistId: null };
        // The songs' playlist entries go with them: told once the transaction commits.
        const holding = await playlistsHoldingTracks(tx, { albumId: album.id });
        await tx.track.deleteMany({ where: { albumId: album.id } });
        await tx.album.delete({ where: { id: album.id } });
        return { playlists: holding, artistId: album.artistId };
    });
    announcePlaylistsChanged(playlists);
    if (artistId) {
        // The album is gone either way; a recount that fails is caught up by the next scan's.
        await updateArtistCounts(artistId).catch((error) =>
            logger.warn("[DiscoverClear] Artist counts not updated after clearing an album:", error),
        );
    }
}

/** The Lidarr album id Kima recorded for an album, from any suggestion or download job that names it. */
async function recordedLidarrAlbumId(ref: AlbumRef, rgMbids: string[]): Promise<number | null> {
    const recorded = await prisma.discoveryAlbum.findMany({
        where: { lidarrAlbumId: { not: null } },
        orderBy: { weekStartDate: "desc" },
        select: { rgMbid: true, artistName: true, albumTitle: true, lidarrAlbumId: true },
    });
    const suggestion = recorded.find((r) => rgMbids.includes(r.rgMbid) || namesRecord(r, ref));
    if (suggestion?.lidarrAlbumId) return suggestion.lidarrAlbumId;
    const job = await prisma.downloadJob.findFirst({
        where: { lidarrAlbumId: { not: null }, targetMbid: { in: rgMbids } },
        orderBy: { createdAt: "desc" },
        select: { lidarrAlbumId: true },
    });
    return job?.lidarrAlbumId ?? null;
}

/**
 * Whether Lidarr holds the album: the id Kima was given or recorded, else Lidarr asked by release-group id. An album
 * Kima cannot rule out as Lidarr's, because Lidarr is on but does not answer, is reported.
 */
async function lidarrHolding(
    target: ClearTarget,
    rgMbids: string[],
): Promise<{ lidarrAlbumId: number | null; rgMbid: string } | { unknown: string }> {
    const known = target.lidarrAlbumId ?? (await recordedLidarrAlbumId(target, rgMbids));
    if (known) return { lidarrAlbumId: known, rgMbid: target.rgMbid };
    if (!(await lidarrService.isEnabled())) return { lidarrAlbumId: null, rgMbid: target.rgMbid };
    for (const rgMbid of rgMbids.filter(isMbid)) {
        try {
            const held = await lidarrService.findAlbumByForeignId(rgMbid);
            if (held) return { lidarrAlbumId: held.id, rgMbid };
        } catch (error: any) {
            return { unknown: `Lidarr could not be reached or answered with an error: ${error?.message || "no message"}` };
        }
    }
    return { lidarrAlbumId: null, rgMbid: target.rgMbid };
}

const UNKNOWN_SOURCE =
    "Kima can't tell where this album's files came from, so it left them; delete them in Lidarr or by hand";

/**
 * Whether a completed download job naming the album (by id, or artist and title) last fetched it from Soulseek; any
 * job for the album that touched Lidarr says no.
 */
async function isKnownSoulseekAlbum(ref: AlbumRef, rgMbids: string[]): Promise<boolean> {
    const candidates = await prisma.downloadJob.findMany({
        select: { status: true, lidarrAlbumId: true, metadata: true, targetMbid: true, subject: true },
    });
    const wanted = `${ref.artistName} ${ref.albumTitle}`;
    const jobs = candidates.filter(
        (j) => (j.targetMbid !== null && rgMbids.includes(j.targetMbid)) || sameName(j.subject, wanted),
    );
    const source = (j: (typeof jobs)[number]) => (j.metadata as { currentSource?: string } | null)?.currentSource;
    if (jobs.some((j) => j.lidarrAlbumId !== null || source(j) === "lidarr")) return false;
    return jobs.some((j) => j.status === "completed" && source(j) === "soulseek");
}

/** One Discover album to clear: its names, the Lidarr album id if known, and the suggestion row it belongs to if any. */
interface ClearTarget extends AlbumRef {
    lidarrAlbumId: number | null;
    suggestionId: string | null;
}

type ClearResult = { cleared: true } | { cleared: false; reason: string };

/**
 * Clears one Discover album: Lidarr's is deleted by Lidarr (lidarrRemoval), a known Soulseek one by deleting its
 * files, then the rows go. Anything else, or a file that stays, changes nothing and returns the reason. A scanned album
 * that is the library's is left; only the record's rows go.
 */
export async function clearDiscoverAlbum(target: ClearTarget): Promise<ClearResult> {
    const album = await findScannedAlbum(target, "DISCOVER");
    if (album?.location === "LIBRARY") {
        await deleteAlbumRows(null, target.suggestionId);
        return { cleared: true };
    }
    const rgMbids = [...new Set([target.rgMbid, ...(album ? [album.rgMbid] : [])])];
    const holding = await lidarrHolding(target, rgMbids);
    if ("unknown" in holding) return { cleared: false, reason: holding.unknown };

    if (holding.lidarrAlbumId !== null) {
        const outcome = await removeDiscoveryAlbum(holding.lidarrAlbumId, holding.rgMbid, {
            rgMbids,
            artistName: target.artistName,
            albumTitle: target.albumTitle,
        });
        if (!outcome.removed) return { cleared: false, reason: outcome.reason ?? "Lidarr did not delete the album" };
    } else if (album) {
        if (!(await isKnownSoulseekAlbum(target, rgMbids))) return { cleared: false, reason: UNKNOWN_SOURCE };
        const failure = await deleteAlbumFiles(album.id);
        if (failure) return { cleared: false, reason: failure.failed };
    }
    await deleteAlbumRows(album?.id ?? null, target.suggestionId);
    return { cleared: true };
}

/** The plain reason for an error thrown while clearing an album. */
export const errorReason = (error: unknown) =>
    `Kima hit an error clearing this album: ${error instanceof Error ? error.message : String(error)}`;

/** `clearDiscoverAlbum`, with a thrown error turned into a reported reason so one album cannot stop the rest. */
async function clearOrReport(target: ClearTarget): Promise<ClearResult> {
    try {
        return await clearDiscoverAlbum(target);
    } catch (error) {
        logger.error(`[DiscoverClear] Error clearing ${target.artistName} - ${target.albumTitle}:`, error);
        return { cleared: false, reason: errorReason(error) };
    }
}

export interface SuggestionRow extends AlbumRef {
    id: string;
    lidarrAlbumId: number | null;
}

export type SuggestionClear =
    | { outcome: "cleared" }
    | { outcome: "skipped" }
    | { outcome: "kept"; failure: ClearFailure };

/**
 * Clear an ACTIVE suggestion's album. The row is claimed first (ACTIVE to DELETED), so a like either lands first and
 * keeps the album or finds it gone. When the album is kept, or anything throws, the claim is put back to ACTIVE.
 */
export async function clearSuggestion(suggestion: SuggestionRow): Promise<SuggestionClear> {
    const claimed = await prisma.discoveryAlbum.updateMany({
        where: { id: suggestion.id, status: "ACTIVE" },
        data: { status: "DELETED" },
    });
    if (claimed.count === 0) return { outcome: "skipped" };

    const release = () =>
        prisma.discoveryAlbum.updateMany({ where: { id: suggestion.id, status: "DELETED" }, data: { status: "ACTIVE" } });
    const result = await clearDiscoverAlbum({ ...suggestion, suggestionId: suggestion.id }).catch(async (error) => {
        await release();
        throw error;
    });
    if (result.cleared) return { outcome: "cleared" };
    await release();
    logger.warn(`[DiscoverClear] Kept ${suggestion.artistName} - ${suggestion.albumTitle} in Discover: ${result.reason}`);
    return {
        outcome: "kept",
        failure: { artistName: suggestion.artistName, albumTitle: suggestion.albumTitle, reason: result.reason },
    };
}

/** Whether any of a download job's names is a suggestion this listener has, in any status. */
async function hasSuggestion(userId: string, ref: AlbumRef): Promise<boolean> {
    const mine = await prisma.discoveryAlbum.findMany({
        where: { userId },
        select: { rgMbid: true, artistName: true, albumTitle: true },
    });
    return mine.some((r) => r.rgMbid === ref.rgMbid || namesRecord(r, ref));
}

type JobMetadata = { artistName?: string; albumTitle?: string } | null;

/**
 * Lidarr albums a completed Discover download fetched that no suggestion of this listener names, unless the artist has a
 * liked album or the batch is still running. Albums already scanned as DISCOVER are the orphan sweep's; here only
 * Lidarr's copy is removed, and one Lidarr does not delete is reported.
 */
export async function clearUnsuggestedDownloads(userId: string): Promise<ClearFailure[]> {
    const [jobs, liked] = await Promise.all([
        prisma.downloadJob.findMany({
            where: {
                userId,
                discoveryBatchId: { not: null },
                status: "completed",
                lidarrAlbumId: { not: null },
                targetMbid: { not: null },
                discoveryBatch: { status: { notIn: RUNNING_BATCH } },
            },
        }),
        prisma.discoveryAlbum.findMany({ where: { userId, status: { in: ["LIKED", "MOVED"] } }, select: { artistName: true } }),
    ]);
    const likedArtists = new Set(liked.map((a) => a.artistName.toLowerCase()));

    const failures: ClearFailure[] = [];
    for (const job of jobs) {
        const metadata = job.metadata as JobMetadata;
        const ref: AlbumRef = {
            rgMbid: job.targetMbid as string,
            artistName: metadata?.artistName ?? "",
            albumTitle: metadata?.albumTitle || job.subject,
        };
        if (ref.artistName && likedArtists.has(ref.artistName.toLowerCase())) continue;
        if (await hasSuggestion(userId, ref)) continue;
        if (await findDiscoverAlbum(ref)) continue;

        const result = await clearOrReport({ ...ref, lidarrAlbumId: job.lidarrAlbumId, suggestionId: null });
        if (!result.cleared) {
            logger.warn(`[DiscoverClear] Kept extra album ${ref.artistName} - ${ref.albumTitle}: ${result.reason}`);
            failures.push({ artistName: ref.artistName || "Unknown artist", albumTitle: ref.albumTitle, reason: result.reason });
        }
    }
    return failures;
}

/**
 * Whether a DISCOVER album is covered: a suggestion that is ACTIVE, LIKED or MOVED names it (by release-group id, or by
 * artist and title by `nameKey`, the way `findScannedAlbum` finds it), or a listener owns it. `suggested` is the
 * ids and name keys of all such suggestions, loaded once for the sweep.
 */
async function discoverAlbumIsCovered(
    album: { rgMbid: string; title: string; artist: { name: string } },
    suggested: { ids: Set<string>; names: Set<string> },
): Promise<boolean> {
    if (suggested.ids.has(album.rgMbid) || suggested.names.has(lookupKey(album.artist.name, album.title))) return true;
    return (await prisma.ownedAlbum.findFirst({ where: { rgMbid: album.rgMbid }, select: { rgMbid: true } })) !== null;
}

/** The albums of Discover downloads whose batch is still running, which no suggestion names yet. */
async function albumsInRunningBatches() {
    const jobs = await prisma.downloadJob.findMany({
        where: { discoveryBatch: { status: { in: RUNNING_BATCH } } },
        select: { targetMbid: true, metadata: true },
    });
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const job of jobs) {
        if (job.targetMbid) ids.add(job.targetMbid);
        const metadata = job.metadata as JobMetadata;
        if (metadata?.artistName && metadata.albumTitle) names.add(lookupKey(metadata.artistName, metadata.albumTitle));
    }
    return { ids, names };
}

/** An album that was not deleted, and the listeners whose suggestion or download record names it. */
export interface OrphanFailure extends ClearFailure {
    userIds: string[];
}

/** The listeners whose suggestion (any status) or download job names the album, by id or by artist and title. */
async function listenersNaming(ref: AlbumRef): Promise<string[]> {
    const [suggestions, jobs] = await Promise.all([
        prisma.discoveryAlbum.findMany({ select: { userId: true, rgMbid: true, artistName: true, albumTitle: true } }),
        prisma.downloadJob.findMany({ select: { userId: true, targetMbid: true, subject: true } }),
    ]);
    const named = [
        ...suggestions.filter((r) => r.rgMbid === ref.rgMbid || namesRecord(r, ref)),
        ...jobs.filter((j) => j.targetMbid === ref.rgMbid || sameName(j.subject, `${ref.artistName} - ${ref.albumTitle}`)),
    ];
    return [...new Set(named.map((r) => r.userId))];
}

/**
 * DISCOVER albums no suggestion covers, left by failed downloads or a failed playlist build, cleared the same way as any
 * other: Lidarr's are deleted by Lidarr or kept and reported, the rest lose their files and rows. An album whose batch is
 * still downloading is left alone. Each failure carries the listeners whose records name the album.
 */
export async function clearOrphanedDiscoverAlbums(): Promise<{ cleared: number; failures: OrphanFailure[] }> {
    const albums = await prisma.album.findMany({
        where: { location: "DISCOVER" },
        select: { id: true, rgMbid: true, title: true, artist: { select: { name: true } } },
    });
    const running = await albumsInRunningBatches();
    const records = await prisma.discoveryAlbum.findMany({
        where: { status: { in: ["ACTIVE", "LIKED", "MOVED"] } },
        select: { rgMbid: true, artistName: true, albumTitle: true },
    });
    const suggested = {
        ids: new Set(records.map((r) => r.rgMbid)),
        names: new Set(records.map((r) => lookupKey(r.artistName, r.albumTitle))),
    };

    let cleared = 0;
    const failures: OrphanFailure[] = [];
    for (const album of albums) {
        if (running.ids.has(album.rgMbid) || running.names.has(lookupKey(album.artist.name, album.title))) continue;
        if (await discoverAlbumIsCovered(album, suggested)) continue;
        const ref = { rgMbid: album.rgMbid, artistName: album.artist.name, albumTitle: album.title };
        const result = await clearOrReport({ ...ref, lidarrAlbumId: null, suggestionId: null });
        if (result.cleared) cleared++;
        else failures.push({ artistName: ref.artistName, albumTitle: ref.albumTitle, reason: result.reason, userIds: await listenersNaming(ref) });
    }
    return { cleared, failures };
}

const orphanFailureGroupKey = "discover-clear-orphans";

/** The tray row for albums that were not deleted. */
function notDeletedRow(failures: ClearFailure[]) {
    const listing = failures.map((f) => `${f.artistName} - ${f.albumTitle}: ${f.reason}`).join("; ");
    return {
        type: "error" as const,
        title: `${failures.length} Discover album${failures.length === 1 ? "" : "s"} not deleted`,
        message: `These Discover albums were not deleted, so they stay as they are: ${listing}. Clear Discover again to try once more.`,
        metadata: { lidarrFailed: failures },
    };
}

/**
 * Tells everyone but the caller about the orphans that were not deleted: each named listener in their own tray row,
 * and the admins, for albums no record names. The caller's own are in the caller's row; only the caller's own admin
 * row is cleared, and only when this clear left no unnamed orphan.
 */
export async function reportOrphanFailures(callerId: string, failures: OrphanFailure[]): Promise<void> {
    try {
        const byListener = new Map<string, ClearFailure[]>();
        const unnamed: ClearFailure[] = [];
        for (const { userIds, ...failure } of failures) {
            if (userIds.length === 0) unnamed.push(failure);
            for (const id of userIds.filter((u) => u !== callerId)) byListener.set(id, [...(byListener.get(id) ?? []), failure]);
        }
        for (const [listener, list] of byListener) await reportLidarrFailures(listener, list, { complete: false });
        if (unnamed.length > 0) {
            await notificationService.notifyAdmins({ ...notDeletedRow(unnamed), groupKey: orphanFailureGroupKey });
        } else {
            await notificationService.resolveFor(callerId, orphanFailureGroupKey);
        }
    } catch (notifyError: any) {
        logger.warn(`[DiscoverClear] Could not write the orphan tray rows: ${notifyError.message}`);
    }
}

const lidarrFailureGroupKey = (userId: string) => `discover-clear-lidarr:${userId}`;

/**
 * The listener's one tray row for albums Lidarr did not delete. Failures write it (a repeat replaces it);
 * `complete` says this run tried every album Lidarr still holds, so no failures also clears the row.
 */
export async function reportLidarrFailures(
    userId: string,
    failures: ClearFailure[],
    options: { complete: boolean; renotify?: boolean },
): Promise<void> {
    const groupKey = lidarrFailureGroupKey(userId);
    try {
        if (failures.length > 0) {
            await notificationService.create({ userId, ...notDeletedRow(failures), groupKey, renotify: options.renotify });
        } else if (options.complete) {
            await notificationService.resolve(groupKey);
        }
    } catch (notifyError: any) {
        logger.warn(`[DiscoverClear] Could not write the Lidarr tray row for user ${userId}: ${notifyError.message}`);
    }
}
