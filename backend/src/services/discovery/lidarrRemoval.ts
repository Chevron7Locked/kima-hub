/**
 * Discover's deletes from Lidarr. An album's files go only when Discover's own records name it (the Lidarr album id
 * Discover got back, or the MusicBrainz id it asked for) and nothing the user's library holds, the user liked or the
 * user requested; the artist's tag plays no part, as one album delete never removes the artist. A whole artist goes
 * only while it carries Discover's tag and every album with files is Discover's.
 */

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { lidarrService } from "../lidarr";
import * as downloadJobs from "../downloads/jobs";
import { LIBRARY_LOCATION } from "../libraryFilters";
import { artistNamed } from "../artistIdentity";
import { RUNNING_BATCH, couldBeArtist, sameArtist, sameName } from "./discoverEvidence";
import type { LidarrAlbum, LidarrArtist } from "../../types/lidarr";

/**
 * What names the album being removed, beyond the id Lidarr was asked about. An artist name comes with its title and its
 * MusicBrainz id (null when the artist is known by name only), so no caller falls back to name-only matching by leaving
 * the id out.
 */
export type RemovalNames = { rgMbids?: string[] } & (
    | { artistName?: undefined; albumTitle?: undefined; artistMbid?: undefined }
    | { artistName: string; albumTitle: string; artistMbid: string | null }
);

/**
 * Whether the library holds the album, by any release-group id the caller knows or by artist (sameArtist: a namesake
 * under another MusicBrainz id is not this artist) and title with case and accents ignored.
 */
async function libraryHolds(rgMbids: string[], names: RemovalNames): Promise<boolean> {
    const byId = await prisma.album.findFirst({
        where: { location: LIBRARY_LOCATION, rgMbid: { in: rgMbids } },
        select: { id: true },
    });
    if (byId || !names.artistName) return byId !== null;
    const { artistName, artistMbid, albumTitle } = names;
    const ofArtist = await prisma.album.findMany({
        where: { location: LIBRARY_LOCATION, artist: artistNamed(artistName) },
        select: { title: true, artist: { select: { mbid: true } } },
    });
    // The artist row is one per name, so a namesake's albums come back with it.
    return ofArtist.some((a) => sameName(a.title, albumTitle) && sameArtist({ artistMbid: a.artist.mbid, artistName }, { artistMbid, artistName }));
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
): Promise<string | null> {
    if (!(await discoverNamed(keysOf(album)))(album)) return "Kima has no record of Discover fetching this album";
    if (await listenerClaims(claimKeys)) return "A listener has made this album theirs";
    if (await libraryHolds(claimKeys.rgMbids, names)) return "The library holds this album";
    return null;
}

/**
 * Puts Discover's tag back on the artist of an album Discover is about to delete, when an earlier cleanup took it off
 * and the artist is Discover's (`ensureDiscoverTag`), so the artist run can remove the artist later. Best effort: the
 * album goes whatever Lidarr says here.
 */
async function restoreArtistTag(album: LidarrAlbum): Promise<void> {
    try {
        const [artist, tagId] = await Promise.all([
            lidarrService.getArtistById(album.artistId),
            lidarrService.getOrCreateDiscoveryTag(),
        ]);
        if (artist && tagId !== null) await ensureDiscoverTag(artist, tagId);
    } catch (error: any) {
        logger.debug(`[Discover] Discover's tag not checked for "${album.title}": ${error?.message}`);
    }
}

/**
 * What Lidarr did with a Discover album, in words a listener can be shown. `reason`
 * says why Lidarr did not delete it, and is null when it did. `gone` marks an album
 * Lidarr no longer has.
 */
export interface LidarrRemovalResult {
    removed: boolean;
    reason: string | null;
    gone?: true;
}

/**
 * Delete a Discover album and its files. Anything that fails the identity check
 * is only unmonitored. Returns what happened, so a caller can keep the album where
 * Lidarr did not delete it; an album Lidarr no longer has is not removed, as its files
 * may still be on disk, and says so with `gone`.
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
                gone: true,
                reason: "Lidarr no longer knows this album, so its files may still be on disk; delete them by hand",
            };
        }

        // Lidarr's own id joins the caller's: untagged files leave Kima a placeholder where Lidarr has the real one.
        const own = keysOf(album);
        const claimKeys = { lidarrAlbumIds: own.lidarrAlbumIds, rgMbids: [...new Set([rgMbid, ...(names.rgMbids ?? []), ...own.rgMbids])] };
        const kept = await keepReason(album, claimKeys, names);

        if (kept) {
            logger.warn(`[Discover] Keeping Lidarr files for "${album.title}" (${lidarrAlbumId}): ${kept}`);
            await lidarrService.unmonitorAlbum(lidarrAlbumId);
            return { removed: false, reason: kept };
        }

        await restoreArtistTag(album);
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
 * Whether a listener kept a suggestion of this Lidarr artist (LIKED or MOVED): by its MusicBrainz id, or by name only
 * when the suggestion's own artist id is missing or a `temp-` placeholder. A suggestion with a real id for another
 * artist is a namesake.
 */
async function keptSuggestion(mbid: string, artistName: string): Promise<boolean> {
    const kept = await prisma.discoveryAlbum.findMany({
        where: { status: { in: ["LIKED", "MOVED"] }, ...couldBeArtist(mbid) },
        select: { artistMbid: true, artistName: true },
    });
    return kept.some((r) => sameArtist(r, { artistMbid: mbid, artistName }));
}

/**
 * Whether another current suggestion still needs Discover's tag on this Lidarr artist: one with its MusicBrainz id, or,
 * when that suggestion's artist id is missing or a `temp-` placeholder, its name. `kept` is the suggestion a listener
 * is keeping, which does not count; `artist` is Lidarr's, when it could be read.
 */
export async function otherSuggestionNeedsTag(
    kept: { id: string; artistMbid: string | null; artistName: string },
    artist: { foreignArtistId?: string; artistName?: string } | null,
): Promise<boolean> {
    const identity = { artistMbid: artist?.foreignArtistId ?? kept.artistMbid, artistName: artist?.artistName ?? kept.artistName };
    const others = await prisma.discoveryAlbum.findMany({
        where: { status: "ACTIVE", id: { not: kept.id } },
        select: { artistMbid: true, artistName: true },
    });
    return others.some((o) => sameArtist(o, identity));
}

/**
 * Whose a Lidarr artist is by Kima's records: "theirs" when a listener liked, holds or asked for any of its albums
 * (including a request still downloading, which has no files yet); "discover" when it has files and every album with
 * files is one Discover's records name; "unsure" otherwise, including when the artist has no files. `albums` is what
 * Lidarr listed, when it was read, each with its file count (`withFileCounts`).
 */
async function artistOwner(
    artist: LidarrArtist,
): Promise<{ owner: "theirs" | "discover" | "unsure"; albums: LidarrAlbum[] }> {
    const mbid = artist.foreignArtistId;
    if (mbid) {
        const [liked, library, owned, openRequest] = await Promise.all([
            keptSuggestion(mbid, artist.artistName),
            prisma.album.findFirst({
                where: { artist: { mbid }, location: LIBRARY_LOCATION },
                select: { id: true },
            }),
            // Discover albums are no one's, so any ownership record under the artist is a listener's.
            prisma.ownedAlbum.findFirst({ where: { artist: { mbid } }, select: { rgMbid: true } }),
            prisma.downloadJob.findFirst({
                where: { artistMbid: mbid, discoveryBatchId: null, status: { in: downloadJobs.ACTIVE_STATUSES } },
                select: { id: true },
            }),
        ]);
        if (liked || library || owned || openRequest) return { owner: "theirs", albums: [] };
    }
    const albums = await withFileCounts(artist.id, await lidarrService.getAlbumsByArtistId(artist.id));
    const filed = albums.filter((a) => (a.statistics?.trackFileCount ?? 0) > 0);
    if (filed.length === 0) return { owner: "unsure", albums };
    const keys: AlbumKeys = { lidarrAlbumIds: filed.map((a) => a.id), rgMbids: filed.map((a) => a.foreignAlbumId) };
    if (await listenerClaims(keys)) return { owner: "theirs", albums };
    const named = await discoverNamed(keys);
    return { owner: filed.every(named) ? "discover" : "unsure", albums };
}

/**
 * Lidarr's albums, each with a file count: Lidarr's album listing can leave the count out (an album it has not yet
 * refreshed), so Lidarr is asked once for the artist's files. Errors throw: an album whose files cannot be counted may
 * hold some, so nothing is decided on a guess.
 */
async function withFileCounts(artistId: number, albums: LidarrAlbum[]): Promise<LidarrAlbum[]> {
    if (albums.every((album) => typeof album.statistics?.trackFileCount === "number")) return albums;
    const files = await lidarrService.getTrackFileCountsByArtist(artistId);
    return albums.map((album) =>
        typeof album.statistics?.trackFileCount === "number"
            ? album
            : ({ ...album, statistics: { ...album.statistics, trackFileCount: files.get(album.id) ?? 0 } } as LidarrAlbum),
    );
}

/**
 * Makes sure an artist carries Discover's tag, putting it back when an earlier cleanup took it off and Kima's records
 * show the artist is Discover's (`artistOwner`). Only Kima tags artists, so a missing tag on such an artist is Kima's
 * own mistake. The artist passed in is never changed; the outcome is the answer. "refused" when the artist is
 * Discover's but Lidarr would not take the tag.
 */
export async function ensureDiscoverTag(
    artist: LidarrArtist,
    tagId: number,
): Promise<"tagged" | "not Discover's" | "refused"> {
    if (artist.tags?.includes(tagId)) return "tagged";
    if ((await artistOwner(artist)).owner !== "discover") return "not Discover's";
    if (!(await lidarrService.addTagsToArtist(artist.id, [tagId]))) return "refused";
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
    // By artist id, by album, or by name: an album still downloading has no files in Lidarr yet, and a suggestion's artist
    // id can be missing or a `temp-` placeholder, the only case where its name stands in for it. A suggestion with a real
    // artist id for another artist is a namesake and holds nothing.
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
        sameArtist({ artistMbid, artistName: typeof name === "string" ? name : null }, { artistMbid: mbid, artistName: artist.artistName }) ||
        (album !== null && withFiles.includes(album));
    if (
        current.some((r) => names(r.artistMbid, r.rgMbid, r.artistName)) ||
        running.some((j) => names(j.artistMbid, j.targetMbid, (j.metadata as { artistName?: unknown } | null)?.artistName))
    ) {
        return "in use";
    }
    if (owner === "discover") return "delete";

    // Nothing to delete: Lidarr forgets the artist and leaves its folder, which may hold files it does not track. A
    // listener's open request already made the artist "theirs".
    if (withFiles.length === 0) return "forget";
    return "unsure";
}

/**
 * Forget Discover's finished downloads of an artist Lidarr just deleted, so no clear reports its albums again. Only
 * downloads Lidarr fetched (a recorded Lidarr album id) go, and not one whose album Kima scanned: that album's files
 * are still Kima's to clear, and its record is what shows it is Discover's. A failure here is logged, as the artist is
 * already gone. A record with the artist's MusicBrainz id is its; one with no real id is, when its artist name is the
 * artist's (sameArtist). "In use" left no running Discover download of it.
 */
async function forgetArtistDownloads(artist: LidarrArtist): Promise<void> {
    try {
        const candidates = await prisma.downloadJob.findMany({
            where: {
                ...couldBeArtist(artist.foreignArtistId),
                discoveryBatchId: { not: null },
                lidarrAlbumId: { not: null },
                status: { notIn: downloadJobs.ACTIVE_STATUSES },
            },
            select: { id: true, targetMbid: true, artistMbid: true, metadata: true },
        });
        // A record with no real artist id names the artist only by name.
        const lidarrIdentity = { artistMbid: artist.foreignArtistId, artistName: artist.artistName };
        const jobs = candidates.filter((j) => {
            const name = (j.metadata as { artistName?: unknown } | null)?.artistName;
            return sameArtist({ artistMbid: j.artistMbid, artistName: typeof name === "string" ? name : null }, lidarrIdentity);
        });
        const scanned = new Set(
            (await prisma.album.findMany({ where: { rgMbid: { in: jobs.flatMap((j) => (j.targetMbid ? [j.targetMbid] : [])) } }, select: { rgMbid: true } })).map((a) => a.rgMbid),
        );
        await downloadJobs.remove(jobs.filter((j) => !j.targetMbid || !scanned.has(j.targetMbid)));
    } catch (error: any) {
        logger.warn(`[Discover] Removed ${artist.artistName} from Lidarr but kept its download records: ${error.message}`);
    }
}

/** What one artist's removal came to: Lidarr refusing or not answering is a failure, never a keep. */
export type ArtistRemoval = { outcome: "removed" } | { outcome: "kept" } | { outcome: "failed"; reason: string };

/**
 * Delete a Discover artist with its files when the verdict allows, then Discover's finished download records of the
 * artist, so no clear reports its albums again. When a listener has made it theirs the Discover tag comes off, so the
 * artist stays in Lidarr as theirs; when Kima cannot tell, the artist and its tag stay as they are.
 */
export async function removeDiscoveryArtist(artist: LidarrArtist): Promise<ArtistRemoval> {
    try {
        const verdict = await discoveryArtistVerdict(artist);
        if (verdict === "in use") {
            logger.debug(`[Discover] ${artist.artistName} is in a current Discover week; left for a later clear`);
            return { outcome: "kept" };
        }
        if (verdict === "theirs" || verdict === "unsure") {
            if (verdict === "theirs" && artist.foreignArtistId) await lidarrService.removeDiscoveryTagByMbid(artist.foreignArtistId);
            logger.debug(`[Discover] Keeping ${artist.artistName} in Lidarr (${verdict === "theirs" ? "a listener's" : "not provably Discover's"})`);
            return { outcome: "kept" };
        }
        const result = await lidarrService.deleteArtistById(artist.id, verdict === "delete");
        if (result.success) {
            await forgetArtistDownloads(artist);
            return { outcome: "removed" };
        }
        logger.warn(`[Discover] Lidarr did not remove artist ${artist.artistName}: ${result.message}`);
        return { outcome: "failed", reason: result.message };
    } catch (error: any) {
        logger.warn(`[Discover] Lidarr artist ${artist.artistName} not removed: ${error.message}`);
        return { outcome: "failed", reason: error.message };
    }
}
