/**
 * The one-time sort of albums the old scanner filed by guesswork. An album filed as Discover stays there only on a
 * Discover download record (discoverEvidence; a suggestion alone says nothing); every other goes to the library as the
 * listener's. A library album a Discover download asked for goes back unless its listeners made it theirs: a liked song,
 * a song in a playlist, edits, KEEP_PLAYS plays across KEEP_SONGS songs, another album by the artist they got
 * themselves, or a second library copy. Lidarr's Discover tag is no evidence: it marks an artist, and a listener can add
 * their own albums to a tagged artist in Lidarr.
 */
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { getSystemSettings } from "../../utils/systemSettings";
import { updateArtistCounts } from "../artistCountsService";
import { LIBRARY_LOCATION } from "../libraryFilters";
import {
    discoverDownloaded,
    discoverEvidence,
    isDiscoverEvidence,
    loadDiscoverRecords,
} from "./discoverEvidence";
import { nameKey } from "../nameFold";

/** A Discover download played this much is a listener's: KEEP_PLAYS plays across KEEP_SONGS different songs. */
const KEEP_PLAYS = 3;
const KEEP_SONGS = 3;

export interface DiscoverSortResult {
    toLibrary: number;
    keptByRecords: number;
    toDiscover: number;
    keptByActivity: number;
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

    // Every week kept: the old scanner filed downloads from weeks long cleared.
    const records = await loadDiscoverRecords({ everyWeek: true });
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
    for (const album of albums.filter((a) => a.location === "DISCOVER")) {
        const evidence = discoverEvidence(named(album), records);
        if (evidence !== null && isDiscoverEvidence(evidence)) keptByRecords++;
        else toLibrary.push(album);
    }

    // Library albums that came from Discover, unless a like or the listener's own request says otherwise.
    const library = albums.filter((a) => a.location === "LIBRARY");
    const fromDiscover = library.filter((album) => {
        const evidence = discoverEvidence(named(album), records);
        if (evidence === "liked" || evidence === "requested") return false;
        return discoverDownloaded(named(album), records);
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
    // A title with no letters or digits folds to nothing, so it keys on its exact text.
    const copyKey = (album: SortedAlbum) => `${album.artistId}\u0000${nameKey(album.title) || `exact\u0000${album.title}`}`;
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
        // A library album is the listener's, as the scanner marks every one it files there.
        await tx.ownedAlbum.createMany({
            data: toLibrary.map((a) => ({ artistId: a.artistId, rgMbid: a.rgMbid, source: "native_scan" })),
            skipDuplicates: true,
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
        toDiscover: toDiscover.length,
        keptByActivity,
    };
    logger.info(
        `[Discover sort] Filed as Discover: ${result.toLibrary} are the library's, ${keptByRecords} stay by Discover's ` +
            `records. In the library from Discover: ${result.toDiscover} go back to Discover, ${keptByActivity} stay as ` +
            `their listeners'`,
    );
    return result;
}
