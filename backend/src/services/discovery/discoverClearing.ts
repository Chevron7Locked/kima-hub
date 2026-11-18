/**
 * Every path that removes a Discover album (clear, the weekly run, the orphan sweeps) goes through here. Lidarr deletes
 * the albums it holds; Kima deletes files only for an album a completed Soulseek download names; anything not deleted
 * stays as it is and is reported in the tray. Rows go only after the files, so a scan cannot bring them back.
 */
import fs from "fs";
import path from "path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { lidarrService } from "../lidarr";
import * as downloadJobs from "../downloads/jobs";
import { artistNamed, isMbid } from "../artistIdentity";
import { updateArtistCounts } from "../artistCountsService";
import { markLibraryChangedQuietly } from "../libraryChanged";
import { notificationService } from "../notificationService";
import { deleteAlbums } from "../library/albumDelete";
import { LINKED_OUT_REFUSAL, isBehindLinkOut, resolveWithinMusicRoot } from "../../routes/library/trackPath";
import { removeDiscoveryAlbum, type LidarrRemovalResult } from "./lidarrRemoval";
import { NameIndex, RUNNING_BATCH, couldBeArtist, sameArtist, sameName } from "./discoverEvidence";
import { forgetOwnedIndex } from "./ownedIndexVersion";

/** A suggestion row's names and artist id, for comparing with a record's. */
interface NamedRow {
    artistName: string;
    albumTitle: string;
    artistMbid: string | null;
}

/** Whether a suggestion row names the same artist (sameArtist) and title (`nameKey`) as the record. */
const namesRecord = (row: NamedRow, ref: AlbumRef) => sameArtist(row, ref) && sameName(row.albumTitle, ref.albumTitle);

/**
 * Whether a download job's subject names the record's artist and title (`nameKey`) and its artist id agrees: a namesake
 * under another MusicBrainz id is not this artist's, a job with no real id is (its subject names the artist).
 */
const jobNamesRecord = (job: { subject: string; artistMbid: string | null }, ref: AlbumRef) =>
    sameName(job.subject, `${ref.artistName} ${ref.albumTitle}`) &&
    sameArtist({ artistMbid: job.artistMbid, artistName: ref.artistName }, ref);

/** Whether a download job's metadata names the record's artist and title, with the same artist-id agreement. */
const metadataNamesRecord = (job: { metadata: unknown; artistMbid: string | null }, ref: AlbumRef) => {
    const meta = job.metadata as { artistName?: string; albumTitle?: string } | null;
    return (
        !!meta?.artistName &&
        !!meta?.albumTitle &&
        sameName(`${meta.artistName} ${meta.albumTitle}`, `${ref.artistName} ${ref.albumTitle}`) &&
        sameArtist({ artistMbid: job.artistMbid, artistName: ref.artistName }, ref)
    );
};

/**
 * What names a Discover album: the suggestion's or download job's release-group id, artist and title, and the artist's
 * MusicBrainz id, which is null when the artist is known by name only (a `temp-` placeholder counts as none). Required, so
 * no caller falls back to name-only matching by leaving it out.
 */
export interface AlbumRef {
    rgMbid: string;
    artistName: string;
    albumTitle: string;
    artistMbid: string | null;
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
    // The artist row is one per name, so a namesake's albums come back with it: only the record's artist's stay.
    const named = ofArtist.filter(
        (a) => sameName(a.title, ref.albumTitle) && sameArtist({ artistMbid: a.artist.mbid, artistName: ref.artistName }, ref),
    );
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
    if (tracks.some((t) => t.filePath && isBehindLinkOut(t.filePath))) return { failed: LINKED_OUT_REFUSAL };
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

/**
 * The song records of the album's suggestions (one per week that suggested it), then the album when it is Discover's (never a library album) with what goes with it
 * (library/albumDelete.ts), in one transaction.
 */
async function deleteAlbumRows(albumId: string | null, suggestionIds: string[]): Promise<void> {
    const deleted = await prisma.$transaction(async (tx) => {
        if (suggestionIds.length > 0) await tx.discoveryTrack.deleteMany({ where: { discoveryAlbumId: { in: suggestionIds } } });
        return deleteAlbums(albumId ? [albumId] : [], { within: tx, only: "DISCOVER" });
    });
    await deleted.settle();
}

/**
 * The Lidarr album id Discover recorded for an album: by release-group id first (a suggestion, then a Discover download
 * job), else by artist and title (sameName) with the same artist (sameArtist: a namesake under another MusicBrainz id
 * never counts). A listener's own download is never Discover's record.
 */
export async function recordedLidarrAlbumId(ref: AlbumRef, rgMbids: string[]): Promise<number | null> {
    const idSuggestion = await prisma.discoveryAlbum.findFirst({
        where: { rgMbid: { in: rgMbids }, lidarrAlbumId: { not: null } },
        orderBy: { weekStartDate: "desc" },
        select: { lidarrAlbumId: true },
    });
    if (idSuggestion?.lidarrAlbumId) return idSuggestion.lidarrAlbumId;
    const idJob = await prisma.downloadJob.findFirst({
        where: { targetMbid: { in: rgMbids }, lidarrAlbumId: { not: null }, discoveryBatchId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { lidarrAlbumId: true },
    });
    if (idJob?.lidarrAlbumId) return idJob.lidarrAlbumId;

    // By name, only among records that could be this artist's: its id, or no real id.
    const recorded = await prisma.discoveryAlbum.findMany({
        where: { lidarrAlbumId: { not: null }, ...couldBeArtist(ref.artistMbid) },
        orderBy: { weekStartDate: "desc" },
        select: { artistMbid: true, artistName: true, albumTitle: true, lidarrAlbumId: true },
    });
    const suggestion = recorded.find((r) => namesRecord(r, ref));
    if (suggestion?.lidarrAlbumId) return suggestion.lidarrAlbumId;
    const jobs = await prisma.downloadJob.findMany({
        where: { lidarrAlbumId: { not: null }, discoveryBatchId: { not: null }, ...couldBeArtist(ref.artistMbid) },
        orderBy: { createdAt: "desc" },
        select: { lidarrAlbumId: true, artistMbid: true, metadata: true },
    });
    const job = jobs.find((j) => {
        const meta = j.metadata as { artistName?: string; albumTitle?: string } | null;
        return (
            !!meta?.artistName &&
            !!meta?.albumTitle &&
            namesRecord({ artistName: meta.artistName, albumTitle: meta.albumTitle, artistMbid: j.artistMbid }, ref)
        );
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
): Promise<{ lidarrAlbumId: number | null; rgMbid: string } | LidarrUnknown> {
    const known = target.lidarrAlbumId ?? (await recordedLidarrAlbumId(target, rgMbids));
    if (known) return { lidarrAlbumId: known, rgMbid: target.rgMbid };
    if (!(await lidarrService.isEnabled())) return { lidarrAlbumId: null, rgMbid: target.rgMbid };
    return (await heldByReleaseGroup(rgMbids)) ?? { lidarrAlbumId: null, rgMbid: target.rgMbid };
}

/** Lidarr's album id and the release-group id it was found under. */
type LidarrHeld = { lidarrAlbumId: number; rgMbid: string };
/** Why Lidarr could not be asked. */
type LidarrUnknown = { unknown: string };

/** The album Lidarr holds under one of these release-group ids, null when none, or why Lidarr could not be asked. */
async function heldByReleaseGroup(rgMbids: string[]): Promise<LidarrHeld | LidarrUnknown | null> {
    for (const rgMbid of rgMbids.filter(isMbid)) {
        try {
            const held = await lidarrService.findAlbumByForeignId(rgMbid);
            if (held) return { lidarrAlbumId: held.id, rgMbid };
        } catch (error: any) {
            return { unknown: `Lidarr could not be reached or answered with an error: ${error?.message || "no message"}` };
        }
    }
    return null;
}

const NOT_SCANNED =
    "the files came from Soulseek but Kima has not scanned them yet; the next library scan picks them up and the next clear deletes them";

/**
 * A `where` piece for the Discover jobs that could be the album's: those `byId` picks, or any (narrowed by `named`) that
 * could be its artist's, to be told apart by name. With no real artist id any job could be, so nothing narrows.
 */
function orArtistsJobs(ref: AlbumRef, byId: Prisma.DownloadJobWhereInput, named: Prisma.DownloadJobWhereInput = {}) {
    const artist = couldBeArtist(ref.artistMbid);
    const byName = { AND: [named, artist] };
    // Prisma reads an empty object inside OR as matching nothing, so "any job" is said by leaving OR out.
    if (Object.keys(named).length === 0 && !("OR" in artist)) return {};
    return { OR: [byId, byName] };
}

const UNNAMED_RECORD =
    "Kima's download record for this album has no artist or title, so it cannot rule out a listener's own copy and left it in Lidarr; delete it there if it is Discover's";

const UNKNOWN_SOURCE =
    "Kima can't tell where this album's files came from, so it left them; delete them in Lidarr or by hand";

/**
 * Whether a completed Discover download job naming the album (by id, or artist and title) last fetched it from
 * Soulseek; any job for the album that touched Lidarr says no. A listener's own download is never Discover's to delete.
 */
async function isKnownSoulseekAlbum(ref: AlbumRef, rgMbids: string[]): Promise<boolean> {
    const candidates = await prisma.downloadJob.findMany({
        where: { discoveryBatchId: { not: null }, ...orArtistsJobs(ref, { targetMbid: { in: rgMbids } }) },
        select: { status: true, lidarrAlbumId: true, metadata: true, targetMbid: true, subject: true, artistMbid: true },
    });
    const jobs = candidates.filter(
        (j) => (j.targetMbid !== null && rgMbids.includes(j.targetMbid)) || jobNamesRecord(j, ref),
    );
    const source = (j: (typeof jobs)[number]) => (j.metadata as { currentSource?: string } | null)?.currentSource;
    if (jobs.some((j) => j.lidarrAlbumId !== null || source(j) === "lidarr")) return false;
    return jobs.some((j) => downloadJobs.isCompleted(j.status) && source(j) === "soulseek");
}

/**
 * Discover's finished download records for an album it has cleared. Gone with the album, they no longer say the album
 * is Discover's, so a copy the listener adds later is theirs.
 */
async function forgetDiscoverDownloads(ref: AlbumRef, rgMbids: string[]): Promise<void> {
    const jobs = await prisma.downloadJob.findMany({
        where: {
            discoveryBatchId: { not: null },
            status: { notIn: downloadJobs.ACTIVE_STATUSES },
            ...orArtistsJobs(ref, { targetMbid: { in: rgMbids } }, { targetMbid: null }),
        },
        select: { id: true, targetMbid: true, subject: true, metadata: true, artistMbid: true },
    });
    // A job that names a release group is this album's only by that id: another album of the same name keeps its own.
    const naming = jobs.filter((j) =>
        j.targetMbid !== null ? rgMbids.includes(j.targetMbid) : jobNamesRecord(j, ref) || metadataNamesRecord(j, ref),
    );
    await downloadJobs.remove(naming);
}

/** One Discover album to clear: its names, the Lidarr album id if known, and the listener's suggestion rows of it. */
interface ClearTarget extends AlbumRef {
    lidarrAlbumId: number | null;
    suggestionIds: string[];
}

type ClearResult = { cleared: true } | { cleared: false; reason: string };

/**
 * Clears one Discover album: Lidarr's is deleted by Lidarr (lidarrRemoval), a known Soulseek one by deleting its
 * files, then the rows go. Anything else, or a file that stays, changes nothing and returns the reason. A scanned album
 * that is the library's is left; only the record's rows go. So is an album Lidarr no longer has and Kima never scanned.
 */
export async function clearDiscoverAlbum(target: ClearTarget): Promise<ClearResult> {
    const album = await findScannedAlbum(target, "DISCOVER");
    const rgMbids = [...new Set([target.rgMbid, ...(album ? [album.rgMbid] : [])])];
    if (album?.location === "LIBRARY") {
        await deleteAlbumRows(null, target.suggestionIds);
        await forgetDiscoverDownloads(target, rgMbids);
        return { cleared: true };
    }
    const holding = await lidarrHolding(target, rgMbids);
    if ("unknown" in holding) return { cleared: false, reason: holding.unknown };

    if (holding.lidarrAlbumId !== null) {
        const kept = await removeFromLidarr({ lidarrAlbumId: holding.lidarrAlbumId, rgMbid: holding.rgMbid }, target, rgMbids, album !== null);
        if (kept) return kept;
    } else if (album) {
        if (!(await isKnownSoulseekAlbum(target, rgMbids))) return { cleared: false, reason: UNKNOWN_SOURCE };
        const failure = await deleteAlbumFiles(album.id);
        if (failure) return { cleared: false, reason: failure.failed };
    } else if (await isKnownSoulseekAlbum(target, rgMbids)) {
        // Forgetting its records now would let the next scan file the downloaded files as the listener's own.
        return { cleared: false, reason: NOT_SCANNED };
    }
    await deleteAlbumRows(album?.id ?? null, target.suggestionIds);
    await forgetDiscoverDownloads(target, rgMbids);
    return { cleared: true };
}

/**
 * Lidarr deletes the album it holds. Returns why it was kept, or null when it is gone from Lidarr. An album Lidarr no
 * longer has under the recorded id is looked for by release-group id, as Lidarr may hold it again under a new id; one
 * Lidarr holds nowhere and Kima never scanned is gone, so its records go rather than being reported every clear. A
 * scanned copy stays reported, as its files are still on disk.
 */
async function removeFromLidarr(held: LidarrHeld, target: ClearTarget, rgMbids: string[], scanned: boolean): Promise<ClearResult | null> {
    const names = { rgMbids, artistName: target.artistName, artistMbid: target.artistMbid, albumTitle: target.albumTitle };
    const keptBecause = (outcome: LidarrRemovalResult): ClearResult | null =>
        outcome.removed ? null : { cleared: false, reason: outcome.reason ?? "Lidarr did not delete the album" };

    const outcome = await removeDiscoveryAlbum(held.lidarrAlbumId, held.rgMbid, names);
    if (!outcome.gone || scanned) return keptBecause(outcome);
    const now = await heldByReleaseGroup(rgMbids);
    if (now === null) return null;
    if ("unknown" in now) return { cleared: false, reason: now.unknown };
    // Lidarr answers both that the id is gone and that it holds the album under it: leave the records for a later clear.
    if (now.lidarrAlbumId === held.lidarrAlbumId) return keptBecause(outcome);
    return keptBecause(await removeDiscoveryAlbum(now.lidarrAlbumId, now.rgMbid, names));
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

/** Rolls a claim back when its rows changed under it. */
class ClaimMoved extends Error {}

/**
 * Holds, until the transaction ends, the one turn a listener's like and a clear share for an album. Postgres claims an
 * album's rows one at a time, so without it a like and a clear could each take one week's row of the same album.
 * Statements after it see what the other committed.
 */
export async function takeAlbumClaimTurn(tx: Prisma.TransactionClient, userId: string, rgMbid: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`discover-claim:${userId}:${rgMbid}`}, 0))`;
}

/**
 * Clear an ACTIVE suggestion's album. Every ACTIVE suggestion of the album this listener has (a kept album a later
 * week suggested again has one per week) is claimed first (ACTIVE to DELETED), in the album's claim turn
 * (`takeAlbumClaimTurn`), so a like either lands first and keeps the album or finds it gone. None is claimed while any
 * suggestion of the album is liked. A suggestion with no release id is claimed alone, as nothing says which album it
 * is. When the album is kept, or anything throws, the claims are put back to ACTIVE.
 */
export async function clearSuggestion(suggestion: SuggestionRow): Promise<SuggestionClear> {
    const claimed = await prisma.$transaction(async (tx) => {
        const own = await tx.discoveryAlbum.findUnique({ where: { id: suggestion.id }, select: { userId: true, rgMbid: true } });
        if (!own) return [];
        if (!own.rgMbid) {
            const one = await tx.discoveryAlbum.updateMany({ where: { id: suggestion.id, status: "ACTIVE" }, data: { status: "DELETED" } });
            return one.count > 0 ? [{ id: suggestion.id }] : [];
        }
        await takeAlbumClaimTurn(tx, own.userId, own.rgMbid);
        const rows = await tx.discoveryAlbum.findMany({
            where: { userId: own.userId, rgMbid: own.rgMbid },
            select: { id: true, status: true },
        });
        const active = rows.filter((r) => r.status === "ACTIVE");
        if (rows.some((r) => r.status === "LIKED") || !active.some((r) => r.id === suggestion.id)) return [];
        const taken = await tx.discoveryAlbum.updateMany({
            where: { id: { in: active.map((r) => r.id) }, status: "ACTIVE" },
            data: { status: "DELETED" },
        });
        // A writer outside the claim turn (expiry, the one-time sort) moved a row meanwhile: claim none of them.
        if (taken.count !== active.length) throw new ClaimMoved();
        return active.map((r) => ({ id: r.id }));
    }).catch((error) => {
        if (error instanceof ClaimMoved) return [];
        throw error;
    });
    if (claimed.length === 0) return { outcome: "skipped" };

    const ids = claimed.map((row) => row.id);
    const release = () =>
        prisma.discoveryAlbum.updateMany({ where: { id: { in: ids }, status: "DELETED" }, data: { status: "ACTIVE" } });
    const result = await clearDiscoverAlbum({ ...suggestion, suggestionIds: ids }).catch(async (error) => {
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

/**
 * Whether a download job's release-group id, or its artist and title, is one of the listener's suggestions that are not
 * DELETED. A DELETED one whose download record is still here is a clear that never finished (a finished clear forgets
 * the record, and a kept album goes back to ACTIVE), so the album is cleared here instead.
 */
const namesSuggestion = (mine: (NamedRow & { rgMbid: string | null })[], ref: AlbumRef) =>
    mine.some((r) => r.rgMbid === ref.rgMbid || namesRecord(r, ref));

type JobMetadata = { artistName?: string; albumTitle?: string } | null;

/**
 * Lidarr albums a completed Discover download fetched that no suggestion of this listener names, unless the artist has a
 * liked album or the batch is still running. Albums already scanned as DISCOVER are the orphan sweep's; here only
 * Lidarr's copy is removed, and one Lidarr does not delete is reported.
 */
export async function clearUnsuggestedDownloads(userId: string): Promise<ClearFailure[]> {
    const [jobs, liked, mine] = await Promise.all([
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
        prisma.discoveryAlbum.findMany({ where: { userId, status: { in: ["LIKED", "MOVED"] } }, select: { artistName: true, artistMbid: true } }),
        prisma.discoveryAlbum.findMany({
            where: { userId, status: { not: "DELETED" } },
            select: { rgMbid: true, artistName: true, artistMbid: true, albumTitle: true },
        }),
    ]);
    const likedArtist = (ref: AlbumRef) => liked.some((a) => sameArtist(a, ref));

    const failures: ClearFailure[] = [];
    for (const job of jobs) {
        const metadata = job.metadata as JobMetadata;
        const unnamed = !metadata?.artistName?.trim() || !metadata.albumTitle?.trim();
        const ref: AlbumRef = {
            rgMbid: job.targetMbid as string,
            artistName: metadata?.artistName ?? "",
            albumTitle: metadata?.albumTitle ?? "",
            artistMbid: job.artistMbid,
        };
        // Empty names match nothing in these checks, so a nameless record is still skipped by its ids.
        if (likedArtist(ref)) continue;
        if (namesSuggestion(mine, ref)) continue;
        if (unnamed) {
            if (await prisma.album.findFirst({ where: { rgMbid: ref.rgMbid, location: "DISCOVER" }, select: { id: true } })) continue;
            // With no names, only the release-group id could find a listener's own copy, so Lidarr's is left.
            failures.push({ artistName: "Unknown artist", albumTitle: job.subject, reason: UNNAMED_RECORD });
            continue;
        }
        if (await findDiscoverAlbum(ref)) continue;

        const result = await clearOrReport({ ...ref, lidarrAlbumId: job.lidarrAlbumId, suggestionIds: [] });
        if (!result.cleared) {
            logger.warn(`[DiscoverClear] Kept extra album ${ref.artistName} - ${ref.albumTitle}: ${result.reason}`);
            failures.push({ artistName: ref.artistName, albumTitle: ref.albumTitle, reason: result.reason });
        }
    }
    return failures;
}

/**
 * Whether a DISCOVER album is covered: a suggestion that is ACTIVE, LIKED or MOVED names it (by release-group id, or by
 * artist (sameArtist) and title by `nameKey`, the way `findScannedAlbum` finds it), or a listener owns it. `suggested` is
 * the ids and names of all such suggestions, loaded once for the sweep.
 */
async function discoverAlbumIsCovered(
    album: { rgMbid: string; title: string; artist: { name: string; mbid: string | null } },
    suggested: { ids: Set<string>; names: NameIndex },
): Promise<boolean> {
    if (suggested.ids.has(album.rgMbid) || suggested.names.has(album.artist.name, album.artist.mbid, album.title)) return true;
    return (await prisma.ownedAlbum.findFirst({ where: { rgMbid: album.rgMbid }, select: { rgMbid: true } })) !== null;
}

/** The albums of Discover downloads whose batch is still running, which no suggestion names yet. */
async function albumsInRunningBatches() {
    const jobs = await prisma.downloadJob.findMany({
        where: { discoveryBatch: { status: { in: RUNNING_BATCH } } },
        select: { targetMbid: true, artistMbid: true, metadata: true },
    });
    const ids = new Set<string>();
    const names = new NameIndex();
    for (const job of jobs) {
        if (job.targetMbid) ids.add(job.targetMbid);
        const metadata = job.metadata as JobMetadata;
        if (metadata?.artistName && metadata.albumTitle) names.add(metadata.artistName, job.artistMbid, metadata.albumTitle);
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
        prisma.discoveryAlbum.findMany({ select: { userId: true, rgMbid: true, artistName: true, artistMbid: true, albumTitle: true } }),
        prisma.downloadJob.findMany({ select: { userId: true, targetMbid: true, subject: true, artistMbid: true } }),
    ]);
    const named = [
        ...suggestions.filter((r) => r.rgMbid === ref.rgMbid || namesRecord(r, ref)),
        ...jobs.filter((j) => j.targetMbid === ref.rgMbid || jobNamesRecord(j, ref)),
    ];
    return [...new Set(named.map((r) => r.userId))];
}

/**
 * Whether any Discover record names the album: a suggestion in any status, or a Discover download job (by release-group
 * id, or artist and title).
 */
async function discoverRecordNames(ref: AlbumRef): Promise<boolean> {
    const [suggestions, jobs] = await Promise.all([
        prisma.discoveryAlbum.findMany({ select: { rgMbid: true, artistName: true, artistMbid: true, albumTitle: true } }),
        prisma.downloadJob.findMany({
            where: { discoveryBatchId: { not: null } },
            select: { targetMbid: true, subject: true, artistMbid: true },
        }),
    ]);
    return (
        suggestions.some((s) => s.rgMbid === ref.rgMbid || namesRecord(s, ref)) ||
        jobs.some((j) => j.targetMbid === ref.rgMbid || jobNamesRecord(j, ref))
    );
}

/** Files an album no Discover record names back in the library, as the listener's. */
async function returnToLibrary(albumId: string): Promise<boolean> {
    const album = await prisma.$transaction(async (tx) => {
        const moved = await tx.album.updateMany({ where: { id: albumId, location: "DISCOVER" }, data: { location: "LIBRARY" } });
        if (moved.count === 0) return null;
        const row = await tx.album.findUniqueOrThrow({ where: { id: albumId }, select: { artistId: true, rgMbid: true } });
        await tx.ownedAlbum.createMany({ data: [{ artistId: row.artistId, rgMbid: row.rgMbid, source: "native_scan" }], skipDuplicates: true });
        return row;
    });
    // The album is back either way; a recount that fails is caught up by the next scan's.
    if (album) {
        forgetOwnedIndex();
        await updateArtistCounts(album.artistId).catch((error) =>
            logger.warn("[DiscoverClear] Artist counts not updated after returning an album to the library:", error),
        );
    }
    return album !== null;
}

/**
 * DISCOVER albums no suggestion covers (failed downloads or playlist builds) are cleared like any other: Lidarr's are
 * deleted by Lidarr or kept and reported, the rest lose files and rows. One no Discover record names goes back to the
 * library undeleted; one whose batch is still downloading is left alone.
 */
export async function clearOrphanedDiscoverAlbums(): Promise<{ cleared: number; returned: number; failures: OrphanFailure[] }> {
    const albums = await prisma.album.findMany({
        where: { location: "DISCOVER" },
        select: { id: true, rgMbid: true, title: true, artist: { select: { name: true, mbid: true } } },
    });
    const running = await albumsInRunningBatches();
    const records = await prisma.discoveryAlbum.findMany({
        where: { status: { in: ["ACTIVE", "LIKED", "MOVED"] } },
        select: { rgMbid: true, artistName: true, artistMbid: true, albumTitle: true },
    });
    const suggested = { ids: new Set(records.map((r) => r.rgMbid)), names: new NameIndex() };
    for (const r of records) suggested.names.add(r.artistName, r.artistMbid, r.albumTitle);

    let cleared = 0;
    let returned = 0;
    const failures: OrphanFailure[] = [];
    for (const album of albums) {
        if (running.ids.has(album.rgMbid) || running.names.has(album.artist.name, album.artist.mbid, album.title)) continue;
        if (await discoverAlbumIsCovered(album, suggested)) continue;
        const ref = { rgMbid: album.rgMbid, artistName: album.artist.name, albumTitle: album.title, artistMbid: album.artist.mbid };
        if (!(await discoverRecordNames(ref))) {
            if (await returnToLibrary(album.id)) returned++;
            continue;
        }
        const result = await clearOrReport({ ...ref, lidarrAlbumId: null, suggestionIds: [] });
        if (result.cleared) cleared++;
        else failures.push({ artistName: ref.artistName, albumTitle: ref.albumTitle, reason: result.reason, userIds: await listenersNaming(ref) });
    }
    if (returned > 0) {
        logger.info(`[DiscoverClear] ${returned} album(s) filed as Discover with no Discover record went back to the library`);
        // A client now lists them.
        await markLibraryChangedQuietly("Discover albums with no record went back to the library");
    }
    return { cleared, returned, failures };
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
