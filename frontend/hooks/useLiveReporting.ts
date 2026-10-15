"use client";

/**
 * Reports the web player's play, pause, seek, track and up-next changes for the
 * public live trip. It runs only when the server says this user's listening is the
 * public one (`liveReporting` from /system/features); everywhere else it sends nothing.
 * A 404 from the server still silences it for the session.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { EngineStatus } from "@/lib/audio-engine-policy";

export type LiveStatus = "playing" | "paused" | "stopped";

export interface LiveQueueEntry {
    trackId: string;
    /** Milliseconds. */
    duration: number;
}

const UP_NEXT = 10;
/** The engine pauses for a moment at every track end; only a pause that lasts this long is reported. */
const PAUSE_SETTLE_MS = 400;
/** A pause this close to the end is the queue running out, reported as stopped. */
const END_TOLERANCE_S = 1.5;

/** Loading, buffering and recovery are not changes a listener would see, so they map to nothing. */
export function liveStatusFor(status: EngineStatus): LiveStatus | null {
    switch (status) {
        case "playing":
            return "playing";
        case "paused":
        case "blocked":
            return "paused";
        case "idle":
        case "error":
            return "stopped";
        default:
            return null;
    }
}

/** The tracks that will play after the current one, in the order the player will play them. */
export function upNext(
    queue: { id: string; duration: number }[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: number[],
    repeatMode: "off" | "one" | "all",
    limit = UP_NEXT,
): LiveQueueEntry[] {
    const order = isShuffle && shuffleIndices.length === queue.length
        ? shuffleIndices
        : queue.map((_, i) => i);
    const at = order.indexOf(currentIndex);
    if (at < 0) return [];
    const following = repeatMode === "one" ? [currentIndex] : order.slice(at + 1);
    if (repeatMode === "all") following.push(...order.slice(0, at));
    return following.slice(0, limit).map((i) => ({
        trackId: queue[i].id,
        duration: Math.round(queue[i].duration * 1000),
    }));
}

interface LiveSnapshot {
    status: EngineStatus;
    src: string | null;
}

interface LiveController {
    subscribe(fn: (snap: LiveSnapshot) => void): () => void;
    getSnapshot(): LiveSnapshot;
    getCurrentTime(): number;
    on(event: string, handler: (data: unknown) => void): void;
    off(event: string, handler: (data: unknown) => void): void;
}

interface LiveTrack {
    id: string;
    duration: number;
}

interface Sent {
    status: LiveStatus;
    trackId: string;
    duration: number;
    queueKey: string;
}

const queueKeyOf = (queue: LiveQueueEntry[]) => queue.map((e) => e.trackId).join(",");

export function useLiveReporting(
    controller: LiveController | null,
    track: LiveTrack | null,
    queue: LiveQueueEntry[],
    enabled: boolean,
) {
    const enabledRef = useRef(enabled);
    const controllerRef = useRef(controller);
    const trackRef = useRef(track);
    const queueRef = useRef(queue);
    const disabledRef = useRef(false);
    const sentRef = useRef<Sent | null>(null);
    const seekPendingRef = useRef(false);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useLayoutEffect(() => {
        enabledRef.current = enabled;
        controllerRef.current = controller;
        trackRef.current = track;
        queueRef.current = queue;
    });

    const evaluateRef = useRef((seeked: boolean, settled = false) => {
        const ctrl = controllerRef.current;
        if (seeked) seekPendingRef.current = true;
        if (settleTimerRef.current && !settled) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }
        if (!enabledRef.current || disabledRef.current || !ctrl) return;
        const snap = ctrl.getSnapshot();
        const current = trackRef.current;
        const sent = sentRef.current;
        const live = sent !== null && sent.status !== "stopped";
        let status = liveStatusFor(snap.status);
        // The engine may still hold the previous track's source; wait until it
        // is on the one the player shows, unless what is playing is not a track.
        const onTrack = current !== null && !!snap.src?.includes(`/tracks/${current.id}/`);
        if (!current && live) status = "stopped";
        if (!status) return;
        if (status === "paused" && live && sent.status === "playing" && !settled) {
            settleTimerRef.current = setTimeout(() => {
                settleTimerRef.current = null;
                evaluateRef.current(false, true);
            }, PAUSE_SETTLE_MS);
            return;
        }
        if (status === "paused" && live && current && onTrack && ctrl.getCurrentTime() >= current.duration - END_TOLERANCE_S) {
            status = "stopped";
        }

        let report: Sent;
        if (status === "stopped") {
            if (!live) return;
            report = { ...sent, status };
        } else {
            if (!current || !onTrack) return;
            // Nothing is public until something plays: opening Kima on a
            // restored, paused track is not listening.
            if (status === "paused" && !live) return;
            report = { status, trackId: current.id, duration: current.duration, queueKey: queueKeyOf(queueRef.current) };
            if (!seekPendingRef.current && sent && sent.status === report.status && sent.trackId === report.trackId && sent.queueKey === report.queueKey) return;
        }

        sentRef.current = report;
        seekPendingRef.current = false;
        api.reportLive({
            status: report.status,
            trackId: report.trackId,
            position: report.status === "stopped" && !onTrack ? 0 : Math.max(0, Math.round(ctrl.getCurrentTime() * 1000)),
            duration: Math.round(report.duration * 1000),
            queue: queueRef.current,
        }).catch((error: { status?: number }) => {
            if (error?.status === 404) disabledRef.current = true;
        });
    });

    useEffect(() => {
        if (!controller) return;
        const unsubscribe = controller.subscribe(() => evaluateRef.current(false));
        const onSeeked = () => evaluateRef.current(true);
        controller.on("seeked", onSeeked);
        return () => {
            unsubscribe();
            controller.off("seeked", onSeeked);
            if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        };
    }, [controller]);

    const queueKey = queueKeyOf(queue);
    useEffect(() => {
        evaluateRef.current(false);
    }, [controller, track?.id, queueKey, enabled]);
}
