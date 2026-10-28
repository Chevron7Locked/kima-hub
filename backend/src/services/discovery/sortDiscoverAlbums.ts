/**
 * The one-time sort of albums the old scanner filed by guesswork. It filed an album as Discover on guesses (a title
 * shared with any Discover download, an artist Discover had once suggested), so listeners' own albums sat in Discover;
 * and it missed Discover's own downloads whenever the names differed by so much as an apostrophe, so those sat in the
 * library. The records that tell them apart are deleted after 30 days. What still tells them apart:
 *
 * - Discover's own records (discoverEvidence): a like or the listener's own request makes an album the library's; a
 *   Discover download keeps it in Discover. A suggestion alone says nothing: the old playlist recorded listeners' own
 *   albums as suggestions.
 * - Lidarr: Kima tags the artists Discover adds to Lidarr and takes the tag off when a listener asks for one of their
 *   albums themselves. An album whose artist still carries the tag and whose files Lidarr itself downloaded came from
 *   Discover. An album the listener got another way (Soulseek, by hand) is not one Lidarr holds.
 *
 * Albums filed as Discover stay there only on that evidence; the rest are the library's.
 *
 * Library albums that came from Discover go back to Discover unless the listeners made them theirs: a liked song, a
 * song in a playlist, edits to the album, songs played (KEEP_PLAYS plays across KEEP_SONGS different songs), another
 * album by the same artist that a listener got themselves, or a second library copy of the same album.
 *
 * Without Lidarr, only the records speak. When Lidarr is set up but does not answer, the sort waits for the next start
 * rather than guess.
 */
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { getSystemSettings } from "../../utils/systemSettings";
import { lidarrService } from "../lidarr";
import { updateArtistCounts } from "../artistCountsService";
import { LIBRARY_LOCATION } from "../libraryFilters";
import {
    discoverDownloaded,
    discoverEvidence,
    isDiscoverEvidence,
    loadDiscoverRecords,
    nameKey,
} from "./discoverEvidence";

/** A Discover download played this much is a listener's: KEEP_PLAYS plays across KEEP_SONGS different songs. */
export const KEEP_PLAYS = 3;
export const KEEP_SONGS = 3;

export interface DiscoverSortResult {
    toLibrary: number;
    keptByRecords: number;
    keptByLidarr: number;
    toDiscover: number;
    keptByActivity: number;
    lidarr: "read" | "not set up";
}

/** For each Discover-tagged Lidarr artist, the albums Lidarr holds files for, keyed by release-group id and title. */
async function lidarrDiscoverAlbums() {
    const tagged = await lidarrService.readDiscoveryTaggedArtists();
    if (tagged === null) return null;
    return Promise.all(
        tagged.map(async (artist) => {
            const albums = (await lidarrService.getAlbumsByArtistId(artist.id)) as Array<{
                foreignAlbumId?: string;
                title?: string;
                statistics?: { trackFileCount?: number };
            }>;
            const held = albums.filter((a) => (a.statistics?.trackFileCount ?? 0) > 0);
            return {
                mbid: artist.foreignArtistId || null,
                name: nameKey(artist.artistName),
                rgMbids: new Set(held.map((a) => a.foreignAlbumId).filter((id): id is string => !!id)),
                titles: new Set(held.map((a) => nameKey(a.title)).filter(Boolean)),
            };
        }),
    );
}

type SortedAlbum = {
    id: string;
    rgMbid: string;
    title: string;
    artistId: string;
    hasUserOverrides: boolean;
    artist: { name: string; mbid: string | null };
};

/** The library albums among `ids` that their listeners made theirs (see the header). */
async function albumsListenersKept(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await prisma.$queryRaw<{ albumId: string }[]>`
        SELECT t."albumId"
        FROM "Track" t
        WHERE t."albumId" = ANY(${ids})
        GROUP BY t."albumId"
        HAVING bool_or(EXISTS (SELECT 1 FROM "LikedTrack" l WHERE l."trackId" = t.id))
            OR bool_or(EXISTS (SELECT 1 FROM "PlaylistItem" p WHERE p."trackId" = t.id))
            OR (SELECT count(*) FROM "Play" p JOIN "Track" pt ON pt.id = p."trackId" WHERE pt."albumId" = t."albumId") >= ${KEEP_PLAYS}
               AND (SELECT count(DISTINCT p."trackId") FROM "Play" p JOIN "Track" pt ON pt.id = p."trackId" WHERE pt."albumId" = t."albumId") >= ${KEEP_SONGS}`;
    return new Set(rows.map((r) => r.albumId));
}

export async function sortDiscoverAlbums(): Promise<DiscoverSortResult | null> {
    // Read fresh: the sort marks itself done in the settings row, which is cached.
    const settings = await getSystemSettings(true);
    // No settings row yet is a new install: nothing was filed by the old guesses.
    if (!settings || settings.discoverAlbumsSortedAt) return null;

    let lidarr: Awaited<ReturnType<typeof lidarrDiscoverAlbums>>;
    try {
        lidarr = await lidarrDiscoverAlbums();
    } catch (error) {
        logger.warn("[Discover sort] Lidarr did not answer; the albums are sorted at the next start:", error);
        return null;
    }
    const heldByLidarr = (album: SortedAlbum) => {
        const artistName = nameKey(album.artist.name);
        const title = nameKey(album.title);
        return (lidarr ?? []).some(
            (artist) =>
                // The same artist: by MusicBrainz id when both have one, by name only when one does not.
                (artist.mbid && album.artist.mbid ? artist.mbid === album.artist.mbid : !!artistName && artist.name === artistName) &&
                (artist.rgMbids.has(album.rgMbid) || (!!title && artist.titles.has(title))),
        );
    };

    const records = await loadDiscoverRecords();
    const albums: (SortedAlbum & { location: string })[] = await prisma.album.findMany({
        select: {
            id: true,
            rgMbid: true,
            title: true,
            artistId: true,
            location: true,
            hasUserOverrides: true,
            artist: { select: { name: true, mbid: true } },
        },
    });
    const named = (album: SortedAlbum) => ({ artistName: album.artist.name, title: album.title, rgMbid: album.rgMbid });

    // Albums filed as Discover: they stay only on evidence.
    const toLibrary: SortedAlbum[] = [];
    let keptByRecords = 0;
    let keptByLidarr = 0;
    for (const album of albums.filter((a) => a.location === "DISCOVER")) {
        const evidence = discoverEvidence(named(album), records);
        const held = evidence === null && heldByLidarr(album);
        const stays = evidence !== null ? isDiscoverEvidence(evidence) : held;
        if (evidence !== null) {
            if (stays) keptByRecords++;
            else toLibrary.push(album);
        } else if (held) keptByLidarr++;
        else toLibrary.push(album);
    }

    // Library albums that came from Discover, unless a like or the listener's own request says otherwise.
    const library = albums.filter((a) => a.location === "LIBRARY");
    const fromDiscover = library.filter((album) => {
        const evidence = discoverEvidence(named(album), records);
        if (evidence === "liked" || evidence === "requested") return false;
        return discoverDownloaded(named(album), records) || heldByLidarr(album);
    });
    const fromDiscoverIds = new Set(fromDiscover.map((a) => a.id));
    // Artists with an album a listener got themselves: a library album not from Discover, or one this sort returns there.
    const ownArtists = new Set([...library.filter((a) => !fromDiscoverIds.has(a.id)), ...toLibrary].map((a) => a.artistId));
    const likedIntoLibrary = new Set(
        (
            await prisma.ownedAlbum.findMany({
                where: { source: "discovery_liked", rgMbid: { in: fromDiscover.map((a) => a.rgMbid) } },
                select: { artistId: true, rgMbid: true },
            })
        ).map((o) => `${o.artistId}\u0000${o.rgMbid}`),
    );
    // Two library copies of one album (same artist, same title): one is a listener's own, and which one cannot be
    // told, so both stay.
    const copies = new Map<string, number>();
    const copyKey = (album: SortedAlbum) => `${album.artistId}\u0000${nameKey(album.title)}`;
    for (const album of library) copies.set(copyKey(album), (copies.get(copyKey(album)) ?? 0) + 1);
    const listened = await albumsListenersKept(fromDiscover.map((a) => a.id));
    const toDiscover: SortedAlbum[] = [];
    let keptByActivity = 0;
    for (const album of fromDiscover) {
        const kept =
            album.hasUserOverrides ||
            ownArtists.has(album.artistId) ||
            (copies.get(copyKey(album)) ?? 0) > 1 ||
            likedIntoLibrary.has(`${album.artistId}\u0000${album.rgMbid}`) ||
            listened.has(album.id);
        if (kept) keptByActivity++;
        else toDiscover.push(album);
    }

    await prisma.$transaction(async (tx) => {
        await tx.album.updateMany({
            where: { id: { in: toLibrary.map((a) => a.id) }, location: "DISCOVER" },
            data: { location: LIBRARY_LOCATION },
        });
        await tx.album.updateMany({
            where: { id: { in: toDiscover.map((a) => a.id) }, location: LIBRARY_LOCATION },
            data: { location: "DISCOVER" },
        });
        // Discover albums are no one's: the old scanner marked these, and the ones staying in Discover, as its own.
        const leavingDiscover = new Set(toLibrary.map((a) => a.id));
        const stayingInDiscover = albums.filter((a) => a.location === "DISCOVER" && !leavingDiscover.has(a.id));
        for (const album of [...toDiscover, ...stayingInDiscover]) {
            await tx.ownedAlbum.deleteMany({ where: { artistId: album.artistId, rgMbid: album.rgMbid } });
        }
        await tx.systemSettings.update({ where: { id: settings.id }, data: { discoverAlbumsSortedAt: new Date() } });
    });
    for (const artistId of new Set([...toLibrary, ...toDiscover].map((a) => a.artistId))) await updateArtistCounts(artistId);

    const result: DiscoverSortResult = {
        toLibrary: toLibrary.length,
        keptByRecords,
        keptByLidarr,
        toDiscover: toDiscover.length,
        keptByActivity,
        lidarr: lidarr === null ? "not set up" : "read",
    };
    logger.info(
        `[Discover sort] Filed as Discover: ${result.toLibrary} are the library's, ${keptByRecords} stay by Discover's ` +
            `records and ${keptByLidarr} by Lidarr's Discover tag. In the library from Discover: ${result.toDiscover} ` +
            `go back to Discover, ${keptByActivity} stay as their listeners' (Lidarr ${result.lidarr})`,
    );
    return result;
}
