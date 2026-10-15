/**
 * What the public user (KIMA_PUBLIC_VIBE_USER) is playing right now, as a state plus
 * a stream of change events. A track that runs out with nothing after it, or a pause
 * nobody returns to, ends as `stopped`; while sharing is off, reports are dropped
 * and the state reads `hidden`.
 */
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config } from "../config";

export type LiveStatus = "playing" | "paused" | "stopped";

export interface LiveQueueEntry {
    trackId: string;
    /** Milliseconds. */
    duration: number;
}

export interface LiveReport {
    status: LiveStatus;
    trackId: string;
    /** Milliseconds into the track. */
    position: number;
    /** Milliseconds. */
    duration: number;
    /** The tracks that will play next, in play order; empty when the player cannot say. */
    queue: LiveQueueEntry[];
}

export interface LiveState {
    status: LiveStatus | "hidden";
    trackId: string | null;
    duration: number;
    position: number;
    startedAt: number | null;
    queue: LiveQueueEntry[];
    at: number;
}

export type LiveEvent =
    | { type: "started"; at: number; trackId: string; startedAt: number; duration: number; queue: LiveQueueEntry[] }
    | { type: "paused" | "resumed" | "seeked"; at: number; trackId: string; position: number }
    | { type: "skipped"; at: number; trackId: string }
    | { type: "stopped"; at: number; trackId: string; position: number }
    | { type: "queue_changed"; at: number; queue: LiveQueueEntry[] }
    | { type: "hidden"; at: number }
    | ({ type: "state" } & LiveState);

/** Heard after a track's end, before the trip counts as over. */
const END_GRACE_MS = 30_000;
/** A pause longer than this counts as the end of listening. */
const PAUSE_LIMIT_MS = 30 * 60_000;
/** A reported position this far from the expected one is a seek. */
const SEEK_TOLERANCE_MS = 3_000;
/** A new track this long before the old one's end means the old one was skipped. */
const SKIP_TOLERANCE_MS = 5_000;
const MAX_QUEUE = 25;

let state: LiveState = { status: "stopped", trackId: null, duration: 0, position: 0, startedAt: null, queue: [], at: Date.now() };
let hidden = false;
let staleTimer: NodeJS.Timeout | null = null;
const listeners = new Set<(event: LiveEvent) => void>();

let publicUser: { id: string | null; checkedAt: number } | null = null;
const USER_RECHECK_MS = 60_000;

/** The id of the user whose listening is public, or null when there is none. */
export async function publicUserId(): Promise<string | null> {
    const username = config.publicVibe?.username;
    if (!username) return null;
    if (publicUser && (publicUser.id || Date.now() - publicUser.checkedAt < USER_RECHECK_MS)) {
        return publicUser.id;
    }
    const user = await prisma.user.findUnique({
        where: { username },
        select: { id: true, settings: { select: { shareLiveListening: true } } },
    });
    if (!user) logger.warn(`[PUBLIC-VIBE] KIMA_PUBLIC_VIBE_USER "${username}" is not a user`);
    else hidden = user.settings?.shareLiveListening === false;
    publicUser = { id: user?.id ?? null, checkedAt: Date.now() };
    return publicUser.id;
}

/** Whether this user's listening is the public one: the public vibe is on and they are its user. */
export async function isPublicListener(userId: string): Promise<boolean> {
    return Boolean(config.publicVibe) && userId === (await publicUserId());
}

export function subscribeLive(listener: (event: LiveEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function liveListenerCount(): number {
    return listeners.size;
}

function emit(event: LiveEvent): void {
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch (error) {
            logger.warn("[PUBLIC-VIBE] live listener failed:", (error as Error).message);
            listeners.delete(listener);
        }
    }
}

function projectedPosition(s: LiveState, now: number): number {
    if (s.status !== "playing") return s.position;
    return Math.min(s.duration || Infinity, s.position + (now - s.at));
}

const STOPPED: Omit<LiveState, "at"> = { status: "stopped", trackId: null, duration: 0, position: 0, startedAt: null, queue: [] };

/** The current state, with a playing track's position advanced to now. */
export function getLiveState(): LiveState {
    const now = Date.now();
    if (hidden) return { ...STOPPED, status: "hidden", at: now };
    return { ...state, position: projectedPosition(state, now), at: now };
}

/** Turn sharing off (forgetting what was playing) or back on. */
export function setLiveHidden(value: boolean): void {
    if (value === hidden) return;
    hidden = value;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    state = { ...STOPPED, at: Date.now() };
    emit(hidden ? { type: "hidden", at: Date.now() } : { type: "state", ...getLiveState() });
}

function sameQueue(a: LiveQueueEntry[], b: LiveQueueEntry[]): boolean {
    return a.length === b.length && a.every((e, i) => e.trackId === b[i].trackId);
}

function armStaleTimer(): void {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    if (state.status === "stopped" || !state.trackId) return;
    const wait = state.status === "playing"
        ? Math.max(0, state.duration - state.position) + END_GRACE_MS
        : PAUSE_LIMIT_MS;
    staleTimer = setTimeout(() => {
        staleTimer = null;
        const now = Date.now();
        const position = projectedPosition(state, now);
        state = { ...state, status: "stopped", position, at: now };
        emit({ type: "stopped", at: now, trackId: state.trackId!, position });
    }, wait);
    staleTimer.unref?.();
}

/** Apply one player report and emit the events it amounts to. */
export function reportLive(report: LiveReport): void {
    if (hidden) return;
    const now = Date.now();
    const prev = state;
    const queue = report.queue.slice(0, MAX_QUEUE);
    const prevPosition = projectedPosition(prev, now);
    const newTrack = report.trackId !== prev.trackId;
    const resumedAfterStop = prev.status === "stopped" && report.status !== "stopped";

    state = {
        status: report.status,
        trackId: report.trackId,
        duration: report.duration,
        position: report.position,
        startedAt: newTrack || resumedAfterStop ? now - report.position : prev.startedAt,
        queue,
        at: now,
    };

    if (newTrack || resumedAfterStop) {
        if (newTrack && prev.status !== "stopped" && prev.trackId && prev.duration - prevPosition > SKIP_TOLERANCE_MS) {
            emit({ type: "skipped", at: now, trackId: report.trackId });
        }
        if (report.status === "stopped") {
            emit({ type: "stopped", at: now, trackId: report.trackId, position: report.position });
        } else {
            emit({ type: "started", at: now, trackId: report.trackId, startedAt: state.startedAt!, duration: report.duration, queue });
            if (report.status === "paused") {
                emit({ type: "paused", at: now, trackId: report.trackId, position: report.position });
            }
        }
    } else {
        if (report.status !== prev.status) {
            if (report.status === "paused") emit({ type: "paused", at: now, trackId: report.trackId, position: report.position });
            else if (report.status === "playing") emit({ type: "resumed", at: now, trackId: report.trackId, position: report.position });
            else emit({ type: "stopped", at: now, trackId: report.trackId, position: report.position });
        } else if (report.status !== "stopped" && Math.abs(report.position - prevPosition) > SEEK_TOLERANCE_MS) {
            emit({ type: "seeked", at: now, trackId: report.trackId, position: report.position });
        }
        if (!sameQueue(queue, prev.queue)) {
            emit({ type: "queue_changed", at: now, queue });
        }
    }

    armStaleTimer();
}

/** Reset to nothing playing, for tests. */
export function resetLive(): void {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = null;
    listeners.clear();
    publicUser = null;
    hidden = false;
    state = { ...STOPPED, at: Date.now() };
}
