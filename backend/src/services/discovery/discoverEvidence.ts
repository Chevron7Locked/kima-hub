/**
 * Whether an album came from Discover, decided from Discover's own records and nothing looser. The scanner (when it
 * creates an album), the daily integrity check and the one-time sort all ask this, so they cannot disagree. A shared
 * title with another artist's album, or an artist Discover once suggested, is no evidence: those guesses filed
 * listeners' own albums as Discover.
 *
 * An album matches a record by release-group id, or by exactly its artist (or the credit's primary artist) and title.
 */
import { prisma } from "../../utils/db";
import { parseCredit } from "../artistIdentity";
import { updateArtistCounts } from "../artistCountsService";
import { nameKey } from "../nameFold";

/** What the records say about one album (by id, or by artist and title). */
interface Mark {
    statuses: Set<string>;
    discoverJob: boolean;
    request: boolean;
}

/**
 * Discover's records and the listeners' own download requests, keyed for lookup: by release-group id, and by artist
 * and title (nameKey). Suggestions in every status; Discover download jobs waiting, running or finished (finished ones
 * go after 30 days); the listeners' own requests, which make an album theirs whatever Discover suggested.
 */
export interface DiscoverRecords {
    byId: Map<string, Mark>;
    byName: Map<string, Mark>;
}

/** Whether two names are one name by `nameKey`; a name with no letters or digits matches only itself, exactly. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
    const key = nameKey(a);
    return key !== "" ? key === nameKey(b) : (a ?? "") === (b ?? "");
}

/** An artist and title as one key for lookup, or null when either has no letters or digits. */
export const albumNameKey = (artist: string, title: string) => {
    const a = nameKey(artist);
    const t = nameKey(title);
    return a && t ? `${a}\u0000${t}` : null;
};

/** An artist and title as one lookup key; a name with no letters or digits keys on its exact text. */
export const lookupKey = (artist: string, title: string) => albumNameKey(artist, title) ?? `exact\u0000${artist}\u0000${title}`;

export async function loadDiscoverRecords(): Promise<DiscoverRecords> {
    const [suggestions, jobs] = await Promise.all([
        prisma.discoveryAlbum.findMany({ select: { rgMbid: true, artistName: true, albumTitle: true, status: true } }),
        prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing", "completed"] } },
            select: { targetMbid: true, metadata: true, discoveryBatchId: true },
        }),
    ]);
    const records: DiscoverRecords = { byId: new Map(), byName: new Map() };
    const mark = (id: string | null, artist: string, title: string, apply: (m: Mark) => void) => {
        const name = albumNameKey(artist, title);
        for (const [map, key] of [[records.byId, id], [records.byName, name]] as const) {
            if (!key) continue;
            let m = map.get(key);
            if (!m) map.set(key, (m = { statuses: new Set(), discoverJob: false, request: false }));
            apply(m);
        }
    };
    for (const s of suggestions) mark(s.rgMbid, s.artistName, s.albumTitle, (m) => m.statuses.add(s.status));
    for (const job of jobs) {
        const metadata = job.metadata as { artistName?: string; albumTitle?: string; downloadType?: string } | null;
        const fromDiscover = job.discoveryBatchId !== null || metadata?.downloadType === "discovery";
        mark(job.targetMbid, metadata?.artistName ?? "", metadata?.albumTitle ?? "", (m) => {
            if (fromDiscover) m.discoverJob = true;
            else m.request = true;
        });
    }
    return records;
}

/**
 * What the records say about an album: "liked" (a listener kept it: the library's), "requested" (a listener asked
 * for it themselves: the library's), "downloaded" (a Discover download asked for it), or null (nothing says it came
 * from Discover). A suggestion alone is no evidence: before 1.12 the Discover playlist mixed in library songs and
 * recorded their albums as suggestions, so listeners' own albums carry suggestion records.
 */
export type DiscoverEvidence = "liked" | "requested" | "downloaded" | null;

type RecordedAlbum = { artistName: string; title: string; rgMbid: string | null };

function marksOf(album: RecordedAlbum, records: DiscoverRecords): Mark[] {
    const primary = parseCredit(album.artistName).primary || album.artistName;
    return [
        album.rgMbid ? records.byId.get(album.rgMbid) : undefined,
        records.byName.get(albumNameKey(album.artistName, album.title) ?? ""),
        records.byName.get(albumNameKey(primary, album.title) ?? ""),
    ].filter((m): m is Mark => !!m);
}

/** Whether a Discover download asked for this album (a suggestion alone is not a download). */
export const discoverDownloaded = (album: RecordedAlbum, records: DiscoverRecords) =>
    marksOf(album, records).some((m) => m.discoverJob);

export function discoverEvidence(album: RecordedAlbum, records: DiscoverRecords): DiscoverEvidence {
    const marks = marksOf(album, records);
    const has = (status: string) => marks.some((m) => m.statuses.has(status));
    if (has("LIKED") || has("MOVED")) return "liked";
    if (marks.some((m) => m.request)) return "requested";
    if (marks.some((m) => m.discoverJob)) return "downloaded";
    return null;
}

/** Whether the evidence puts an album in Discover. */
export const isDiscoverEvidence = (evidence: DiscoverEvidence) => evidence === "downloaded";

/**
 * Whether any of the album's songs sit in a playlist. A listener curated them, so the album is theirs:
 * nothing moves it back to Discover. The one playlist rule, used wherever an album's stay is decided.
 */
export async function albumHasPlaylistTrack(albumId: string): Promise<boolean> {
    const item = await prisma.playlistItem.findFirst({ where: { track: { albumId } }, select: { id: true } });
    return item !== null;
}

/**
 * Library albums Discover's records name (a Discover download or suggestion) that nothing marks as a listener's (no
 * ownership record of any source, the scanner's included) and no playlist holds, moved to DISCOVER: filed as LIBRARY
 * by an older scanner or by hand. With `dryRun`, only listed. Run daily by the integrity check and on demand by an
 * admin (POST /discover/fix-tagging).
 */
export async function relocateDiscoverAlbums(options: { dryRun: boolean }): Promise<{ artist: string; title: string }[]> {
    const records = await loadDiscoverRecords();
    const albums = await prisma.album.findMany({
        where: { location: "LIBRARY" },
        select: { id: true, title: true, rgMbid: true, artistId: true, artist: { select: { name: true } } },
    });

    const moved: { artist: string; title: string }[] = [];
    const movedArtists = new Set<string>();
    for (const album of albums) {
        const evidence = discoverEvidence({ artistName: album.artist.name, title: album.title, rgMbid: album.rgMbid }, records);
        if (!isDiscoverEvidence(evidence)) continue;

        // An album marked as a listener's, by any source (a scan, a like, enrichment, a repair), stays theirs. The
        // scanner reads the records fresh for each album it creates and Discover writes its download record before
        // the download starts, so a Discover download is never marked as a scan's.
        const kept = await prisma.ownedAlbum.findFirst({
            where: { artistId: album.artistId, rgMbid: album.rgMbid },
            select: { rgMbid: true },
        });
        if (kept) continue;
        if (await albumHasPlaylistTrack(album.id)) continue;

        if (!options.dryRun) {
            const updated = await prisma.album.updateMany({
                where: { id: album.id, location: "LIBRARY" },
                data: { location: "DISCOVER" },
            });
            if (updated.count === 0) continue;
            // Discover albums are no one's: any other ownership the album picked up goes with the move.
            await prisma.ownedAlbum.deleteMany({ where: { artistId: album.artistId, rgMbid: album.rgMbid } });
        }
        if (!options.dryRun) movedArtists.add(album.artistId);
        moved.push({ artist: album.artist.name, title: album.title });
    }
    // The artist's library and Discover counts, which listings filter on, follow the albums.
    for (const artistId of movedArtists) await updateArtistCounts(artistId);
    return moved;
}

