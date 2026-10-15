/**
 * What the live reporter sends as the engine and the shown track change: it
 * waits for the engine to reach the shown track, says nothing until something
 * plays, holds back the pause the engine makes at every track end, and goes
 * quiet for good after a 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const reportLive = vi.fn();
vi.mock("@/lib/api", () => ({ api: { reportLive: (...a: unknown[]) => reportLive(...a) } }));

import { useLiveReporting, type LiveQueueEntry } from "../useLiveReporting";
import type { EngineStatus } from "@/lib/audio-engine-policy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEngine {
    snap: { status: EngineStatus; src: string | null } = { status: "idle", src: null };
    time = 0;
    private subs = new Set<(s: { status: EngineStatus; src: string | null }) => void>();
    private seekHandlers = new Set<(d: unknown) => void>();
    subscribe(fn: (s: { status: EngineStatus; src: string | null }) => void) {
        this.subs.add(fn);
        fn(this.snap);
        return () => this.subs.delete(fn);
    }
    getSnapshot() { return this.snap; }
    getCurrentTime() { return this.time; }
    on(_e: string, h: (d: unknown) => void) { this.seekHandlers.add(h); }
    off(_e: string, h: (d: unknown) => void) { this.seekHandlers.delete(h); }
    set(status: EngineStatus, trackId?: string | null) {
        this.snap = { status, src: trackId === undefined ? this.snap.src : trackId && `/api/library/tracks/${trackId}/stream` };
        this.subs.forEach((fn) => fn(this.snap));
    }
    seek(time: number) {
        this.time = time;
        this.seekHandlers.forEach((h) => h({ time }));
    }
}

function Probe(props: { engine: FakeEngine; track: { id: string; duration: number } | null; queue: LiveQueueEntry[]; enabled: boolean }) {
    useLiveReporting(props.engine, props.track, props.queue, props.enabled);
    return null;
}

let root: Root;
let engine: FakeEngine;
const A = { id: "ca", duration: 200 };
const B = { id: "cb", duration: 100 };

function render(track: typeof A | null, queue: LiveQueueEntry[] = [], enabled = true) {
    act(() => root.render(<Probe engine={engine} track={track} queue={queue} enabled={enabled} />));
}

const sent = () => reportLive.mock.calls.map(([r]) => `${r.status} ${r.trackId} ${r.position}`);

beforeEach(() => {
    vi.useFakeTimers();
    reportLive.mockReset().mockResolvedValue({ ok: true });
    engine = new FakeEngine();
    const div = document.createElement("div");
    document.body.appendChild(div);
    root = createRoot(div);
});

afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
});

const settle = () => act(() => vi.advanceTimersByTime(400));

describe("useLiveReporting", () => {
    it("sends nothing at all where live reporting is off (any user but the instance's public one)", () => {
        render(A, [], false);
        act(() => engine.set("playing", "ca"));
        act(() => engine.seek(30));
        act(() => engine.set("paused"));
        settle();
        expect(reportLive).not.toHaveBeenCalled();
    });

    it("reports what is already playing the moment reporting turns on", () => {
        render(A, [], false);
        act(() => engine.set("playing", "ca"));
        expect(reportLive).not.toHaveBeenCalled();

        render(A, [], true);
        expect(sent()).toEqual(["playing ca 0"]);
    });

    it("says nothing for a restored track that is only paused", () => {
        engine.set("paused", "ca");
        render(A);
        expect(reportLive).not.toHaveBeenCalled();
    });

    it("reports play, pause, a seek and resume, with positions in milliseconds", () => {
        render(A, [{ trackId: "cb", duration: 100_000 }]);
        engine.time = 1.5;
        act(() => engine.set("playing", "ca"));
        act(() => engine.set("paused"));
        settle();
        act(() => engine.seek(60));
        act(() => engine.set("playing"));
        expect(sent()).toEqual(["playing ca 1500", "paused ca 1500", "paused ca 60000", "playing ca 60000"]);
        expect(reportLive.mock.calls[0][0]).toMatchObject({ duration: 200_000, queue: [{ trackId: "cb", duration: 100_000 }] });
    });

    it("ignores buffering in the middle of playback", () => {
        render(A);
        act(() => engine.set("playing", "ca"));
        act(() => engine.set("buffering"));
        act(() => engine.set("playing"));
        expect(sent()).toEqual(["playing ca 0"]);
    });

    it("waits for the engine to reach the new track before reporting it", () => {
        render(A);
        act(() => engine.set("playing", "ca"));
        engine.time = 95;
        render(B);
        expect(sent()).toEqual(["playing ca 0"]);
        engine.time = 0;
        act(() => engine.set("loading", "cb"));
        act(() => engine.set("playing"));
        expect(sent()).toEqual(["playing ca 0", "playing cb 0"]);
    });

    it("reports a new up-next list on the same track", () => {
        render(A, []);
        act(() => engine.set("playing", "ca"));
        render(A, [{ trackId: "cb", duration: 100_000 }]);
        expect(reportLive).toHaveBeenCalledTimes(2);
    });

    it("stops when playback moves off tracks", () => {
        render(A);
        act(() => engine.set("playing", "ca"));
        render(null);
        expect(sent()).toEqual(["playing ca 0", "stopped ca 0"]);
    });

    it("says nothing for the pause between one track ending and the next starting", () => {
        render(A);
        act(() => engine.set("playing", "ca"));
        engine.time = 200;
        act(() => engine.set("paused"));
        render(B);
        engine.time = 0;
        act(() => engine.set("loading", "cb"));
        act(() => engine.set("playing"));
        settle();
        expect(sent()).toEqual(["playing ca 0", "playing cb 0"]);
    });

    it("reports a repeat-one loop as a seek back to the start, with no pause", () => {
        render(A, [{ trackId: "ca", duration: 200_000 }]);
        act(() => engine.set("playing", "ca"));
        engine.time = 200;
        act(() => engine.set("paused"));
        act(() => engine.seek(0));
        act(() => engine.set("playing"));
        settle();
        expect(sent()).toEqual(["playing ca 0", "playing ca 0"]);
        expect(reportLive).toHaveBeenCalledTimes(2);
    });

    it("reports stopped when the queue runs out at a track's end", () => {
        render(A);
        act(() => engine.set("playing", "ca"));
        engine.time = 200;
        act(() => engine.set("paused"));
        settle();
        expect(sent()).toEqual(["playing ca 0", "stopped ca 200000"]);
    });

    it("goes quiet after a 404", async () => {
        reportLive.mockRejectedValueOnce({ status: 404 });
        render(A);
        await act(async () => engine.set("playing", "ca"));
        act(() => engine.set("paused"));
        settle();
        expect(reportLive).toHaveBeenCalledTimes(1);
    });
});
