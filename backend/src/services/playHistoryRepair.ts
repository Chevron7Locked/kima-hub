/**
 * Finds and removes play records that provably were skips. Two plays by one
 * person bound the first from above: a short gap proves a skip, a long gap
 * proves nothing. Only provable skips are offered for deletion, and the last
 * play of a session, having no bound, is always kept.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { lockPlayHistory, PLAY_HISTORY_REPAIR_MAX_MS, requiredListenSeconds } from "./playRecording";
import { MIN_LISTEN_WINDOW_SECONDS, playHistoryPages, type PlayHistoryRow } from "./stats/listens";

/*
 * Rows are grouped into listens first: rows for one track closer together than
 * the track's length are one listen. A listen's span (first row to last) is a
 * floor on what was heard, so it is "heard" if the span clears the threshold,
 * "skipped" only if span plus the gap to the next play still falls short.
 *
 * Every play of the person's is in the sequence that bounds a listen, Discover
 * ones too (a Discover song started right after a library one still ended it),
 * but only library plays are listens: nothing reports, collapses or removes a
 * Discover play.
 */

type ListenVerdict = "heard" | "unclear" | "skipped" | "never-counts";

export interface Listen {
    trackId: string;
    title: string;
    artist: string;
    durationSeconds: number;
    requiredSeconds: number | null;
    /** Rows this one listen wrote. Everything past the first is duplication. */
    rows: number;
    playIds: string[];
    startedAt: Date;
    /** Seconds from the first row to the last: a floor on what was heard. */
    spanSeconds: number;
    /** Seconds from the last row to the next play of anything. */
    gapAfterSeconds: number | null;
    verdict: ListenVerdict;
    /** Where this listen began among the person's listens, counting from 0. */
    ordinal: number;
}

/** How a history is read: a page of rows at a time, through the transaction the caller holds, if any. */
interface HistoryRead {
    pageSize?: number;
    db?: Prisma.TransactionClient;
}

/** What the audit and the repairs let a caller choose: how big a page is (tests use small ones). */
type AuditRead = Pick<HistoryRead, "pageSize">;

/** What a repair holds in one go: the read of the whole history and the delete of what it judged. */
const REPAIR_TRANSACTION = { timeout: PLAY_HISTORY_REPAIR_MAX_MS, maxWait: 60_000 } as const;

function judge(span: number, gapAfter: number | null, required: number | null): ListenVerdict {
    if (required === null) return "never-counts";
    if (span >= required) return "heard";
    if (gapAfter === null) return "unclear";
    return span + gapAfter < required ? "skipped" : "unclear";
}

/** A listen still open: more rows of its track may yet join it. */
interface OpenListen {
    listen: Listen;
    /** A row of it was recorded by the listen rule, so it was heard whatever its gaps say. */
    recordedHeard: boolean;
    /** Seconds from its first row that a row of the track still joins it. */
    window: number;
}

/**
 * Walks the person's history in pages and hands over each listen once it is complete, in no particular order (`ordinal`
 * says where it began). Holds only what the gap rule needs: the one library play waiting for the next play of anything
 * to tell its gap, and the listens whose window is still open. A listen is complete when a later row of its track opens
 * another one, when its window has passed, or at the end.
 */
async function walkListens(userId: string, onListen: (listen: Listen) => void, read: HistoryRead = {}): Promise<void> {
    const open = new Map<string, OpenListen>();
    let began = 0;
    // The last library play seen, until the play after it (of any song, in either location) gives its gap.
    let waiting: PlayHistoryRow | null = null;

    const complete = ({ listen, recordedHeard }: OpenListen) => {
        listen.verdict = recordedHeard
            ? "heard"
            : judge(listen.spanSeconds, listen.gapAfterSeconds, listen.requiredSeconds);
        onListen(listen);
    };

    const settle = (p: PlayHistoryRow, gapAfter: number | null) => {
        const window = Math.max(MIN_LISTEN_WINDOW_SECONDS, p.track.duration);
        const current = open.get(p.trackId);
        // Measured from where the listen began, not from its latest row: measuring from
        // the latest row would fold a genuine replay into the previous listen and queue
        // its row for deletion. Same rule as `stats/listens.ts`. `<`: a row exactly one
        // duration after the listen began starts a new listen, matching the recording path.
        if (current && (p.playedAt.getTime() - current.listen.startedAt.getTime()) / 1000 < window) {
            const { listen } = current;
            listen.rows += 1;
            listen.playIds.push(p.id);
            listen.spanSeconds = (p.playedAt.getTime() - listen.startedAt.getTime()) / 1000;
            listen.gapAfterSeconds = gapAfter;
            if (p.heard) current.recordedHeard = true;
            return;
        }
        if (current) complete(current);
        open.set(p.trackId, {
            listen: {
                trackId: p.trackId,
                title: p.track.displayTitle ?? p.track.title,
                artist: p.track.album.artist.displayName ?? p.track.album.artist.name,
                durationSeconds: p.track.duration,
                requiredSeconds: requiredListenSeconds(p.track.duration),
                rows: 1,
                playIds: [p.id],
                startedAt: p.playedAt,
                spanSeconds: 0,
                gapAfterSeconds: gapAfter,
                verdict: "unclear",
                ordinal: began++,
            },
            recordedHeard: p.heard,
            window,
        });
    };

    for await (const page of playHistoryPages(userId, read)) {
        for (const p of page) {
            if (waiting) settle(waiting, (p.playedAt.getTime() - waiting.playedAt.getTime()) / 1000);
            waiting = p.library ? p : null;
        }
        // Nothing still to come is earlier than this page's last row, so a listen whose window has passed by then is complete.
        const now = page[page.length - 1].playedAt.getTime();
        for (const [trackId, o] of open) {
            if ((now - o.listen.startedAt.getTime()) / 1000 >= o.window) {
                open.delete(trackId);
                complete(o);
            }
        }
    }
    if (waiting) settle(waiting, null);
    for (const o of open.values()) complete(o);
}

/**
 * Every listen in a user's history, in the order they began, with what can and cannot be shown about it.
 *
 * Holds every listen at once, so it is for tests and scripts: the audit and the repairs walk the history without keeping it.
 */
export async function listensOf(userId: string, read: HistoryRead = {}): Promise<Listen[]> {
    const listens: Listen[] = [];
    await walkListens(userId, (l) => listens.push(l), read);
    return listens.sort((a, b) => a.ordinal - b.ordinal);
}

interface FalseStartTrack {
    trackId: string;
    title: string;
    artist: string;
    durationSeconds: number;
    requiredSeconds: number | null;
    /** Listens on this track that can be proven to have been skipped. */
    skipped: number;
    /**
     * Listens of a track under 30 seconds, which can never register a play.
     * Counted apart from `skipped` and never deleted: the length decides this, not
     * whether anyone stayed.
     */
    tooShort: number;
    /** Listens the span alone proves were heard. Nothing inferred. */
    heard: number;
    /** Every listen of this track, whatever the verdict. */
    listens: number;
    /** Rows behind those listens. The excess is pure duplication. */
    rows: number;
    /** The shortest run recorded among the skipped listens. */
    shortestRunSeconds: number | null;
    lastAt: Date;
}

export interface FalseStartAudit {
    /** Rows of library plays (Discover plays are left out). Not the number of times anything was listened to. */
    totalRows: number;
    /** What those rows actually represent. */
    totalListens: number;
    /** Rows that are a second or later record of a listen already counted. */
    duplicateRows: number;
    /**
     * Rows a merge would delete. A collapse keeps each listen's first and last
     * rows, so a five-row listen loses three and a two-row listen loses none.
     */
    collapsibleRows: number;
    /** Listens the span alone proves were real. */
    heard: number;
    /** Listens that fall short even allowing for everything after the last row. */
    skipped: number;
    /**
     * Listens of tracks under 30 seconds, which can never register a play. Never
     * deleted: a short interlude heard in full looks identical to one skipped past.
     */
    tooShort: number;
    /** Listens with no way to tell. Left alone. */
    unclear: number;
    earliest: Date | null;
    tracks: FalseStartTrack[];
    ignored: Array<{ trackId: string; title: string; artist: string; ignoredAt: Date }>;
}

/** Everything the review screen shows, in one read. Touches nothing. */
export async function auditFalseStarts(userId: string, read: AuditRead = {}): Promise<FalseStartAudit> {
    const byTrack = new Map<string, FalseStartTrack>();
    // Where each track's first listen began, which keeps tracks with equal counts in the order they first appeared.
    const firstListen = new Map<string, number>();
    const totals = { rows: 0, listens: 0, duplicates: 0, collapsible: 0, heard: 0, skipped: 0, tooShort: 0, unclear: 0 };
    let earliest: Date | null = null;

    const [, ignoredRows] = await Promise.all([
        walkListens(
            userId,
            (l) => {
                totals.rows += l.rows;
                totals.listens += 1;
                totals.duplicates += l.rows - 1;
                totals.collapsible += collapseCandidates([l]).length;
                if (l.verdict === "heard") totals.heard += 1;
                if (l.verdict === "skipped") totals.skipped += 1;
                if (l.verdict === "never-counts") totals.tooShort += 1;
                if (l.verdict === "unclear") totals.unclear += 1;
                if (earliest === null || l.startedAt < earliest) earliest = l.startedAt;

                let row = byTrack.get(l.trackId);
                if (!row) {
                    row = {
                        trackId: l.trackId,
                        title: l.title,
                        artist: l.artist,
                        durationSeconds: l.durationSeconds,
                        requiredSeconds: l.requiredSeconds,
                        skipped: 0,
                        tooShort: 0,
                        heard: 0,
                        listens: 0,
                        rows: 0,
                        shortestRunSeconds: null,
                        lastAt: l.startedAt,
                    };
                    byTrack.set(l.trackId, row);
                    firstListen.set(l.trackId, l.ordinal);
                } else if (l.ordinal < firstListen.get(l.trackId)!) {
                    // Listens arrive as they complete, not as they began: the track is described by its first.
                    firstListen.set(l.trackId, l.ordinal);
                    row.title = l.title;
                    row.artist = l.artist;
                    row.durationSeconds = l.durationSeconds;
                    row.requiredSeconds = l.requiredSeconds;
                }
                row.listens += 1;
                row.rows += l.rows;
                if (l.startedAt > row.lastAt) row.lastAt = l.startedAt;
                if (l.verdict === "heard") row.heard += 1;
                if (l.verdict === "never-counts") row.tooShort += 1;
                if (l.verdict === "skipped") {
                    row.skipped += 1;
                    const ran = l.spanSeconds + (l.gapAfterSeconds ?? 0);
                    if (row.shortestRunSeconds === null || ran < row.shortestRunSeconds) {
                        row.shortestRunSeconds = ran;
                    }
                }
            },
            read,
        ),
        prisma.playAuditIgnore.findMany({
            // Library songs only: the audit never reports a Discover song, so it has none to un-ignore.
            where: { userId, track: { album: { location: "LIBRARY" } } },
            orderBy: { ignoredAt: "desc" },
            select: {
                trackId: true,
                ignoredAt: true,
                track: {
                    select: {
                        title: true,
                        displayTitle: true,
                        album: { select: { artist: { select: { name: true, displayName: true } } } },
                    },
                },
            },
        }),
    ]);

    const ignoredIds = new Set(ignoredRows.map((r) => r.trackId));
    const tracks = [...byTrack.values()]
        .filter((t) => t.skipped > 0 && !ignoredIds.has(t.trackId))
        .sort((a, b) => b.skipped - a.skipped || firstListen.get(a.trackId)! - firstListen.get(b.trackId)!);

    return {
        totalRows: totals.rows,
        totalListens: totals.listens,
        duplicateRows: totals.duplicates,
        collapsibleRows: totals.collapsible,
        heard: totals.heard,
        skipped: totals.skipped,
        tooShort: totals.tooShort,
        unclear: totals.unclear,
        earliest,
        tracks,
        ignored: ignoredRows.map((r) => ({
            trackId: r.trackId,
            title: r.track.displayTitle ?? r.track.title,
            artist: r.track.album.artist.displayName ?? r.track.album.artist.name,
            ignoredAt: r.ignoredAt,
        })),
    };
}

/**
 * Reads the history and deletes what `pick` chooses in one transaction holding the person's play-history lock, so a play
 * recorded meanwhile (a late sync, say) waits for the delete instead of landing between it and the read it would
 * have changed. `pick` walks the history through the transaction it is given and returns the play ids to delete, and nothing else is ever deleted.
 */
async function repair(
    userId: string,
    pick: (tx: Prisma.TransactionClient) => Promise<{ ids: string[]; tracks: number }>,
): Promise<{ removed: number; tracks: number }> {
    return prisma.$transaction(async (tx) => {
        await lockPlayHistory(tx, userId, { exclusive: true });
        const { ids, tracks } = await pick(tx);
        return { removed: await deletePlayIdsInChunks(tx, userId, ids), tracks };
    }, REPAIR_TRANSACTION);
}

/**
 * Collapse duplicate records of one listen. Nothing is judged, so it is safe
 * over the whole history and takes no track list.
 */
export async function collapseDuplicateRows(userId: string, read: AuditRead = {}): Promise<{ removed: number }> {
    const { removed } = await repair(userId, async (tx) => {
        const ids: string[] = [];
        await walkListens(userId, (l) => ids.push(...collapseCandidates([l])), { ...read, db: tx });
        // A collapse judges no track, so it reports none.
        return { ids, tracks: 0 };
    });
    if (removed > 0) logger.info(`[PlayAudit] ${userId} collapsed ${removed} duplicate rows`);
    return { removed };
}

/**
 * The rows a collapse may delete: everything between a listen's first and last
 * rows. Keeping both preserves the span every verdict is measured from, so no
 * verdict changes. Pure, so it can be tested without a database.
 */
export function collapseCandidates(listens: Listen[]): string[] {
    return listens.flatMap((l) => (l.playIds.length > 2 ? l.playIds.slice(1, -1) : []));
}

/** Delete the given play rows in chunks, keeping each query's id list small. */
async function deletePlayIdsInChunks(tx: Prisma.TransactionClient, userId: string, ids: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < ids.length; i += 5000) {
        const { count } = await tx.play.deleteMany({
            where: { id: { in: ids.slice(i, i + 5000) }, userId },
        });
        removed += count;
    }
    return removed;
}

/**
 * Delete the provable skips on the given tracks. Play ids never come from the
 * client, and verdicts are recomputed against current data so a stale review
 * screen cannot delete a play that no longer looks like a skip. Ignored tracks win.
 */
export async function removeFalseStarts(
    userId: string,
    trackIds: string[],
    read: AuditRead = {},
): Promise<{ removed: number; tracks: number }> {
    if (trackIds.length === 0) return { removed: 0, tracks: 0 };
    const wanted = new Set(trackIds);

    const result = await repair(userId, async (tx) => {
        const ignored = await tx.playAuditIgnore.findMany({ where: { userId }, select: { trackId: true } });
        const ignoredIds = new Set(ignored.map((r) => r.trackId));
        const ids: string[] = [];
        const touched = new Set<string>();
        await walkListens(
            userId,
            (l) => {
                if (wanted.has(l.trackId) && !ignoredIds.has(l.trackId) && l.verdict === "skipped") {
                    ids.push(...l.playIds);
                    touched.add(l.trackId);
                }
            },
            { ...read, db: tx },
        );
        return { ids, tracks: touched.size };
    });
    if (result.removed > 0) {
        logger.info(`[PlayAudit] ${userId} removed ${result.removed} rows across ${result.tracks} track(s)`);
    }
    return result;
}

/** Stop raising these tracks. Deletes nothing; counting is unaffected. */
export async function ignoreTracks(userId: string, trackIds: string[]): Promise<{ ignored: number }> {
    if (trackIds.length === 0) return { ignored: 0 };
    // An id that is no library song (deleted since the audit listed it, made up, or a Discover song) is skipped, not a failure.
    const tracks = await prisma.track.findMany({
        where: { id: { in: trackIds }, album: { location: "LIBRARY" } },
        select: { id: true },
    });
    const { count } = await prisma.playAuditIgnore.createMany({
        data: tracks.map((t) => ({ userId, trackId: t.id })),
        skipDuplicates: true,
    });
    logger.info(`[PlayAudit] ${userId} ignored ${count} track(s)`);
    return { ignored: count };
}

/** Put tracks back in front of the audit. */
export async function unignoreTracks(userId: string, trackIds: string[]): Promise<{ restored: number }> {
    if (trackIds.length === 0) return { restored: 0 };
    const { count } = await prisma.playAuditIgnore.deleteMany({
        where: { userId, trackId: { in: trackIds } },
    });
    return { restored: count };
}
