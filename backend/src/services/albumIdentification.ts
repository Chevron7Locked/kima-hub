/**
 * Which MusicBrainz album (release group) an untagged album is, decided once from all its songs'
 * AcoustID answers: AcoustID is MusicBrainz looked up by sound, and lists every album a recording
 * is on, so the album most of the songs agree on, under this album's title, is the album.
 */

import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { topVoted } from "../utils/votes";
import { acoustidService } from "./acoustidService";
import { albumIdentityKey, editionlessKey, isGenericAlbumTitle } from "./albumIdentity";
import { findAlbumArtwork } from "./artwork";
import { LIBRARY_LOCATION } from "./libraryFilters";
import { DuplicateMbidError, reassignAlbumRgMbid } from "./mbidReassign";
import { musicBrainzService, type AlbumCatalogue } from "./musicbrainz";
import { sourcePauseController } from "./sourcePauseController";
import { askedAgain } from "./stageReopen";

/** One song of the album: AcoustID's pick for it, or null when AcoustID has none. */
export interface AlbumSongAnswer {
    pick: {
        /** The pick's title (and version) is the song's; a length-only pick does not vote. */
        titleAgrees: boolean;
        /** Every album AcoustID lists for the picked recording. */
        releaseGroups: { id: string; title: string }[];
    } | null;
}

export type AlbumVerdict =
    | { kind: "assign"; releaseGroupId: string; title: string; votes: number; songs: number }
    | {
          kind: "none";
          reason: "generic-title" | "no-agreeing-album" | "short-of-majority" | "tie";
          votes: number;
          songs: number;
          leaders: string[];
      };

/**
 * Each song whose AcoustID pick agrees on title votes once for every album it lists whose title,
 * edition words aside ("Deluxe", "Remastered"; "(Live)" is kept), is this album's. The winner
 * needs more than half of the album's songs; a tie is broken only by an exact title match. A
 * generic title ("Greatest Hits") is never decided: too many albums share it.
 */
export function voteAlbumReleaseGroup(albumTitle: string, songs: AlbumSongAnswer[]): AlbumVerdict {
    const none = (reason: Extract<AlbumVerdict, { kind: "none" }>["reason"], votes = 0, leaders: string[] = []) =>
        ({ kind: "none", reason, votes, songs: songs.length, leaders }) as const;
    if (isGenericAlbumTitle(albumTitle)) return none("generic-title");

    const key = editionlessKey(albumTitle);
    const tally = new Map<string, { title: string; votes: number }>();
    for (const song of songs) {
        if (!song.pick?.titleAgrees) continue;
        const named = new Map<string, string>();
        for (const rg of song.pick.releaseGroups) {
            if (rg.title && editionlessKey(rg.title) === key) named.set(rg.id, rg.title);
        }
        for (const [id, title] of named) {
            const row = tally.get(id) ?? { title, votes: 0 };
            row.votes += 1;
            tally.set(id, row);
        }
    }
    if (tally.size === 0) return none("no-agreeing-album");

    const most = Math.max(...[...tally.values()].map((row) => row.votes));
    let leaders = [...tally.entries()].filter(([, row]) => row.votes === most);
    if (leaders.length > 1) {
        const exact = albumIdentityKey(albumTitle);
        leaders = leaders.filter(([, row]) => albumIdentityKey(row.title) === exact);
        if (leaders.length !== 1) return none("tie", most, [...tally.entries()].filter(([, r]) => r.votes === most).map(([id]) => id));
    }
    const [releaseGroupId, winner] = leaders[0];
    if (winner.votes * 2 <= songs.length) return none("short-of-majority", winner.votes, [releaseGroupId]);
    return { kind: "assign", releaseGroupId, title: winner.title, votes: winner.votes, songs: songs.length };
}

/** What one tracklist fetch says about the album itself. */
export type AlbumFacts = {
    albumGenres: { name: string; count: number }[];
    originalYear: number | null;
    label: string | null;
};

export function albumFactsOf(catalogue: AlbumCatalogue): AlbumFacts {
    return { albumGenres: catalogue.genres, originalYear: catalogue.originalYear, label: catalogue.label };
}

/** Fill the album's original year, label and top five genres, each only where
 * still blank, so scan tags and manual edits are never overwritten. */
export async function fillAlbumFromCatalogue(
    album: { id: string; year: number | null; label: string | null; genres: Prisma.JsonValue },
    answer: AlbumFacts,
): Promise<void> {
    const data: { year?: number; label?: string; genres?: string[] } = {};
    if (album.year == null && answer.originalYear != null) data.year = answer.originalYear;
    if (!album.label && answer.label) data.label = answer.label;
    const existing = album.genres as string[] | null;
    if ((existing == null || existing.length === 0) && answer.albumGenres.length > 0) {
        data.genres = topVoted(answer.albumGenres, 5);
    }
    if (Object.keys(data).length > 0) {
        await prisma.album.update({ where: { id: album.id }, data });
    }
}

/** Albums worked on per round (asked about or voted on; an album already decided does not count),
 * and the time a round may take before it stops at the next album. These bounds and the two
 * put-aside times below are chosen limits, not measured ones: they decide how long work waits,
 * never which album an id names. */
const ALBUMS_PER_ROUND = 10;
const ROUND_BUDGET_MS = 20_000;
/** A verdict is remembered this long (an unmatched AcoustID reply's lifetime), unless the songs change. */
const VERDICT_TTL = 7 * 24 * 3600;
/** A MusicBrainz failure puts the album aside this long, so it is not asked again every round. */
const POSTPONE_TTL = 15 * 60;
/** An album still missing an AcoustID reply is put aside this long (the batch hold is a minute). */
const MISSING_REPLY_TTL = 2 * 60;
/** How many backlog albums one round looks through, and where the next round resumes. */
const BACKLOG_PAGE = ALBUMS_PER_ROUND * 5;
let backlogCursor = "";

/** The song signature a remembered verdict was made for; an unreadable memo is no memo. */
function memoSignature(memo: string): string | undefined {
    try {
        return (JSON.parse(memo) as { signature?: string }).signature;
    } catch {
        return undefined;
    }
}

interface CandidateAlbum {
    id: string;
    title: string;
    rgMbid: string;
    artistId: string;
    artist: string;
    year: number | null;
    label: string | null;
    genres: Prisma.JsonValue;
    coverUrl: string | null;
}

/**
 * LIBRARY albums with a placeholder id that Discover is not managing (by id, or by artist and
 * title for an album Discover fetched), with every present song's fingerprint settled.
 */
function candidateAlbums(filter: Prisma.Sql, order: Prisma.Sql, limit: number): Promise<CandidateAlbum[]> {
    return prisma.$queryRaw<CandidateAlbum[]>`
        SELECT a.id, a.title, a."rgMbid", a."artistId", ar.name AS artist, a.year, a.label, a.genres, a."coverUrl"
          FROM "Album" a JOIN "Artist" ar ON ar.id = a."artistId"
         WHERE a.location = ${LIBRARY_LOCATION}::"AlbumLocation"
           AND a."rgMbid" LIKE 'temp-%'
           AND ${filter}
           AND NOT EXISTS (SELECT 1 FROM "DiscoveryAlbum" d
                            WHERE d.status IN ('ACTIVE', 'LIKED')
                              AND (d."rgMbid" = a."rgMbid"
                                   OR (lower(d."albumTitle") = lower(a.title) AND lower(d."artistName") = lower(ar.name))))
           AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id AND t."missingSince" IS NULL)
           AND NOT EXISTS (
                SELECT 1 FROM "Track" t
                 WHERE t."albumId" = a.id AND t."missingSince" IS NULL
                   AND NOT EXISTS (SELECT 1 FROM "TrackStage" fp
                                    WHERE fp."trackId" = t.id AND fp.stage = 'fingerprint'
                                      AND (fp.status IN ('done', 'blocked') OR (fp.status = 'failed' AND fp.retryable = false))))
         ORDER BY ${order}
         LIMIT ${limit}`;
}

/**
 * Give untagged LIBRARY albums their MusicBrainz album id from their songs' AcoustID answers:
 * the albums of the songs about to be handed out first, in the order they go out, then the
 * backlog (songs already identified never come round again). Holds its caller for about
 * ROUND_BUDGET_MS plus the album in hand. Returns the ids of the albums given one. One album's
 * failure never stops the round; a paused MusicBrainz waits for the next round.
 */
export async function identifyAlbumsBySound(windowAlbumIds: string[]): Promise<string[]> {
    if (await sourcePauseController.isPaused("musicbrainz")) return [];
    const started = Date.now();
    const assigned: string[] = [];
    let worked = 0;
    const spent = () => worked >= ALBUMS_PER_ROUND || Date.now() - started > ROUND_BUDGET_MS;
    const work = async (album: CandidateAlbum) => {
        try {
            const outcome = await identifyAlbum(album);
            if (outcome !== "already-decided") worked += 1;
            if (outcome === "assigned") assigned.push(album.id);
        } catch (err) {
            worked += 1;
            logger.warn(`[AlbumIdentity] ${album.artist} — "${album.title}" not decided: ${(err as Error).message}`);
        }
    };

    if (windowAlbumIds.length > 0) {
        const window = await candidateAlbums(
            Prisma.sql`a.id = ANY(${windowAlbumIds})`,
            Prisma.sql`array_position(${windowAlbumIds}::text[], a.id)`,
            windowAlbumIds.length,
        );
        for (const album of window) {
            if (spent()) return assigned;
            await work(album);
        }
    }

    const skip = windowAlbumIds.length > 0 ? windowAlbumIds : [""];
    const backlog = await candidateAlbums(
        Prisma.sql`a.id > ${backlogCursor} AND NOT (a.id = ANY(${skip}))`,
        Prisma.sql`a.id`,
        BACKLOG_PAGE,
    );
    if (backlog.length === 0) backlogCursor = "";
    for (const album of backlog) {
        if (spent()) break;
        await work(album);
        backlogCursor = album.id;
    }
    if (backlog.length < BACKLOG_PAGE && !spent()) backlogCursor = "";
    return assigned;
}

type AlbumOutcome = "assigned" | "decided-none" | "postponed" | "already-decided";

async function identifyAlbum(album: CandidateAlbum): Promise<AlbumOutcome> {
    const tracks = await prisma.track.findMany({
        where: { albumId: album.id, missingSince: null },
        select: { id: true, title: true, duration: true, acoustidFingerprint: true },
        orderBy: { id: "asc" },
    });
    if (tracks.length === 0) return "already-decided";

    // A verdict holds while the album has the same songs and fingerprints.
    const signature = createHash("sha256")
        .update(tracks.map((t) => `${t.id}:${t.acoustidFingerprint ? createHash("sha256").update(t.acoustidFingerprint).digest("hex") : "-"}`).join("|"))
        .digest("hex");
    const memoKey = `acoustid:album-vote:${album.id}`;
    const memo = await redisClient.get(memoKey).catch(() => null);
    if (memo && memoSignature(memo) === signature) return "already-decided";
    const remember = (outcome: string, ttl = VERDICT_TTL) =>
        redisClient
            .setex(memoKey, ttl, JSON.stringify({ signature, outcome, at: new Date().toISOString() }))
            .catch(() => undefined);

    // Too many albums share a generic title for any vote to settle it: nothing is asked.
    if (isGenericAlbumTitle(album.title)) {
        await remember("generic-title");
        return "decided-none";
    }

    // Every fingerprinted song needs a saved reply; the missing ones are asked in batches, and an
    // album still missing one waits for a later round with no verdict.
    const askable = tracks.filter((t) => t.acoustidFingerprint && t.duration > 0);
    const unsaved = async () => {
        const out: typeof askable = [];
        for (const t of askable) if (!(await acoustidService.hasSavedReply(t.duration, t.acoustidFingerprint!))) out.push(t);
        return out;
    };
    let missing = await unsaved();
    if (missing.length > 0) {
        await acoustidService.lookupMany(missing.map((t) => ({ duration: t.duration, fingerprint: t.acoustidFingerprint! })));
        missing = await unsaved();
        if (missing.length > 0) {
            await remember("waiting-for-acoustid", MISSING_REPLY_TTL);
            return "postponed";
        }
    }

    const answers: AlbumSongAnswer[] = [];
    for (const t of tracks) {
        const answer = t.acoustidFingerprint && t.duration > 0
            ? await acoustidService.savedAnswer(t.duration, t.acoustidFingerprint, t.title)
            : null;
        answers.push({ pick: answer ? { titleAgrees: answer.titleAgrees, releaseGroups: answer.releaseGroups } : null });
    }
    const verdict = voteAlbumReleaseGroup(album.title, answers);
    if (verdict.kind === "none") {
        await remember(verdict.reason);
        return "decided-none";
    }

    // Another album already holds the id, or one of this artist's albums carries exactly its
    // title and is the better owner: leave both.
    const holder = await prisma.album.findUnique({ where: { rgMbid: verdict.releaseGroupId }, select: { id: true } });
    const sibling = await prisma.album.findFirst({
        where: { artistId: album.artistId, id: { not: album.id }, identityKey: albumIdentityKey(verdict.title) },
        select: { id: true },
    });
    if (holder || sibling) {
        await remember(holder ? "collision" : "sibling");
        return "decided-none";
    }

    // MusicBrainz must know the album and give its tracklist: an id it does not know (AcoustID's
    // copy can hold one MusicBrainz has since merged away) is never written.
    const catalogue = await musicBrainzService.getAlbumCatalogue(verdict.releaseGroupId);
    if (catalogue.kind === "absent") {
        await remember("no-tracklist");
        return "decided-none";
    }
    if (catalogue.kind !== "answered") {
        await remember("postponed", POSTPONE_TTL);
        return "postponed";
    }

    try {
        const moved = await reassignAlbumRgMbid(album.id, verdict.releaseGroupId, {
            source: "acoustid",
            expectedOld: album.rgMbid,
        });
        if (!moved) return "postponed";
    } catch (err) {
        if (!(err instanceof DuplicateMbidError)) throw err;
        await remember("collision");
        return "decided-none";
    }

    await fillAlbumFromCatalogue(album, albumFactsOf(catalogue.value));
    if (!album.coverUrl) {
        try {
            const found = await findAlbumArtwork({ rgMbid: verdict.releaseGroupId, artistName: album.artist, albumTitle: album.title });
            if (found) await prisma.album.updateMany({ where: { id: album.id, coverUrl: null }, data: { coverUrl: found.url } });
        } catch {
            // A cover is optional; the album keeps its id without one.
        }
    }
    // Songs that found no recording before can now be named from the album's tracklist.
    await prisma.$executeRaw`
        UPDATE "TrackStage" ts
           SET ${askedAgain}, evidence = jsonb_build_object('reason', 'album identified')
          FROM "Track" t
         WHERE ts."trackId" = t.id AND t."albumId" = ${album.id}
           AND ts.stage = 'recording' AND ts.status = 'done'
           AND t."recordingMbid" IS NULL AND ts."decidedAt" IS NULL`;
    await remember("assigned");
    logger.info(
        `[AlbumIdentity] ${album.artist} — "${album.title}" is MusicBrainz album ${verdict.releaseGroupId} ` +
            `("${verdict.title}"): ${verdict.votes} of ${verdict.songs} songs agree`,
    );
    return "assigned";
}
