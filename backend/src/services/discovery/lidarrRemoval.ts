/**
 * Discover's deletes from Lidarr. Files go only when Lidarr's record is provably
 * Discover's own: the album it asked for, under an artist carrying its tag, and
 * nothing the user's library holds or the user liked.
 */

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { lidarrService } from "../lidarr";
import { LIBRARY_LOCATION } from "../libraryFilters";
import { artistNamed } from "../artistIdentity";
import { RUNNING_BATCH, sameName } from "./discoverEvidence";
import type { LidarrArtist } from "../../types/lidarr";

/** What names the album being removed, beyond the id Lidarr was asked about. */
export interface RemovalNames {
    rgMbids?: string[];
    artistName?: string;
    albumTitle?: string;
}

/** Whether the library holds the album, by any release-group id the caller knows or by artist and title with case and accents ignored. */
async function libraryHolds(rgMbids: string[], names: RemovalNames): Promise<boolean> {
    const byId = await prisma.album.findFirst({
        where: { location: LIBRARY_LOCATION, rgMbid: { in: rgMbids } },
        select: { id: true },
    });
    if (byId || !names.artistName || !names.albumTitle) return byId !== null;
    const ofArtist = await prisma.album.findMany({
        where: { location: LIBRARY_LOCATION, artist: artistNamed(names.artistName) },
        select: { title: true },
    });
    return ofArtist.some((a) => sameName(a.title, names.albumTitle));
}

async function fetchedByDiscover(rgMbids: string[]): Promise<Set<string>> {
    const [albums, jobs] = await Promise.all([
        prisma.discoveryAlbum.findMany({ where: { rgMbid: { in: rgMbids } }, select: { rgMbid: true } }),
        prisma.downloadJob.findMany({
            where: { targetMbid: { in: rgMbids }, discoveryBatchId: { not: null } },
            select: { targetMbid: true },
        }),
    ]);
    return new Set([...albums.map((a) => a.rgMbid), ...jobs.map((j) => j.targetMbid as string)]);
}

/**
 * What Lidarr did with a Discover album, in words a listener can be shown. `reason`
 * says why Lidarr did not delete it, and is null when it did.
 */
export interface LidarrRemovalResult {
    removed: boolean;
    reason: string | null;
}

/**
 * Delete a Discover album and its files. Anything that fails the identity check
 * is only unmonitored. Returns what happened, so a caller can keep the album where
 * Lidarr did not delete it; an album Lidarr no longer has is not removed, as its files
 * may still be on disk.
 */
export async function removeDiscoveryAlbum(
    lidarrAlbumId: number,
    rgMbid: string,
    names: RemovalNames = {}
): Promise<LidarrRemovalResult> {
    try {
        if (!(await lidarrService.isEnabled())) {
            return { removed: false, reason: "Lidarr is turned off" };
        }

        const album = await lidarrService.getAlbum(lidarrAlbumId);
        if (!album) {
            return {
                removed: false,
                reason: "Lidarr no longer knows this album, so its files may still be on disk; delete them by hand",
            };
        }

        const [artist, tagId] = await Promise.all([
            lidarrService.getArtistById(album.artistId),
            lidarrService.getOrCreateDiscoveryTag(),
        ]);
        const ours =
            album.foreignAlbumId === rgMbid &&
            tagId !== null &&
            !!artist?.tags?.includes(tagId) &&
            !(await libraryHolds([...new Set([rgMbid, ...(names.rgMbids ?? [])])], names));

        if (!ours) {
            logger.warn(
                `[Discover] Keeping Lidarr files for "${album.title}" (${lidarrAlbumId}): not the album Discover fetched`
            );
            await lidarrService.unmonitorAlbum(lidarrAlbumId);
            return {
                removed: false,
                reason: "Lidarr's record is not the album Discover fetched",
            };
        }

        await lidarrService.deleteAlbumById(lidarrAlbumId, true);
        return { removed: true, reason: null };
    } catch (error: any) {
        const message = error?.message || "Lidarr gave no message";
        logger.warn(`[Discover] Lidarr album ${lidarrAlbumId} not removed: ${message}`);
        return {
            removed: false,
            reason: `Lidarr could not be reached or answered with an error: ${message}`,
        };
    }
}

/**
 * "delete" only for a Discover-tagged artist whose every album with files was fetched by Discover, with nothing in the
 * library and nothing liked. "in use" while any listener's current week suggests one of its albums or a Discover batch
 * is still downloading one: the artist and its tag stay for a later clear to decide.
 */
export async function discoveryArtistVerdict(artist: LidarrArtist): Promise<"delete" | "keep" | "in use"> {
    const tagId = await lidarrService.getOrCreateDiscoveryTag();
    const mbid = artist.foreignArtistId;
    if (tagId === null || !artist.tags?.includes(tagId) || !mbid) return "keep";

    const [liked, owned] = await Promise.all([
        prisma.discoveryAlbum.findFirst({
            where: { artistMbid: mbid, status: { in: ["LIKED", "MOVED"] } },
            select: { id: true },
        }),
        prisma.album.findFirst({
            where: { artist: { mbid }, location: LIBRARY_LOCATION },
            select: { id: true },
        }),
    ]);
    if (liked || owned) return "keep";

    const withFiles = (await lidarrService.getAlbumsByArtistId(artist.id))
        .filter((a) => (a.statistics?.trackFileCount ?? 0) > 0)
        .map((a) => a.foreignAlbumId);
    // By artist id, by album, or by name: a suggestion's artist id can be missing or a placeholder, and an album still
    // downloading has no files in Lidarr yet.
    const [current, running] = await Promise.all([
        prisma.discoveryAlbum.findMany({
            where: { status: "ACTIVE" },
            select: { artistMbid: true, rgMbid: true, artistName: true },
        }),
        prisma.downloadJob.findMany({
            where: { discoveryBatch: { status: { in: RUNNING_BATCH } } },
            select: { artistMbid: true, targetMbid: true, metadata: true },
        }),
    ]);
    const names = (artistMbid: string | null, album: string | null, name: unknown) =>
        artistMbid === mbid || (album !== null && withFiles.includes(album)) || (typeof name === "string" && sameName(name, artist.artistName));
    if (
        current.some((r) => names(r.artistMbid, r.rgMbid, r.artistName)) ||
        running.some((j) => names(j.artistMbid, j.targetMbid, (j.metadata as { artistName?: unknown } | null)?.artistName))
    ) {
        return "in use";
    }

    if (withFiles.length === 0) return "delete";
    const fetched = await fetchedByDiscover(withFiles);
    return withFiles.every((m) => fetched.has(m)) ? "delete" : "keep";
}

/**
 * Delete a Discover artist with its files when the verdict allows. Otherwise the
 * Discover tag comes off, so the artist stays in Lidarr as the user's.
 */
export async function removeDiscoveryArtist(artist: LidarrArtist): Promise<boolean> {
    try {
        const verdict = await discoveryArtistVerdict(artist);
        if (verdict === "in use") {
            logger.debug(`[Discover] ${artist.artistName} is in a current Discover week; left for a later clear`);
            return false;
        }
        if (verdict === "keep") {
            if (artist.foreignArtistId) await lidarrService.removeDiscoveryTagByMbid(artist.foreignArtistId);
            logger.debug(`[Discover] Keeping ${artist.artistName} in Lidarr`);
            return false;
        }
        const result = await lidarrService.deleteArtistById(artist.id, true);
        return result.success;
    } catch (error: any) {
        logger.warn(`[Discover] Lidarr artist ${artist.artistName} not removed: ${error.message}`);
        return false;
    }
}
