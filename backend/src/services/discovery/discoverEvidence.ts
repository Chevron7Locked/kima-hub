/**
 * Whether an album came from Discover, decided from Discover's own records and nothing looser, so the scanner, the daily
 * integrity check and the one-time sort cannot disagree. A shared title or a once-suggested artist is no evidence. An
 * album matches a record by release-group id, or by exactly its (primary) artist and title.
 */
import { prisma } from "../../utils/db";
import { parseCredit } from "../artistIdentity";
import { updateArtistCounts } from "../artistCountsService";
import { nameKey } from "../nameFold";
import { markLibraryChangedQuietly } from "../libraryChanged";

/** What the records say about one album (by id, or by artist and title). */
interface Mark {
    statuses: Set<string>;
    discoverJob: boolean;
    request: boolean;
}

/** A mark by artist and title, with the artist it names: its name, and its MusicBrainz id when it has a real one. */
interface NamedMark extends Mark {
    artistName: string;
    artistMbid: string | null;
}

/**
 * Discover's records and the listeners' own download requests, keyed by release-group id and by artist and title
 * (nameKey): suggestions of every status; download jobs waiting, running or finished, from each listener's newest batch,
 * a batch still running, or no batch (an earlier week's albums were cleared, so a later copy is theirs; the one-time sort
 * reads every kept week); and their own requests, which make an album theirs whatever Discover suggested. By artist and
 * title, a key holds one mark per artist (a namesake under another MusicBrainz id is another artist; ids that are missing
 * or `temp-` share one mark, known by name).
 */
export interface DiscoverRecords {
    byId: Map<string, Mark>;
    byName: Map<string, NamedMark[]>;
}

/** A Discover batch in these states is still fetching its albums. */
export const RUNNING_BATCH = ["downloading", "scanning"];

/** Whether two names are one name by `nameKey`; a name with no letters or digits matches only itself, exactly. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
    const key = nameKey(a);
    return key !== "" ? key === nameKey(b) : (a ?? "") === (b ?? "");
}

/** Whether an artist id is a MusicBrainz id: a missing id or a `temp-` placeholder is not one, and the artist's name stands in for it. */
export const hasRealArtistId = (artistMbid: string | null | undefined): artistMbid is string =>
    !!artistMbid && !artistMbid.startsWith("temp-");

/**
 * Whether two Discover records name the same artist: by MusicBrainz id when both have a real one (two artists with one
 * name and different ids are namesakes), by name (sameName) only when either's id is missing or a `temp-` placeholder.
 */
export function sameArtist(
    a: { artistMbid?: string | null; artistName?: string | null },
    b: { artistMbid?: string | null; artistName?: string | null },
): boolean {
    if (hasRealArtistId(a.artistMbid) && hasRealArtistId(b.artistMbid)) return a.artistMbid === b.artistMbid;
    return !!a.artistName && !!b.artistName && sameName(a.artistName, b.artistName);
}

/**
 * The same rule as a Prisma `where` piece, for a table with an `artistMbid` column: only rows that could be this
 * artist's (its id, or no real id). With no real id for the artist, any row could be, so the piece is empty.
 */
export const couldBeArtist = (artistMbid: string | null | undefined) =>
    hasRealArtistId(artistMbid)
        ? { OR: [{ artistMbid }, { artistMbid: null }, { artistMbid: { startsWith: "temp-" } }] }
        : {};

/** An artist and title as one key for lookup, or null when either has no letters or digits. */
const albumNameKey = (artist: string, title: string) => {
    const a = nameKey(artist);
    const t = nameKey(title);
    return a && t ? `${a}\u0000${t}` : null;
};

/** An artist and title as one lookup key; a name with no letters or digits keys on its exact text. */
export const lookupKey = (artist: string, title: string) => albumNameKey(artist, title) ?? `exact\u0000${artist}\u0000${title}`;

/**
 * Artist-and-title keys of Discover records, each with the artist it names, so `has` tells a namesake under another
 * MusicBrainz id apart (sameArtist) and a record with no real id still matches by name.
 */
export class NameIndex {
    private readonly byKey = new Map<string, { artistName: string; artistMbid: string | null }[]>();

    add(artistName: string, artistMbid: string | null, title: string): void {
        const key = lookupKey(artistName, title);
        this.byKey.set(key, [...(this.byKey.get(key) ?? []), { artistName, artistMbid }]);
    }

    has(artistName: string, artistMbid: string | null, title: string): boolean {
        return (this.byKey.get(lookupKey(artistName, title)) ?? []).some((entry) => sameArtist(entry, { artistName, artistMbid }));
    }
}

export async function loadDiscoverRecords(options: { everyWeek?: boolean } = {}): Promise<DiscoverRecords> {
    const [suggestions, allJobs, batches] = await Promise.all([
        prisma.discoveryAlbum.findMany({ select: { rgMbid: true, artistName: true, artistMbid: true, albumTitle: true, status: true } }),
        prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing", "completed"] } },
            select: { targetMbid: true, artistMbid: true, metadata: true, discoveryBatchId: true },
        }),
        options.everyWeek
            ? Promise.resolve([])
            : prisma.discoveryBatch.findMany({ select: { id: true, userId: true, createdAt: true, status: true } }),
    ]);
    const current = new Set<string>();
    if (!options.everyWeek) {
        const newest = new Map<string, { id: string; createdAt: Date }>();
        for (const b of batches) {
            if (RUNNING_BATCH.includes(b.status)) current.add(b.id);
            const seen = newest.get(b.userId);
            if (!seen || b.createdAt > seen.createdAt) newest.set(b.userId, b);
        }
        for (const b of newest.values()) current.add(b.id);
    }
    const jobs = options.everyWeek
        ? allJobs
        : allJobs.filter((j) => j.discoveryBatchId === null || current.has(j.discoveryBatchId));
    const records: DiscoverRecords = { byId: new Map(), byName: new Map() };
    const mark = (id: string | null, artist: string, artistMbid: string | null, title: string, apply: (m: Mark) => void) => {
        if (id) {
            let m = records.byId.get(id);
            if (!m) records.byId.set(id, (m = { statuses: new Set(), discoverJob: false, request: false }));
            apply(m);
        }
        const key = albumNameKey(artist, title);
        if (key) {
            const identity = hasRealArtistId(artistMbid) ? artistMbid : null;
            const marks = records.byName.get(key) ?? [];
            let m = marks.find((n) => n.artistMbid === identity);
            if (!m) marks.push((m = { statuses: new Set(), discoverJob: false, request: false, artistName: artist, artistMbid: identity }));
            records.byName.set(key, marks);
            apply(m);
        }
    };
    for (const s of suggestions) mark(s.rgMbid, s.artistName, s.artistMbid, s.albumTitle, (m) => m.statuses.add(s.status));
    for (const job of jobs) {
        const metadata = job.metadata as { artistName?: string; albumTitle?: string; downloadType?: string } | null;
        const fromDiscover = job.discoveryBatchId !== null || metadata?.downloadType === "discovery";
        mark(job.targetMbid, metadata?.artistName ?? "", job.artistMbid, metadata?.albumTitle ?? "", (m) => {
            if (fromDiscover) m.discoverJob = true;
            else m.request = true;
        });
    }
    return records;
}

/**
 * What the records say about an album: "liked" (a listener kept it: the library's), "requested" (a listener asked
 * for it themselves: the library's), "downloaded" (a Discover download asked for it), or null (nothing says it came
 * from Discover). A suggestion alone is no evidence: listeners' own albums carry suggestion records from the old
 * playlist, which mixed in library songs.
 */
export type DiscoverEvidence = "liked" | "requested" | "downloaded" | null;

/** An album as the records see it: its artist's name and MusicBrainz id (null when it has none), so a namesake is not mistaken for it. */
type RecordedAlbum = { artistName: string; artistMbid: string | null; title: string; rgMbid: string | null };

function marksOf(album: RecordedAlbum, records: DiscoverRecords): Mark[] {
    const primary = parseCredit(album.artistName).primary || album.artistName;
    const named = (artistName: string) =>
        (records.byName.get(albumNameKey(artistName, album.title) ?? "") ?? []).filter((m) =>
            sameArtist(m, { artistMbid: album.artistMbid, artistName }),
        );
    const byRelease = album.rgMbid ? records.byId.get(album.rgMbid) : undefined;
    return [...new Set([...(byRelease ? [byRelease] : []), ...named(album.artistName), ...named(primary)])];
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
 * Library albums a Discover download asked for (discoverEvidence) that nothing marks as a listener's (no ownership
 * record of any source, the scanner's included) and no playlist holds, moved to DISCOVER: filed as LIBRARY by an
 * older scanner or by hand. With `dryRun`, only listed. Run daily by the integrity check and on demand by an
 * admin (POST /discover/fix-tagging).
 */
export async function relocateDiscoverAlbums(options: { dryRun: boolean }): Promise<{ artist: string; title: string }[]> {
    const records = await loadDiscoverRecords();
    const albums = await prisma.album.findMany({
        where: { location: "LIBRARY" },
        select: { id: true, title: true, rgMbid: true, artistId: true, artist: { select: { name: true, mbid: true } } },
    });

    const moved: { artist: string; title: string }[] = [];
    const movedArtists = new Set<string>();
    for (const album of albums) {
        const evidence = discoverEvidence({ artistName: album.artist.name, artistMbid: album.artist.mbid, title: album.title, rgMbid: album.rgMbid }, records);
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
    // Library albums left the library: a client no longer lists them.
    if (movedArtists.size > 0) await markLibraryChangedQuietly("library albums moved to Discover");
    return moved;
}

