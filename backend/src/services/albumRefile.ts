/**
 * The admin re-file: every library album filed again by its files' own tags, as the scanner's vote elects the artist
 * (albumArtistVote.ts). Songs under another artist move to that artist's copy, else a row that moves whole, else a new
 * row; an emptied row passes on its cover and details and an artist left with nothing goes. Albums with unreadable tags,
 * edited albums and artists, and Discover albums are left alone. Runs on the scan queue, never beside a scan.
 */
import path from "path";
import { parseFile } from "music-metadata";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { canonicalizeVariousArtists, isPlaceholderArtistName } from "../utils/artistNormalization";
import { albumIdentityKey } from "./albumIdentity";
import { artistIdentityKey, artistSortName, normalizeArtistName, resolveArtist } from "./artistIdentity";
import { albumFolder, electAlbumArtist, fileCredit, isOldCut, type ArtistCandidate, type FileCredit } from "./albumArtistVote";
import { moveAlbumRgMbid, moveDiscoverExclusions, moveDiscoveryAlbums, moveOwnerArtist, moveOwnership } from "./mbidReassign";
import { pruneEmptyAlbumsAndArtists } from "./libraryPrune";
import { deleteAlbums, deleteArtists } from "./library/albumDelete";
import { artistIsListed, markLibraryChangedQuietly } from "./libraryChanged";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { backfillAllArtistCounts, updateArtistCounts } from "./artistCountsService";
import type { StopCheck } from "../utils/stopCheck";
import { musicBrainzService } from "./musicbrainz";
import { JointCreditFiler, type JointFiling } from "./jointCredit";
import { discoverEvidence, isDiscoverEvidence, loadDiscoverRecords } from "./discovery/discoverEvidence";
import { forgetOwnedIndex } from "./discovery/ownedIndexVersion";

export interface RefileResult {
    /** The re-file ended early because the server is shutting down: some albums are still misfiled. */
    stopped: boolean;
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
/** What a delete inside a transaction owes once the transaction commits (see library/albumDelete.ts). */
type Settle = () => Promise<void>;

interface Song {
    id: string;
    relativePath: string;
    credit?: FileCredit;
}

const ALBUM_FIELDS = {
    id: true, artistId: true, rgMbid: true, rgMbidSource: true, identityKey: true, title: true, hasUserOverrides: true,
    location: true, createdAt: true, coverUrl: true, year: true, originalYear: true, genres: true, label: true,
    artist: { select: { mbid: true, identityKey: true, name: true, hasUserOverrides: true } },
} satisfies Prisma.AlbumSelect;
type AlbumRow = Prisma.AlbumGetPayload<{ select: typeof ALBUM_FIELDS }>;

/**
 * Whether an album's artist row is the one a candidate names, as resolveArtist would pick it: the row holding the
 * candidate's MusicBrainz id when one does (`holderId`), else the row of that name.
 */
function isNamed(row: AlbumRow, candidate: ArtistCandidate, holderId: string | null): boolean {
    if (holderId) return row.artistId === holderId;
    const artist = row.artist;
    if (candidate.mbid && artist.mbid) return candidate.mbid === artist.mbid;
    return artist.identityKey === artistIdentityKey(canonicalizeVariousArtists(candidate.name));
}

const isPlaceholder = (rgMbid: string) => rgMbid.startsWith("temp-");

/**
 * `shouldStop` is asked between songs read, between albums judged and between albums filed: once it says yes the
 * re-file ends with what it did (the album under way is finished, every move is its own transaction) and answers
 * `stopped`. It then prunes and recounts nothing; a later re-file does both, and finds the rest still misfiled.
 */
export async function refileLibrary(musicPath: string, stop: StopCheck = {}): Promise<RefileResult> {
    try {
        return await refileLibraryRun(musicPath, stop);
    } finally {
        // Moves and merges change which artist holds an album, and an artist's id, so a snapshot read before is stale.
        forgetOwnedIndex();
    }
}

async function refileLibraryRun(musicPath: string, { shouldStop = () => false }: StopCheck = {}): Promise<RefileResult> {
    const result: RefileResult = {
        stopped: false, songsRead: 0, songsUnreadable: 0, albumsMoved: 0, albumsMerged: 0, keptEdited: 0, artistsRenamed: 0,
        albumsFailed: 0, artistsRemoved: 0,
    };
    // Whether anything the re-file changed is something a client lists: an album that moved or merged with a playable
    // song among the songs it moved, or an artist renamed that holds a playable song.
    let listedChange = false;
    const markIfListed = async () => {
        if (listedChange) await markLibraryChangedQuietly("albums re-filed");
    };
    const halted = async (): Promise<RefileResult> => {
        result.stopped = true;
        // What was moved before the stop is already done, so a client is told of it now.
        await markIfListed();
        logger.info(`[Refile] Stopped for shutdown: ${result.albumsMoved} albums moved, ${result.albumsMerged} merged so far`);
        return result;
    };
    if (shouldStop()) return halted();

    const songs: Song[] = (
        await prisma.track.findMany({
            where: { missingSince: null, album: { location: "LIBRARY" } },
            select: { id: true, filePath: true },
        })
    )
        .map((t) => ({ id: t.id, relativePath: t.filePath }))
        // In code, as the scanner orders an album's songs: the database's collation could order them differently,
        // and a tied vote goes to the artist named first.
        .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

    // 1. Every song's tags. A folder with a song that cannot be read is not judged on the rest.
    const unreadableFolders = new Set<string>();
    let next = 0;
    await Promise.all(
        Array.from({ length: READ_CONCURRENCY }, async () => {
            while (next < songs.length && !shouldStop()) {
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

    if (shouldStop()) return halted();

    // 2. Each album's artist, elected as the scanner elects it; with no leader each song names its own.
    const albums = new Map<string, Song[]>();
    for (const song of songs) {
        if (!song.credit || unreadableFolders.has(albumFolder(song.relativePath))) continue;
        const group = albums.get(song.credit.groupKey);
        if (group) group.push(song);
        else albums.set(song.credit.groupKey, [song]);
    }

    // A joint credit is filed by one rule (jointCredit.ts), decided once per distinct name in this run. An album whose
    // name MusicBrainz could not be asked about stays where it is; the next re-file asks again.
    const filer = new JointCreditFiler();
    const judged = new Map<string, Promise<JointFiling>>();
    const judge = (candidate: ArtistCandidate) => {
        const id = candidate.mbid ?? artistIdentityKey(canonicalizeVariousArtists(candidate.name));
        let filing = judged.get(id);
        if (!filing) judged.set(id, (filing = filer.file(candidate)));
        return filing;
    };
    // An album Discover holds keeps its credit whole, and MusicBrainz is not asked about it: one with songs outside the
    // library (as the scanner treats it), or one Discover's records say is Discover's.
    const heldBy = new Set(
        (
            await prisma.track.findMany({
                where: { album: { location: { not: "LIBRARY" } } },
                select: { filePath: true, album: { select: { identityKey: true } } },
            })
        ).map((t) => `${albumFolder(t.filePath)}\n${t.album.identityKey}`),
    );
    const discoverRecords = await loadDiscoverRecords();
    const filings: { candidate: ArtistCandidate; songs: Song[] }[] = [];
    for (const [groupKey, group] of albums) {
        if (shouldStop()) return halted();
        const elected = electAlbumArtist(group.map((s) => s.credit!));
        const discovers =
            heldBy.has(groupKey) ||
            isDiscoverEvidence(
                discoverEvidence(
                    {
                        artistName: (elected ?? group[0].credit!.candidate).name,
                        artistMbid: (elected ?? group[0].credit!.candidate).mbid ?? null,
                        title: group[0].credit!.albumTitle,
                        rgMbid: group[0].credit!.rgMbid,
                    },
                    discoverRecords,
                ),
            );
        const byTarget = new Map<string, { candidate: ArtistCandidate; songs: Song[] }>();
        for (const song of group) {
            const credited = elected ?? song.credit!.candidate;
            const filed: JointFiling = discovers ? { status: "whole", candidate: credited } : await judge(credited);
            if (filed.status === "unknown") continue;
            const candidate = filed.candidate;
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
        if (shouldStop()) return halted();
        try {
            const renamedId = await restoreCutName(mbid, name);
            if (renamedId) {
                result.artistsRenamed++;
                if (!listedChange && (await artistIsListed(renamedId))) listedChange = true;
            }
        } catch (error) {
            result.albumsFailed++;
            logger.warn(`[Refile] Could not give the artist with MusicBrainz id ${mbid} its name ${name}:`, error);
        }
    }

    // 4. Each album's songs under the artist their tags name.
    for (const { candidate, songs: targetSongs } of filings) {
        if (shouldStop()) return halted();
        try {
            const { outcome, listed } = await refileAlbum(candidate, targetSongs);
            if (outcome === "edited") result.keptEdited++;
            else if (outcome === "moved") result.albumsMoved++;
            else if (outcome === "merged") result.albumsMerged++;
            if (listed) listedChange = true;
        } catch (error) {
            result.albumsFailed++;
            logger.warn(`[Refile] Could not re-file "${targetSongs[0].credit!.albumTitle}" under ${candidate.name}:`, error);
        }
    }

    // Only a moved or merged album holding a playable song, or a renamed artist holding one, is listed differently.
    await markIfListed();
    listedChange = false;
    if (shouldStop()) return halted();
    result.artistsRemoved = (await pruneEmptyAlbumsAndArtists()).artists;
    await backfillAllArtistCounts(undefined, { shouldStop }).catch((err) => logger.error("[Refile] Artist counts update failed:", err));
    // A recount cut short leaves counts out of date: the re-file is not done until a later one recounts.
    if (shouldStop()) return halted();
    logger.info(
        `[Refile] Read ${result.songsRead} songs (${result.songsUnreadable} unreadable): ${result.artistsRenamed} artists renamed, ` +
            `${result.albumsMoved} albums moved, ${result.albumsMerged} merged, ${result.keptEdited} kept as edited, ${result.albumsFailed} failed, ` +
            `${result.artistsRemoved} artists removed`,
    );
    return result;
}

/**
 * Restores an artist's full name where the old splitter cut it, once MusicBrainz confirms the files' name is that id's
 * (a wrong tag must not rename a real artist). A row already under the full name with no id is folded in first; if
 * both hold a copy of an album and either was edited or is Discover's, nothing is renamed. Other name differences
 * (translation, spelling) are the row's own. Answers the renamed artist's id, or null when nothing was renamed.
 */
async function restoreCutName(mbid: string, filesName: string): Promise<string | null> {
    const holder = await prisma.artist.findUnique({ where: { mbid }, select: { name: true, identityKey: true, hasUserOverrides: true } });
    if (!holder || holder.hasUserOverrides || holder.identityKey === artistIdentityKey(filesName) || !isOldCut(holder.name, filesName)) {
        return null;
    }
    const found = await musicBrainzService.getArtist(mbid, ["aliases"]);
    if (found.kind !== "answered") return null;
    const names = [found.value?.name, ...((found.value?.aliases ?? []) as Array<{ name?: string }>).map((alias) => alias.name)]
        .filter((n): n is string => typeof n === "string");
    if (!names.some((n) => artistIdentityKey(n) === artistIdentityKey(filesName))) return null;
    const name: string = found.value.name;
    if (!isOldCut(holder.name, name)) return null;
    const identityKey = artistIdentityKey(name);
    const afterCommit: Settle[] = [];

    const renamed = await prisma.$transaction(
        async (tx) => {
            const current = await tx.artist.findUnique({ where: { mbid } });
            if (!current || current.hasUserOverrides || current.name !== holder.name) return null;

            const twin = await tx.artist.findUnique({ where: { identityKey } });
            if (twin && twin.id !== current.id) {
                if (twin.mbid || twin.hasUserOverrides) return null;
                const rows = await tx.album.findMany({ where: { artistId: twin.id }, select: ALBUM_FIELDS });
                for (const row of rows) {
                    const same = await tx.album.findUnique({ where: { artistId_identityKey: { artistId: current.id, identityKey: row.identityKey } }, select: ALBUM_FIELDS });
                    // Everything rolls back: an edited or Discover copy is not merged into.
                    if (same && (same.hasUserOverrides || same.location !== "LIBRARY" || row.hasUserOverrides || row.location !== "LIBRARY")) {
                        throw new KeptAsItIs();
                    }
                    if (same) {
                        await tx.track.updateMany({ where: { albumId: row.id }, data: { albumId: same.id } });
                        await retireIfEmpty(tx, row, same, current.id, afterCommit);
                    } else {
                        await tx.album.update({ where: { id: row.id }, data: { artistId: current.id } });
                    }
                }
                // Every ownership record of the twin, with an album row or not, goes to the artist that stays. Its albums
                // are all moved or retired by now, so the delete owes no one a word: the run's end rebuilds Discover's
                // snapshot and recounts the artists.
                afterCommit.push((await deleteArtists([twin.id], { within: tx, keepsTo: current.id, onlyEmpty: true })).settle);
            }
            await tx.artist.update({
                where: { id: current.id },
                data: { name, identityKey, normalizedName: normalizeArtistName(name), sortName: artistSortName(name) },
            });
            return current.id;
        },
        { timeout: ALBUM_TRANSACTION_MS },
    ).catch((error) => {
        if (!(error instanceof KeptAsItIs)) throw error;
        afterCommit.length = 0;
        logger.info(`[Refile] Kept "${holder.name}" as it is: "${name}" holds a copy of one of its albums a person edited or Discover holds`);
        return null;
    });
    for (const settle of afterCommit) await settle();
    return renamed;
}

/** Thrown to roll a rename back when it would merge into an album a person edited or Discover holds. */
class KeptAsItIs extends Error {}

/**
 * Re-file one album's songs under the artist their tags name. What it finds is read inside the transaction, so an
 * album re-filed just before is seen as it is now.
 */
async function refileAlbum(
    candidate: ArtistCandidate,
    songs: Song[],
): Promise<{ outcome: "settled" | "edited" | "moved" | "merged"; listed: boolean }> {
    const unchanged = (outcome: "settled" | "edited") => ({ outcome, listed: false });
    const holder = candidate.mbid ? await prisma.artist.findUnique({ where: { mbid: candidate.mbid }, select: { id: true } }) : null;
    const isMisfiled = (row: AlbumRow) => row.location === "LIBRARY" && !isNamed(row, candidate, holder?.id ?? null);
    const peek = await prisma.track.findMany({ where: { id: { in: songs.map((s) => s.id) } }, select: { album: { select: ALBUM_FIELDS } } });
    if (!peek.some((t) => isMisfiled(t.album))) return unchanged("settled");

    // Outside the transaction: a new artist row's unique-name race is retried by resolveArtist itself.
    const target = await resolveArtist(prisma, { name: candidate.name, mbid: candidate.mbid });
    const title = songs[0].credit!.albumTitle;
    const identityKey = albumIdentityKey(title);
    const afterCommit: Settle[] = [];

    const filed = await prisma.$transaction(
        async (tx) => {
            const tracks = await tx.track.findMany({
                where: { id: { in: songs.map((s) => s.id) } },
                select: { id: true, album: { select: ALBUM_FIELDS } },
            });
            const misfiled = tracks.filter((t) => t.album.location === "LIBRARY" && t.album.artistId !== target.id);
            if (misfiled.length === 0) return unchanged("settled");
            const involved = [...new Map(misfiled.map((t) => [t.album.id, t.album])).values()];
            if (involved.some((row) => row.hasUserOverrides || row.artist.hasUserOverrides)) return unchanged("edited");

            let keeper = await tx.album.findUnique({ where: { artistId_identityKey: { artistId: target.id, identityKey } }, select: ALBUM_FIELDS });
            // A copy a person edited, or Discover's, is not merged into (as restoreCutName does not).
            const closed = (row: AlbumRow) => row.location !== "LIBRARY" || row.hasUserOverrides;
            if (keeper && closed(keeper)) return unchanged("edited");
            let outcome: "moved" | "merged" = "merged";
            // Whether the artist gains an album title; songs joining an album it has gain none.
            let gained = false;

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
                if (clash && closed(clash)) return unchanged("edited");
                if (clash) {
                    keeper = clash;
                } else if (best) {
                    gained = true;
                    // The row takes the title its songs' tags give, as a fresh scan would file it, so the next scan
                    // finds it under the same name.
                    keeper = await tx.album.update({
                        where: { id: best.id },
                        data: { artistId: target.id, title, identityKey, sortName: artistSortName(title) },
                        select: ALBUM_FIELDS,
                    });
                    await moveOwnerArtist(tx, best.artistId, target.id, best.rgMbid);
                    outcome = "moved";
                } else {
                    gained = true;
                    const source = involved[0];
                    // The songs were already in the library: the new row arrived when the earliest of their albums did.
                    const arrived = new Date(Math.min(...involved.map((row) => row.createdAt.getTime())));
                    keeper = await tx.album.create({
                        data: {
                            artistId: target.id, createdAt: arrived, title, identityKey, sortName: artistSortName(title), rgMbid: `temp-${Date.now()}-${Math.random()}`,
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
                keeper = await retireIfEmpty(tx, row, keeper, target.id, afterCommit);
            }

            // Every library album is owned by its artist, as the scanner records it.
            await tx.ownedAlbum.createMany({ data: [{ artistId: target.id, rgMbid: keeper.rgMbid, source: "native_scan" }], skipDuplicates: true });

            // MusicBrainz is asked about a name with the artist's album titles as proof, so an artist it could not
            // find is asked again once it gains an album.
            if (gained && !isPlaceholderArtistName(target.name)) {
                await tx.artist.updateMany({
                    where: { id: target.id, enrichmentStatus: "unresolvable" },
                    data: { enrichmentStatus: "pending", enrichmentFailures: 0 },
                });
            }
            // Listed: a song that moved is one a client lists, now under its new artist.
            const listed =
                (await tx.track.findFirst({ where: { AND: [PLAYABLE_SONG, { id: { in: misfiled.map((t) => t.id) } }] }, select: { id: true } })) !== null;
            return { outcome, listed };
        },
        { timeout: ALBUM_TRANSACTION_MS },
    );
    for (const settle of afterCommit) await settle();
    return filed;
}

/**
 * A row its songs have left goes, under a row lock so a song filed into it meanwhile keeps it. The survivor takes
 * the details it lacks and the row's records: a placeholder survivor adopts a real release-group id (unless a person
 * set the survivor's), otherwise everything keyed on the row's id moves to the survivor's.
 */
async function retireIfEmpty(
    tx: Tx,
    staleRow: AlbumRow,
    staleKeeper: AlbumRow,
    targetArtistId: string,
    afterCommit: Settle[],
): Promise<AlbumRow> {
    await tx.$queryRaw`SELECT id FROM "Album" WHERE id IN (${staleRow.id}, ${staleKeeper.id}) FOR UPDATE`;
    // As they are now that they are locked: enrichment may have changed an id or a cover meanwhile.
    const keeper = await tx.album.findUniqueOrThrow({ where: { id: staleKeeper.id }, select: ALBUM_FIELDS });
    const row = await tx.album.findUnique({ where: { id: staleRow.id }, select: ALBUM_FIELDS });
    if (!row || (await tx.track.count({ where: { albumId: row.id } })) > 0) return keeper;

    // Its songs are gone, so it was listed to no one and holds no playlist entry: the delete owes little (the owned-album
    // index), which the caller settles after the commit; the run's end rebuilds Discover's snapshot and recounts the artists.
    // Share links name an album by id with no foreign key: they follow the album to the survivor, before the delete
    // that would remove every link naming the row.
    await tx.shareLink.updateMany({ where: { entityType: "album", entityId: row.id }, data: { entityId: keeper.id } });
    afterCommit.push((await deleteAlbums([row.id], { within: tx })).settle);
    const details = {
        // The merged album arrived when its earlier copy did.
        ...(row.createdAt < keeper.createdAt ? { createdAt: row.createdAt } : {}),
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
    await moveOwnerArtist(tx, row.artistId, targetArtistId, survivor.rgMbid);
    return survivor;
}

/**
 * Hands every album of one artist to another that takes its place (a temp artist the real one has replaced), inside
 * the caller's transaction. An album the successor lacks moves whole. One it already holds under the same name merges
 * into the successor's copy as a twin does in the re-file: songs (with their plays, likes and playlist places, which
 * hang on the song) move over, the emptied row passes on its details and records and goes. A pair where either copy
 * was edited by a person or is Discover's is not merged: it stays where it is. The artist goes, with its keeps handed
 * to the successor, only when no album is left under it. `afterCommit` is what the caller runs once the transaction
 * commits. `kept` is the number of albums left behind (then the artist stays).
 */
export async function mergeArtistInto(
    tx: Tx,
    fromArtistId: string,
    toArtistId: string,
): Promise<{ merged: boolean; kept: number; afterCommit: Settle[] }> {
    const afterCommit: Settle[] = [];
    const closed = (row: AlbumRow) => row.location !== "LIBRARY" || row.hasUserOverrides;
    const rows = await tx.album.findMany({ where: { artistId: fromArtistId }, select: ALBUM_FIELDS });
    for (const row of rows) {
        const same = await tx.album.findUnique({ where: { artistId_identityKey: { artistId: toArtistId, identityKey: row.identityKey } }, select: ALBUM_FIELDS });
        if (!same) {
            await tx.album.update({ where: { id: row.id }, data: { artistId: toArtistId } });
        } else if (!closed(row) && !closed(same)) {
            await tx.track.updateMany({ where: { albumId: row.id }, data: { albumId: same.id } });
            await retireIfEmpty(tx, row, same, toArtistId, afterCommit);
        }
    }
    // Counted after the moves: a song filed in meanwhile keeps its album, and the artist stays with it.
    // `onlyEmpty` locks the artist row and re-checks, so an album a scan files under it in between is kept, not deleted.
    const deletion = await deleteArtists([fromArtistId], { within: tx, keepsTo: toArtistId, onlyEmpty: true });
    afterCommit.push(deletion.settle);
    if (deletion.artists > 0) return { merged: true, kept: 0, afterCommit };
    // The artist stays with the albums left under it: both artists' counts changed by what moved.
    afterCommit.push(async () => {
        for (const id of [fromArtistId, toArtistId]) {
            await updateArtistCounts(id).catch((error) => logger.warn(`[Refile] Artist counts not updated after a merge:`, error));
        }
    });
    return { merged: false, kept: await tx.album.count({ where: { artistId: fromArtistId } }), afterCommit };
}
