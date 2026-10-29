/**
 * Finds and removes play records that provably were skips. Two plays by one
 * person bound the first from above: a short gap proves a skip, a long gap
 * proves nothing. Only provable skips are offered for deletion, and the last
 * play of a session, having no bound, is always kept.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { requiredListenSeconds } from "./playRecording";
import { MIN_LISTEN_WINDOW_SECONDS } from "./stats/listens";

/*
 * Rows are grouped into listens first: rows for one track closer together than
 * the track's length are one listen. A listen's span (first row to last) is a
 * floor on what was heard, so it is "heard" if the span clears the threshold,
 * "skipped" only if span plus the gap to the next play still falls short.
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
}

function judge(span: number, gapAfter: number | null, required: number | null): ListenVerdict {
    if (required === null) return "never-counts";
    if (span >= required) return "heard";
    if (gapAfter === null) return "unclear";
    return span + gapAfter < required ? "skipped" : "unclear";
}

/**
 * Every listen in a user's history, with what can and cannot be shown about it.
 *
 * Reads the whole history. That is why nothing calls it on a page load.
 */
export async function listensOf(userId: string): Promise<Listen[]> {
    const plays = await prisma.play.findMany({
        where: { userId },
        // The id is a tiebreaker, not decoration -- see the note in
        // analysePlayHistory. Same reasoning, same consequence if omitted.
        orderBy: [{ playedAt: "asc" }, { id: "asc" }],
        select: {
            id: true,
            trackId: true,
            playedAt: true,
            heard: true,
            track: {
                select: {
                    title: true,
                    displayTitle: true,
                    duration: true,
                    album: { select: { artist: { select: { name: true, displayName: true } } } },
                },
            },
        },
    });

    // The gap to the next play of anything, in the order they happened. This is
    // the only thing that can bound a listen from above, so it is measured on
    // the global sequence rather than per track.
    const gapAfterRow = plays.map((p, i) => {
        const next = plays[i + 1];
        return next ? (next.playedAt.getTime() - p.playedAt.getTime()) / 1000 : null;
    });

    const open = new Map<string, Listen>();
    // Where the open listen on each track began, not its latest row: measuring from
    // the latest row would fold a genuine replay into the previous listen and queue
    // its row for deletion. Same rule as `stats/listens.ts`.
    const listenStartedAt = new Map<string, number>();
    const out: Listen[] = [];
    // A listen with a row the listen rule recorded was heard, whatever its gaps say.
    const recordedHeard = new Set<Listen>();

    plays.forEach((p, i) => {
        const window = Math.max(MIN_LISTEN_WINDOW_SECONDS, p.track.duration);
        const startedAt = listenStartedAt.get(p.trackId);
        // `<`: a row exactly one duration after the listen began starts a new listen,
        // matching the recording path and `stats/listens.ts`.
        const sameListen =
            startedAt !== undefined && (p.playedAt.getTime() - startedAt) / 1000 < window;

        if (sameListen) {
            const listen = open.get(p.trackId)!;
            listen.rows += 1;
            listen.playIds.push(p.id);
            listen.spanSeconds = (p.playedAt.getTime() - listen.startedAt.getTime()) / 1000;
            listen.gapAfterSeconds = gapAfterRow[i];
            if (p.heard) recordedHeard.add(listen);
        } else {
            const listen: Listen = {
                trackId: p.trackId,
                title: p.track.displayTitle ?? p.track.title,
                artist: p.track.album.artist.displayName ?? p.track.album.artist.name,
                durationSeconds: p.track.duration,
                requiredSeconds: requiredListenSeconds(p.track.duration),
                rows: 1,
                playIds: [p.id],
                startedAt: p.playedAt,
                spanSeconds: 0,
                gapAfterSeconds: gapAfterRow[i],
                verdict: "unclear",
            };
            open.set(p.trackId, listen);
            out.push(listen);
            if (p.heard) recordedHeard.add(listen);
            // Only a row that opens a listen becomes the anchor.
            listenStartedAt.set(p.trackId, p.playedAt.getTime());
        }
    });

    for (const listen of out) {
        listen.verdict = recordedHeard.has(listen)
            ? "heard"
            : judge(listen.spanSeconds, listen.gapAfterSeconds, listen.requiredSeconds);
    }
    return out;
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
    /** Rows in the table. Not the number of times anything was listened to. */
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
export async function auditFalseStarts(userId: string): Promise<FalseStartAudit> {
    const [listens, ignoredRows] = await Promise.all([
        listensOf(userId),
        prisma.playAuditIgnore.findMany({
            where: { userId },
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
    const byTrack = new Map<string, FalseStartTrack>();

    for (const l of listens) {
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
    }

    const tracks = [...byTrack.values()]
        .filter((t) => t.skipped > 0 && !ignoredIds.has(t.trackId))
        .sort((a, b) => b.skipped - a.skipped);

    return {
        totalRows: listens.reduce((n, l) => n + l.rows, 0),
        totalListens: listens.length,
        duplicateRows: listens.reduce((n, l) => n + (l.rows - 1), 0),
        collapsibleRows: collapseCandidates(listens).length,
        heard: listens.filter((l) => l.verdict === "heard").length,
        skipped: listens.filter((l) => l.verdict === "skipped").length,
        tooShort: listens.filter((l) => l.verdict === "never-counts").length,
        unclear: listens.filter((l) => l.verdict === "unclear").length,
        earliest: listens[0]?.startedAt ?? null,
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
 * Collapse duplicate records of one listen. Nothing is judged, so it is safe
 * over the whole history and takes no track list.
 */
export async function collapseDuplicateRows(userId: string): Promise<{ removed: number }> {
    const listens = await listensOf(userId);
    const doomed = collapseCandidates(listens);
    if (doomed.length === 0) return { removed: 0 };

    const removed = await deletePlayIdsInChunks(userId, doomed);
    logger.info(`[PlayAudit] ${userId} collapsed ${removed} duplicate rows`);
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
async function deletePlayIdsInChunks(userId: string, ids: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < ids.length; i += 5000) {
        const { count } = await prisma.play.deleteMany({
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
): Promise<{ removed: number; tracks: number }> {
    if (trackIds.length === 0) return { removed: 0, tracks: 0 };
    const wanted = new Set(trackIds);

    const [listens, ignored] = await Promise.all([
        listensOf(userId),
        prisma.playAuditIgnore.findMany({ where: { userId }, select: { trackId: true } }),
    ]);
    const ignoredIds = new Set(ignored.map((r) => r.trackId));

    const doomedListens = listens.filter(
        (l) =>
            wanted.has(l.trackId) &&
            !ignoredIds.has(l.trackId) &&
            l.verdict === "skipped",
    );
    const doomed = doomedListens.flatMap((l) => l.playIds);
    if (doomed.length === 0) return { removed: 0, tracks: 0 };

    const removed = await deletePlayIdsInChunks(userId, doomed);
    const touched = new Set(doomedListens.map((l) => l.trackId));
    logger.info(`[PlayAudit] ${userId} removed ${removed} rows across ${touched.size} track(s)`);
    return { removed, tracks: touched.size };
}

/** Stop raising these tracks. Deletes nothing; counting is unaffected. */
export async function ignoreTracks(userId: string, trackIds: string[]): Promise<{ ignored: number }> {
    if (trackIds.length === 0) return { ignored: 0 };
    // An id that is no track (deleted since the audit listed it, or made up) is skipped, not a failure.
    const tracks = await prisma.track.findMany({ where: { id: { in: trackIds } }, select: { id: true } });
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
