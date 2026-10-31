/**
 * The admin re-file: every library album filed again by its files' own tags.
 *
 * Kima keeps album rows, so an album filed under the wrong artist stays there: rescans reuse the row and skip
 * unchanged files. Older versions misfiled albums (names cut at "and"/"&"/"with" before 1.10, one song split off its
 * album by a guest's album-artist tag, names glued from multi-valued tags). This reads every library file's tags,
 * elects each album's artist as the scanner does (albumArtistVote.ts), and moves the songs that sit under another
 * artist: onto that artist's own copy of the album when it has one, else onto a row of theirs that moves whole, else
 * onto a new row. Only those songs move. A row they leave empty goes, its cover and details passed on when the
 * survivor lacks them, and every record keyed on its release-group id (ownership, Discover) moves to the survivor.
 * An artist row holding the files' MusicBrainz id under a name the old splitter cut gets the full name back first.
 * Artists left with nothing go. Albums or artists a person edited, Discover's albums, and albums with a song whose
 * tags cannot be read are left alone. It runs on the scan queue (workers/processors/refileProcessor.ts), so never
 * beside a scan.
 */
import path from "path";
import { parseFile } from "music-metadata";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { canonicalizeVariousArtists } from "../utils/artistNormalization";
import { albumIdentityKey } from "./albumIdentity";
import { artistIdentityKey, artistSortName, normalizeArtistName, resolveArtist } from "./artistIdentity";
import { albumFolder, electAlbumArtist, fileCredit, type ArtistCandidate, type FileCredit } from "./albumArtistVote";
import { moveAlbumRgMbid, moveDiscoverExclusions, moveDiscoveryAlbums, moveOwnership, ownershipRank } from "./mbidReassign";
import { pruneEmptyAlbumsAndArtists } from "./libraryPrune";
import { backfillAllArtistCounts } from "./artistCountsService";
import { musicBrainzService } from "./musicbrainz";

export interface RefileResult {
    songsRead: number;
    /** Songs whose tags could not be read; their albums are left where they are. */
    songsUnreadable: number;
    /** Albums that moved to another artist whole. */
    albumsMoved: number;
    /** Albums whose songs joined the right artist's copy of them. */
    albumsMerged: number;
    /** Albums left where they are because a person edited the album or its artist. */
    keptEdited: number;
    /** Artists the old splitter had cut that held the files' MusicBrainz id, given their full name back. */
    artistsRenamed: number;
    /** Albums that could not be re-filed (an error, logged); the rest still were. */
    albumsFailed: number;
    artistsRemoved: number;
}

/** Tag reads in flight at once. */
const READ_CONCURRENCY = 8;
/** One album's moves, however many songs. */
const ALBUM_TRANSACTION_MS = 60_000;

type Tx = Prisma.TransactionClient;

interface Song {
    id: string;
    relativePath: string;
    credit?: FileCredit;
}

const ALBUM_FIELDS = {
    id: true, artistId: true, rgMbid: true, rgMbidSource: true, identityKey: true, title: true, hasUserOverrides: true,
    location: true, coverUrl: true, year: true, originalYear: true, genres: true, label: true,
    artist: { select: { mbid: true, identityKey: true, name: true, hasUserOverrides: true } },
} satisfies Prisma.AlbumSelect;
type AlbumRow = Prisma.AlbumGetPayload<{ select: typeof ALBUM_FIELDS }>;

/** Whether an artist row is the one a candidate names: by MusicBrainz id when both have one, else by name. */
function isNamed(artist: AlbumRow["artist"], candidate: ArtistCandidate): boolean {
    if (candidate.mbid && artist.mbid) return candidate.mbid === artist.mbid;
    return artist.identityKey === artistIdentityKey(canonicalizeVariousArtists(candidate.name));
}

const isPlaceholder = (rgMbid: string) => rgMbid.startsWith("temp-");

export async function refileLibrary(musicPath: string): Promise<RefileResult> {
    const result: RefileResult = {
        songsRead: 0, songsUnreadable: 0, albumsMoved: 0, albumsMerged: 0, keptEdited: 0, artistsRenamed: 0, albumsFailed: 0,
        artistsRemoved: 0,
    };

    const songs: Song[] = (
        await prisma.track.findMany({
            where: { missingSince: null, album: { location: "LIBRARY" } },
            select: { id: true, filePath: true },
            orderBy: { filePath: "asc" },
        })
    ).map((t) => ({ id: t.id, relativePath: t.filePath }));

    // 1. Every song's tags. A folder with a song that cannot be read is not judged on the rest.
    const unreadableFolders = new Set<string>();
    let next = 0;
    await Promise.all(
        Array.from({ length: READ_CONCURRENCY }, async () => {
            while (next < songs.length) {
                const song = songs[next++];
                try {
                    const metadata = await parseFile(path.join(musicPath, song.relativePath), { skipCovers: true });
                    song.credit = fileCredit(metadata.common, song.relativePath);
                    result.songsRead++;
                } catch {
                    result.songsUnreadable++;
                    unreadableFolders.add(albumFolder(song.relativePath));
                }
            }
        }),
    );

    // 2. Each album's artist, elected as the scanner elects it; with no leader each song names its own.
    const albums = new Map<string, Song[]>();
    for (const song of songs) {
        if (!song.credit || unreadableFolders.has(albumFolder(song.relativePath))) continue;
        const group = albums.get(song.credit.groupKey);
        if (group) group.push(song);
        else albums.set(song.credit.groupKey, [song]);
    }

    const filings: { candidate: ArtistCandidate; songs: Song[] }[] = [];
    for (const group of albums.values()) {
        const elected = electAlbumArtist(group.map((s) => s.credit!));
        const byTarget = new Map<string, { candidate: ArtistCandidate; songs: Song[] }>();
        for (const song of group) {
            const candidate = elected ?? song.credit!.candidate;
            const key = candidate.mbid ?? artistIdentityKey(canonicalizeVariousArtists(candidate.name));
            const entry = byTarget.get(key);
            if (entry) entry.songs.push(song);
            else byTarget.set(key, { candidate, songs: [song] });
        }
        filings.push(...byTarget.values());
    }

    // 3. Names the old splitter cut, where the cut row holds the files' MusicBrainz id: their full names back.
    const named = new Map<string, string>();
    for (const { candidate } of filings) if (candidate.mbid && !named.has(candidate.mbid)) named.set(candidate.mbid, candidate.name);
    for (const [mbid, name] of named) {
        try {
            if (await restoreCutName(mbid, name)) result.artistsRenamed++;
        } catch (error) {
            result.albumsFailed++;
            logger.warn(`[Refile] Could not give the artist with MusicBrainz id ${mbid} its name ${name}:`, error);
        }
    }

    // 4. Each album's songs under the artist their tags name.
    for (const { candidate, songs: targetSongs } of filings) {
        try {
            const outcome = await refileAlbum(candidate, targetSongs);
            if (outcome === "edited") result.keptEdited++;
            else if (outcome === "moved") result.albumsMoved++;
            else if (outcome === "merged") result.albumsMerged++;
        } catch (error) {
            result.albumsFailed++;
            logger.warn(`[Refile] Could not re-file "${targetSongs[0].credit!.albumTitle}" under ${candidate.name}:`, error);
        }
    }

    result.artistsRemoved = (await pruneEmptyAlbumsAndArtists()).artists;
    await backfillAllArtistCounts().catch((err) => logger.error("[Refile] Artist counts update failed:", err));
    logger.info(
        `[Refile] Read ${result.songsRead} songs (${result.songsUnreadable} unreadable): ${result.artistsRenamed} artists renamed, ` +
            `${result.albumsMoved} albums moved, ${result.albumsMerged} merged, ${result.keptEdited} kept as edited, ${result.albumsFailed} failed, ` +
            `${result.artistsRemoved} artists removed`,
    );
    return result;
}

/** The separators the splitter removed before 1.10 cut names at ("Coheed and Cambria" became "Coheed"). */
const OLD_CUTS = [" & ", " and ", " with ", ", "];

/** Whether `name` is `full` cut by the old splitter: its first words, up to one of those separators. */
export function isOldCut(name: string, full: string): boolean {
    const lower = full.toLowerCase();
    return OLD_CUTS.some((sep) => lower.startsWith(name.toLowerCase() + sep));
}

/**
 * The artist row holding a MusicBrainz id whose name the old splitter cut gets its full name back, in MusicBrainz's
 * spelling, once MusicBrainz confirms the files' name is that id's (a wrong tag must not rename a real artist). A row
 * under the full name with no id of its own is folded into it first, its albums and ownership with it (a copy both
 * hold becomes one, unless the holder's copy was edited or is Discover's: then nothing is renamed). Nothing else is
 * renamed: a name that differs any other way (a translation, a spelling) is the row's.
 */
async function restoreCutName(mbid: string, filesName: string): Promise<boolean> {
    const holder = await prisma.artist.findUnique({ where: { mbid }, select: { name: true, identityKey: true, hasUserOverrides: true } });
    if (!holder || holder.hasUserOverrides || holder.identityKey === artistIdentityKey(filesName) || !isOldCut(holder.name, filesName)) {
        return false;
    }
    const found = await musicBrainzService.getArtist(mbid, ["aliases"]);
    if (found.kind !== "answered") return false;
    const names = [found.value?.name, ...((found.value?.aliases ?? []) as Array<{ name?: string }>).map((alias) => alias.name)]
        .filter((n): n is string => typeof n === "string");
    if (!names.some((n) => artistIdentityKey(n) === artistIdentityKey(filesName))) return false;
    const name: string = found.value.name;
    if (!isOldCut(holder.name, name)) return false;
    const identityKey = artistIdentityKey(name);

    return prisma.$transaction(
        async (tx) => {
            const current = await tx.artist.findUnique({ where: { mbid } });
            if (!current || current.hasUserOverrides || current.name !== holder.name) return false;

            const twin = await tx.artist.findUnique({ where: { identityKey } });
            if (twin && twin.id !== current.id) {
                if (twin.mbid || twin.hasUserOverrides) return false;
                const rows = await tx.album.findMany({ where: { artistId: twin.id }, select: ALBUM_FIELDS });
                for (const row of rows) {
                    const same = await tx.album.findUnique({ where: { artistId_identityKey: { artistId: current.id, identityKey: row.identityKey } }, select: ALBUM_FIELDS });
                    // Everything rolls back: an edited or Discover copy is not merged into.
                    if (same && (same.hasUserOverrides || same.location !== "LIBRARY" || row.hasUserOverrides || row.location !== "LIBRARY")) {
                        throw new KeptAsItIs();
                    }
                    if (same) {
                        await tx.track.updateMany({ where: { albumId: row.id }, data: { albumId: same.id } });
                        await retireIfEmpty(tx, row, same, current.id);
                    } else {
                        await tx.album.update({ where: { id: row.id }, data: { artistId: current.id } });
                    }
                }
                // Every ownership record of the twin, with an album row or not.
                for (const owned of await tx.ownedAlbum.findMany({ where: { artistId: twin.id }, select: { rgMbid: true } })) {
                    await rekeyOwner(tx, twin.id, current.id, owned.rgMbid);
                }
                await tx.artist.delete({ where: { id: twin.id } });
            }
            await tx.artist.update({
                where: { id: current.id },
                data: { name, identityKey, normalizedName: normalizeArtistName(name), sortName: artistSortName(name) },
            });
            return true;
        },
        { timeout: ALBUM_TRANSACTION_MS },
    ).catch((error) => {
        if (!(error instanceof KeptAsItIs)) throw error;
        logger.info(`[Refile] Kept "${holder.name}" as it is: "${name}" holds a copy of one of its albums a person edited or Discover holds`);
        return false;
    });
}

/** Thrown to roll a rename back when it would merge into an album a person edited or Discover holds. */
class KeptAsItIs extends Error {}

/**
 * Re-file one album's songs under the artist their tags name. What it finds is read inside the transaction, so an
 * album re-filed just before is seen as it is now.
 */
async function refileAlbum(candidate: ArtistCandidate, songs: Song[]): Promise<"settled" | "edited" | "moved" | "merged"> {
    // An album under its lead artist (with a MusicBrainz id) stays when the files name a joint credit with no id:
    // nothing in the tags says it is not a band, and moving it would trade the lead's photo and id for neither.
    const underLead = (artist: AlbumRow["artist"]) => Boolean(artist.mbid) && !candidate.mbid && isOldCut(artist.name, candidate.name);
    const isMisfiled = (row: AlbumRow) => row.location === "LIBRARY" && !isNamed(row.artist, candidate) && !underLead(row.artist);
    const peek = await prisma.track.findMany({ where: { id: { in: songs.map((s) => s.id) } }, select: { album: { select: ALBUM_FIELDS } } });
    if (!peek.some((t) => isMisfiled(t.album))) return "settled";

    // Outside the transaction: a new artist row's unique-name race is retried by resolveArtist itself.
    const target = await resolveArtist(prisma, { name: candidate.name, mbid: candidate.mbid });
    const title = songs[0].credit!.albumTitle;
    const identityKey = albumIdentityKey(title);

    return prisma.$transaction(
        async (tx) => {
            const tracks = await tx.track.findMany({
                where: { id: { in: songs.map((s) => s.id) } },
                select: { id: true, album: { select: ALBUM_FIELDS } },
            });
            const misfiled = tracks.filter((t) => t.album.location === "LIBRARY" && t.album.artistId !== target.id && !underLead(t.album.artist));
            if (misfiled.length === 0) return "settled";
            const involved = [...new Map(misfiled.map((t) => [t.album.id, t.album])).values()];
            if (involved.some((row) => row.hasUserOverrides || row.artist.hasUserOverrides)) return "edited";

            let keeper = await tx.album.findUnique({ where: { artistId_identityKey: { artistId: target.id, identityKey } }, select: ALBUM_FIELDS });
            if (keeper && keeper.location !== "LIBRARY") return "edited";
            let outcome: "moved" | "merged" = "merged";

            if (!keeper) {
                // A row of these songs that holds nothing else can move whole: the best one, a real id first.
                const moving = (row: AlbumRow) => misfiled.filter((t) => t.album.id === row.id).length;
                const totals = new Map(
                    (await tx.track.groupBy({ by: ["albumId"], where: { albumId: { in: involved.map((r) => r.id) } }, _count: { _all: true } }))
                        .map((g) => [g.albumId, g._count._all]),
                );
                const whole = involved
                    .filter((row) => totals.get(row.id) === moving(row))
                    .sort((a, b) => Number(isPlaceholder(a.rgMbid)) - Number(isPlaceholder(b.rgMbid)) || moving(b) - moving(a) || a.id.localeCompare(b.id));
                const best = whole[0];
                // The target may hold the album under the row's own name key rather than the tags' title.
                const clash = best && (await tx.album.findUnique({ where: { artistId_identityKey: { artistId: target.id, identityKey: best.identityKey } }, select: ALBUM_FIELDS }));
                if (clash && clash.location !== "LIBRARY") return "edited";
                if (clash) {
                    keeper = clash;
                } else if (best) {
                    // The row takes the title its songs' tags give, as a fresh scan would file it, so the next scan
                    // finds it under the same name.
                    keeper = await tx.album.update({
                        where: { id: best.id },
                        data: { artistId: target.id, title, identityKey, sortName: artistSortName(title) },
                        select: ALBUM_FIELDS,
                    });
                    await rekeyOwner(tx, best.artistId, target.id, best.rgMbid);
                    outcome = "moved";
                } else {
                    const source = involved[0];
                    keeper = await tx.album.create({
                        data: {
                            artistId: target.id, title, identityKey, sortName: artistSortName(title), rgMbid: `temp-${Date.now()}-${Math.random()}`,
                            primaryType: "Album", location: "LIBRARY", coverUrl: source.coverUrl, year: source.year,
                            originalYear: source.originalYear, genres: source.genres ?? undefined, label: source.label,
                        },
                        select: ALBUM_FIELDS,
                    });
                }
            }

            for (const row of involved) {
                if (row.id === keeper.id) continue;
                const ids = misfiled.filter((t) => t.album.id === row.id).map((t) => t.id);
                await tx.track.updateMany({ where: { id: { in: ids } }, data: { albumId: keeper.id } });
                keeper = await retireIfEmpty(tx, row, keeper, target.id);
            }

            // Every library album is owned by its artist, as the scanner records it.
            await tx.ownedAlbum.createMany({ data: [{ artistId: target.id, rgMbid: keeper.rgMbid, source: "native_scan" }], skipDuplicates: true });

            // MusicBrainz is asked about a name with the artist's album titles as proof, so an artist it could not
            // find is asked again once it gains an album.
            await tx.artist.updateMany({
                where: { id: target.id, enrichmentStatus: "unresolvable" },
                data: { enrichmentStatus: "pending", enrichmentFailures: 0 },
            });
            return outcome;
        },
        { timeout: ALBUM_TRANSACTION_MS },
    );
}

/**
 * A row its songs have left goes, under a row lock so a song filed into it meanwhile keeps it. The survivor takes
 * the details it lacks and the row's records: a placeholder survivor adopts a real release-group id (unless a person
 * set the survivor's), otherwise everything keyed on the row's id moves to the survivor's.
 */
async function retireIfEmpty(tx: Tx, staleRow: AlbumRow, staleKeeper: AlbumRow, targetArtistId: string): Promise<AlbumRow> {
    await tx.$queryRaw`SELECT id FROM "Album" WHERE id IN (${staleRow.id}, ${staleKeeper.id}) FOR UPDATE`;
    // As they are now that they are locked: enrichment may have changed an id or a cover meanwhile.
    const keeper = await tx.album.findUniqueOrThrow({ where: { id: staleKeeper.id }, select: ALBUM_FIELDS });
    const row = await tx.album.findUnique({ where: { id: staleRow.id }, select: ALBUM_FIELDS });
    if (!row || (await tx.track.count({ where: { albumId: row.id } })) > 0) return keeper;

    await tx.album.delete({ where: { id: row.id } });
    const details = {
        ...(keeper.coverUrl ? {} : { coverUrl: row.coverUrl }),
        ...(keeper.year ? {} : { year: row.year }),
        ...(keeper.originalYear ? {} : { originalYear: row.originalYear }),
        ...(keeper.genres ? {} : { genres: row.genres ?? undefined }),
        ...(keeper.label ? {} : { label: row.label }),
    };
    let survivor: AlbumRow = await tx.album.update({ where: { id: keeper.id }, data: details, select: ALBUM_FIELDS });

    const adopt = isPlaceholder(survivor.rgMbid) && !isPlaceholder(row.rgMbid) && !survivor.hasUserOverrides && survivor.rgMbidSource !== "editor";
    if (adopt) {
        // Records on the survivor's placeholder move to the real id, where the row's own records already are.
        await moveAlbumRgMbid(tx, survivor.id, row.rgMbid, { source: (row.rgMbidSource as "tag" | "acoustid" | "search" | null) ?? "tag" });
        survivor = await tx.album.findUniqueOrThrow({ where: { id: survivor.id }, select: ALBUM_FIELDS });
    } else if (row.rgMbid !== survivor.rgMbid) {
        await moveOwnership(tx, row.rgMbid, survivor.rgMbid);
        await moveDiscoveryAlbums(tx, row.rgMbid, survivor.rgMbid);
        await moveDiscoverExclusions(tx, row.rgMbid, survivor.rgMbid);
    }
    // The row's own artist's ownership becomes the target's.
    await rekeyOwner(tx, row.artistId, targetArtistId, survivor.rgMbid);
    return survivor;
}

/** One artist's ownership of an album id becomes another's; on a clash the more protective source stays. */
async function rekeyOwner(tx: Tx, fromArtistId: string, toArtistId: string, rgMbid: string): Promise<void> {
    if (fromArtistId === toArtistId) return;
    const row = await tx.ownedAlbum.findUnique({ where: { artistId_rgMbid: { artistId: fromArtistId, rgMbid } } });
    if (!row) return;
    const clash = await tx.ownedAlbum.findUnique({ where: { artistId_rgMbid: { artistId: toArtistId, rgMbid } } });
    if (clash) {
        if (ownershipRank(row.source) < ownershipRank(clash.source)) {
            await tx.ownedAlbum.update({ where: { artistId_rgMbid: { artistId: toArtistId, rgMbid } }, data: { source: row.source } });
        }
        await tx.ownedAlbum.delete({ where: { artistId_rgMbid: { artistId: fromArtistId, rgMbid } } });
    } else {
        await tx.ownedAlbum.update({ where: { artistId_rgMbid: { artistId: fromArtistId, rgMbid } }, data: { artistId: toArtistId } });
    }
}
