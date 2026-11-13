/**
 * Discover's deletes from Lidarr. Files go only when Lidarr's record is provably
 * Discover's own: under an artist carrying its tag, named by Discover's own records
 * (the Lidarr album id Discover got back, or the MusicBrainz id it asked for), and
 * nothing the user's library holds, the user liked or the user requested.
 */

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { lidarrService } from "../lidarr";
import { LIBRARY_LOCATION } from "../libraryFilters";
import { artistNamed } from "../artistIdentity";
import { RUNNING_BATCH, sameName } from "./discoverEvidence";
import type { LidarrAlbum, LidarrArtist } from "../../types/lidarr";

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

/** What Kima's records can name a Lidarr album by: the Lidarr id Discover got back when it added it, and MusicBrainz ids. */
interface AlbumKeys {
    lidarrAlbumIds: number[];
    rgMbids: string[];
}

/** A Lidarr album's own keys: its id and, when Lidarr has one, its MusicBrainz id. */
const keysOf = (album: { id: number; foreignAlbumId?: string }): AlbumKeys => ({
    lidarrAlbumIds: [album.id],
    rgMbids: album.foreignAlbumId ? [album.foreignAlbumId] : [],
});

/**
 * Which Lidarr albums Discover's own records name, by Lidarr id or by the MusicBrainz id Discover asked for: a
 * suggestion, or a Discover download job. A placeholder id from untagged files never matches Lidarr's.
 */
async function discoverNamed(keys: AlbumKeys): Promise<(album: { id: number; foreignAlbumId?: string }) => boolean> {
    const [albums, jobs] = await Promise.all([
        prisma.discoveryAlbum.findMany({
            where: { OR: [{ lidarrAlbumId: { in: keys.lidarrAlbumIds } }, { rgMbid: { in: keys.rgMbids } }] },
            select: { lidarrAlbumId: true, rgMbid: true },
        }),
        prisma.downloadJob.findMany({
            where: {
                OR: [{ lidarrAlbumId: { in: keys.lidarrAlbumIds } }, { targetMbid: { in: keys.rgMbids } }],
                discoveryBatchId: { not: null },
            },
            select: { lidarrAlbumId: true, targetMbid: true },
        }),
    ]);
    const ids = new Set([...albums.map((a) => a.lidarrAlbumId), ...jobs.map((j) => j.lidarrAlbumId)]);
    const mbids = new Set([...albums.map((a) => a.rgMbid), ...jobs.map((j) => j.targetMbid)]);
    return (album) => ids.has(album.id) || (!!album.foreignAlbumId && mbids.has(album.foreignAlbumId));
}

/**
 * Whether a listener has made any of these albums theirs, by Lidarr id or MusicBrainz id: marked as theirs (a scan, a
 * like, a repair), a liked or moved suggestion, or their own download request. Any one keeps Discover's hands off the
 * files.
 */
async function listenerClaims(keys: AlbumKeys): Promise<boolean> {
    const [owned, liked, requests] = await Promise.all([
        prisma.ownedAlbum.findFirst({ where: { rgMbid: { in: keys.rgMbids } }, select: { rgMbid: true } }),
        prisma.discoveryAlbum.findFirst({
            where: {
                OR: [{ lidarrAlbumId: { in: keys.lidarrAlbumIds } }, { rgMbid: { in: keys.rgMbids } }],
                status: { in: ["LIKED", "MOVED"] },
            },
            select: { id: true },
        }),
        prisma.downloadJob.findMany({
            where: {
                OR: [{ lidarrAlbumId: { in: keys.lidarrAlbumIds } }, { targetMbid: { in: keys.rgMbids } }],
                discoveryBatchId: null,
            },
            select: { metadata: true },
        }),
    ]);
    const ownRequest = requests.some((j) => (j.metadata as { downloadType?: string } | null)?.downloadType !== "discovery");
    return !!owned || !!liked || ownRequest;
}

/** Why Discover must keep this Lidarr album, or null when it is Discover's to delete. */
async function keepReason(
    album: { id: number; foreignAlbumId?: string },
    claimKeys: AlbumKeys,
    names: RemovalNames,
    tagId: number | null,
    artist: LidarrArtist | null,
): Promise<string | null> {
    if (tagId === null) return "Kima could not read Discover's tag from Lidarr";
    if (!(await discoverNamed(keysOf(album)))(album)) return "Kima has no record of Discover fetching this album";
    if (await listenerClaims(claimKeys)) return "A listener has made this album theirs";
    if (await libraryHolds(claimKeys.rgMbids, names)) return "The library holds this album";
    // The tag is the artist's, not the album's: a listener can add their own album to a tagged artist in Lidarr. Checked
    // last, so a missing tag is put back only once this album has proved Discover's.
    const tag = artist ? await ensureDiscoverTag(artist, tagId) : "not Discover's";
    if (tag === "not Discover's") return "Lidarr's artist does not carry Discover's tag";
    if (tag === "refused") return "Lidarr would not take Discover's tag back on this artist";
    return null;
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
        // Lidarr's own id joins the caller's: untagged files leave Kima a placeholder where Lidarr has the real one.
        const own = keysOf(album);
        const claimKeys = { lidarrAlbumIds: own.lidarrAlbumIds, rgMbids: [...new Set([rgMbid, ...(names.rgMbids ?? []), ...own.rgMbids])] };
        const kept = await keepReason(album, claimKeys, names, tagId, artist);

        if (kept) {
            logger.warn(`[Discover] Keeping Lidarr files for "${album.title}" (${lidarrAlbumId}): ${kept}`);
            await lidarrService.unmonitorAlbum(lidarrAlbumId);
            return { removed: false, reason: kept };
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
 * Whose a Lidarr artist is by Kima's records: "theirs" when a listener liked, holds or asked for any of its albums
 * (including a request still downloading, which has no files yet); "discover" when it has files and every album with
 * files is one Discover's records name; "unsure" otherwise, including when Lidarr gives no file count for an album or
 * the artist has no files. `albums` is what Lidarr listed, when it was read.
 */
async function artistOwner(
    artist: LidarrArtist,
): Promise<{ owner: "theirs" | "discover" | "unsure"; albums: LidarrAlbum[] }> {
    const mbid = artist.foreignArtistId;
    if (mbid) {
        const [liked, library, owned, openRequest] = await Promise.all([
            prisma.discoveryAlbum.findFirst({
                where: { artistMbid: mbid, status: { in: ["LIKED", "MOVED"] } },
                select: { id: true },
            }),
            prisma.album.findFirst({
                where: { artist: { mbid }, location: LIBRARY_LOCATION },
                select: { id: true },
            }),
            // Discover albums are no one's, so any ownership record under the artist is a listener's.
            prisma.ownedAlbum.findFirst({ where: { artist: { mbid } }, select: { rgMbid: true } }),
            prisma.downloadJob.findFirst({
                where: { artistMbid: mbid, discoveryBatchId: null, status: { in: ["pending", "processing"] } },
                select: { id: true },
            }),
        ]);
        if (liked || library || owned || openRequest) return { owner: "theirs", albums: [] };
    }
    const albums = await lidarrService.getAlbumsByArtistId(artist.id);
    // An album Lidarr gives no file count for may hold files: nothing is decided on a guess.
    if (albums.some((a) => typeof a.statistics?.trackFileCount !== "number")) return { owner: "unsure", albums };
    const filed = albums.filter((a) => (a.statistics?.trackFileCount ?? 0) > 0);
    if (filed.length === 0) return { owner: "unsure", albums };
    const keys: AlbumKeys = { lidarrAlbumIds: filed.map((a) => a.id), rgMbids: filed.map((a) => a.foreignAlbumId) };
    if (await listenerClaims(keys)) return { owner: "theirs", albums };
    const named = await discoverNamed(keys);
    return { owner: filed.every(named) ? "discover" : "unsure", albums };
}

/**
 * Makes sure an artist carries Discover's tag, putting it back when an earlier cleanup took it off and Kima's records
 * show the artist is Discover's (`artistOwner`). Only Kima tags artists, so a missing tag on such an artist is Kima's
 * own mistake. "refused" when the artist is Discover's but Lidarr would not take the tag.
 */
export async function ensureDiscoverTag(
    artist: LidarrArtist,
    tagId: number,
): Promise<"tagged" | "not Discover's" | "refused"> {
    if (artist.tags?.includes(tagId)) return "tagged";
    if ((await artistOwner(artist)).owner !== "discover") return "not Discover's";
    if (!(await lidarrService.addTagsToArtist(artist.id, [tagId]))) return "refused";
    artist.tags = [...(artist.tags ?? []), tagId];
    logger.info(`[Discover] Put Discover's tag back on ${artist.artistName} in Lidarr`);
    return "tagged";
}

/**
 * "delete" only for a Discover-tagged artist whose every album with files was fetched by Discover and claimed by no
 * listener, with nothing in the library and nothing liked; "forget" for one with no files at all, which Lidarr drops
 * without touching its folder. "theirs" when a listener has made it theirs, so the tag comes off; "unsure" when Kima
 * cannot tell, so the artist and its tag stay. "in use" while any listener's current week suggests one of its albums or
 * a Discover batch is still downloading one: the artist and its tag stay for a later clear to decide.
 */
export async function discoveryArtistVerdict(
    artist: LidarrArtist,
): Promise<"delete" | "forget" | "theirs" | "unsure" | "in use"> {
    const tagId = await lidarrService.getOrCreateDiscoveryTag();
    const mbid = artist.foreignArtistId;
    if (tagId === null || !artist.tags?.includes(tagId) || !mbid) return "unsure";

    const { owner, albums } = await artistOwner(artist);
    if (owner === "theirs") return "theirs";
    const withFiles = albums.filter((a) => (a.statistics?.trackFileCount ?? 0) > 0).map((a) => a.foreignAlbumId);
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
    if (owner === "discover") return "delete";

    // Nothing to delete: Lidarr forgets the artist and leaves its folder, which may hold files it does not track. An
    // album with no file count (artistOwner said "unsure") may hold files, so it is never forgotten on a guess; a
    // listener's open request already made the artist "theirs".
    if (withFiles.length === 0 && albums.every((a) => typeof a.statistics?.trackFileCount === "number")) return "forget";
    return "unsure";
}

/**
 * Delete a Discover artist with its files when the verdict allows. When a listener has made it theirs the Discover tag
 * comes off, so the artist stays in Lidarr as theirs; when Kima cannot tell, the artist and its tag stay as they are.
 */
export async function removeDiscoveryArtist(artist: LidarrArtist): Promise<boolean> {
    try {
        const verdict = await discoveryArtistVerdict(artist);
        if (verdict === "in use") {
            logger.debug(`[Discover] ${artist.artistName} is in a current Discover week; left for a later clear`);
            return false;
        }
        if (verdict === "theirs" || verdict === "unsure") {
            if (verdict === "theirs" && artist.foreignArtistId) await lidarrService.removeDiscoveryTagByMbid(artist.foreignArtistId);
            logger.debug(`[Discover] Keeping ${artist.artistName} in Lidarr (${verdict === "theirs" ? "a listener's" : "not provably Discover's"})`);
            return false;
        }
        const result = await lidarrService.deleteArtistById(artist.id, verdict === "delete");
        return result.success;
    } catch (error: any) {
        logger.warn(`[Discover] Lidarr artist ${artist.artistName} not removed: ${error.message}`);
        return false;
    }
}
