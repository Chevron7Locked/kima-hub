"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import type { LibraryMatches } from "./librarySearch";
import { useVibeSearch, VibeSearchResults } from "./useVibeSearch";
import { NowPlayingTab } from "./tabs/NowPlayingTab";
import { QueueTab } from "./tabs/QueueTab";
import { LyricsView } from "@/components/lyrics/LyricsView";
import { ActivityOptions, ActivityPane, useActivityCounts, type ActivityView } from "@/components/activity/ActivityBody";
import { PanelOptions, panelTabId } from "@/components/layout/panelChrome";
import { usePlayerControls } from "@/hooks/usePlayerControls";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { CachedImage } from "@/components/ui/CachedImage";
import { Waypoints, Sparkles, AudioWaveform, Play, Pause, Search, X, Music, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

type SnapPoint = "peek" | "half" | "full";
type SheetTab = "now-playing" | "queue" | "lyrics" | "activity";

/** The grab strip. A finger-sized target, and the sheet's own handle. */
const HANDLE = 44;
/** The search row (an h-11 field plus its 8px foot), which stays reachable while the sheet is closed. */
const SEARCH_ROW = 52;
/** The now-playing row (an h-11 row plus its 8px foot), shown above the search while something plays. */
const PLAYER_ROW = 52;
/** How the sheet settles on a stop. */
const SETTLE = "height 340ms cubic-bezier(0.32, 0.72, 0, 1)";

function SheetAction({ icon: Icon, label, primary = false, ...props }: { icon: LucideIcon; label: string; primary?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            className={cn(
                "flex-1 flex flex-col items-center gap-1 min-h-[52px] py-2 px-1 rounded-lg border text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2",
                primary
                    ? "bg-brand/15 border-brand/40 focus-visible:ring-brand/60"
                    : "bg-white/[0.06] hover:bg-white/[0.12] border-white/10 focus-visible:ring-white/40",
            )}
            {...props}
        >
            <Icon className={cn("w-4 h-4 shrink-0", primary && "fill-current")} />
            <span className="text-micro font-medium leading-tight text-center">{label}</span>
        </button>
    );
}

interface VibePanelSheetProps {
    selectedTrackId?: string | null;
    selectedTrackTitle?: string | null;
    selectedTrackArtist?: string | null;
    onTrackOperation?: (op: "vibe" | "similar") => void;
    onStartSongPath?: () => void;
    songPathActive?: boolean;
    onPlay?: () => void;
    selectedArtistId?: string | null;
    /** Debounced by the sheet; the page owns what a query means. */
    onSearch: (query: string) => void;
    /** Matches for the current query, or null when not searching. */
    results: LibraryMatches | null;
    onPickResult: (trackId: string) => void;
    /** Bumped by the page whenever everything is cleared, so the field empties too. */
    clearSignal: number;
    /** First-visit help, shown at the top of the open sheet. */
    intro?: React.ReactNode;
}

/**
 * The phone's one bottom surface: now-playing, search, actions and tabs, with
 * no floating mini player under it. Three stops from the page content: peek,
 * half, and full, which fills the page.
 */
export function VibePanelSheet({
    selectedTrackId,
    selectedTrackTitle,
    selectedTrackArtist,
    onTrackOperation,
    onStartSongPath,
    songPathActive = false,
    onPlay,
    selectedArtistId,
    onSearch,
    results,
    onPickResult,
    clearSignal,
    intro,
}: VibePanelSheetProps) {
    const { playbackType, isPlaying, pause, resumeWithGesture, openOverlay } = usePlayerControls();
    const { title: playingTitle, subtitle: playingSubtitle, coverUrl } = useMediaInfo(100);
    const hasPlayback = !!playbackType;

    const hostRef = useRef<HTMLDivElement>(null);
    const sheetRef = useRef<HTMLDivElement>(null);
    const [hostHeight, setHostHeight] = useState(0);
    const [contentFloor, setContentFloor] = useState(0);
    const [snap, setSnap] = useState<SnapPoint>("peek");
    const [activeTab, setActiveTab] = useState<SheetTab>("now-playing");
    const [activity, setActivity] = useState<ActivityView>("all");
    const counts = useActivityCounts();

    const pickResult = (trackId: string) => {
        onPickResult(trackId);
        setQuery("");
    };
    const { query, setQuery, activeIndex, setActive, searching, onResultKey } = useVibeSearch({
        onSearch,
        results,
        onPick: pickResult,
        clearSignal,
    });

    // The host is the page content; its height is the sheet's full extent, so
    // the stops follow the viewport without ever measuring the sheet's content.
    useEffect(() => {
        const el = hostRef.current;
        if (!el) return;
        const update = () => setHostHeight(el.clientHeight);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const peekHeight = HANDLE + (hasPlayback ? PLAYER_ROW : 0) + SEARCH_ROW;
    const hasActions = !!(selectedTrackId && onTrackOperation && onStartSongPath);
    const stops = useMemo(() => {
        // Full is the whole page: the queue and lyrics need the height, and a
        // three-quarters stop left the tab bar under the sheet's bottom edge.
        const full = hostHeight;
        // Half has to clear the selected track's actions, the activity row and
        // the tab bar, or the tabs land under the content's bottom edge. The
        // sheet is clipped at peek, so its scrollHeight is the real content
        // height — measured there, before the selection opens it to half.
        const half = Math.max(
            peekHeight,
            Math.round(hostHeight * 0.56),
            Math.min(full, contentFloor)
        );
        return { peek: peekHeight, half, full } as Record<SnapPoint, number>;
    }, [hostHeight, peekHeight, contentFloor]);

    // Below full the sheet is clipped, so its scrollHeight is the content's
    // true height. Half is measured too: typing opens the sheet before a
    // selection adds the actions, so peek alone would miss the taller content.
    useLayoutEffect(() => {
        const el = sheetRef.current;
        if (!el || snap === "full") return;
        setContentFloor(el.scrollHeight);
    }, [snap, hasPlayback, hasActions, selectedTrackId, activeTab, intro]);

    // The snap belongs to the selection it was chosen for: a new selection opens the sheet, and a cleared one closes
    // it. This runs after commit: a state update issued during render was discarded here.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSnap((current) => {
            if (selectedTrackId && current === "peek") return "half";
            if (!selectedTrackId && current !== "peek") return "peek";
            return current;
        });
    }, [selectedTrackId]);

    const height = stops[snap];

    // The sheet animates between stops only once it has moved: on load its peek height settles (playback state
    // arrives a moment later) without visibly growing.
    const [shownSnap, setShownSnap] = useState(snap);
    const [animate, setAnimate] = useState(false);
    if (shownSnap !== snap) {
        setShownSnap(snap);
        setAnimate(true);
    }

    const nearest = useCallback((value: number): SnapPoint => {
        const entries = Object.entries(stops) as [SnapPoint, number][];
        entries.sort((a, b) => Math.abs(a[1] - value) - Math.abs(b[1] - value));
        return entries[0][0];
    }, [stops]);

    // Escape steps the sheet down before the page's own Escape handling runs.
    // The page's listener is registered at mount and this one is re-registered
    // on every snap change, so bubble order would let the page clear the
    // selection first and consume the key; capture order is fixed.
    useEffect(() => {
        if (snap === "peek") return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            setSnap(snap === "full" ? "half" : "peek");
        };
        document.addEventListener("keydown", onKey, { capture: true });
        return () => document.removeEventListener("keydown", onKey, { capture: true });
    }, [snap, setSnap]);

    const drag = useRef<{ startY: number; startHeight: number; samples: { t: number; h: number }[] } | null>(null);
    const liveHeight = useRef(0);
    const frame = useRef(0);
    const scrimRef = useRef<HTMLDivElement>(null);

    // A drag moves the sheet element directly, once per frame, without re-rendering the sheet; React takes over
    // again at the stop it settles on.
    const onHandleDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const el = sheetRef.current;
        // From where the sheet is now, which is mid-way if it is still settling.
        const start = el ? el.getBoundingClientRect().height : height;
        drag.current = { startY: event.clientY, startHeight: start, samples: [{ t: event.timeStamp, h: start }] };
        liveHeight.current = start;
        if (el) {
            el.style.transition = "none";
            el.style.height = `${start}px`;
        }
        // The blur over the map is recomposited on every frame the sheet moves; it returns at the stop.
        if (scrimRef.current) scrimRef.current.style.backdropFilter = "none";
    }, [height]);

    const onHandleMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        const raw = drag.current.startHeight - (event.clientY - drag.current.startY);
        // Beyond the ends the sheet gives, then stops, so it feels held rather
        // than hitting a wall.
        let next = raw;
        if (raw > stops.full) next = stops.full + (raw - stops.full) * 0.25;
        else if (raw < stops.peek) next = stops.peek - (stops.peek - raw) * 0.25;
        liveHeight.current = next;
        drag.current.samples.push({ t: event.timeStamp, h: next });
        if (drag.current.samples.length > 10) drag.current.samples.shift();
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (sheetRef.current) sheetRef.current.style.height = `${liveHeight.current}px`;
        });
    }, [stops]);

    useEffect(() => () => cancelAnimationFrame(frame.current), []);

    const onHandleUp = useCallback(() => {
        const state = drag.current;
        if (!state) return;
        drag.current = null;

        // A flick continues in the direction it was thrown; a slow release falls
        // to the nearest stop. Without this the sheet lands wherever the finger
        // happened to stop.
        const last = state.samples[state.samples.length - 1];
        const first = state.samples.find((sample) => last.t - sample.t <= 110) ?? state.samples[0];
        const elapsed = Math.max(1, last.t - first.t);
        const velocity = (last.h - first.h) / elapsed; // px per ms, positive opens
        const from = liveHeight.current;
        const order: SnapPoint[] = ["peek", "half", "full"];

        let target: SnapPoint;
        if (Math.abs(velocity) > 0.45) {
            const opening = velocity > 0;
            const candidates = order.filter((point) => (opening ? stops[point] > from + 1 : stops[point] < from - 1));
            target = opening ? candidates[0] ?? "full" : candidates[candidates.length - 1] ?? "peek";
        } else {
            target = nearest(from);
        }

        cancelAnimationFrame(frame.current);
        frame.current = 0;
        // Settle on the stop here: when it is the stop the drag began at, React has nothing new to write.
        const el = sheetRef.current;
        if (el) {
            el.style.transition = SETTLE;
            el.style.height = `${stops[target]}px`;
        }
        if (scrimRef.current) scrimRef.current.style.backdropFilter = "";
        setAnimate(true);
        setSnap(target);
    }, [nearest, setSnap, stops]);

    const handleTabClick = (tab: SheetTab) => {
        setActiveTab(tab);
        if (snap === "peek") setSnap("half");
    };

    return (
        <div ref={hostRef} className="pointer-events-none absolute inset-0 z-(--z-sheet)">
            {snap !== "peek" && (
                <div
                    ref={scrimRef}
                    data-testid="vibe-sheet-scrim"
                    aria-hidden="true"
                    onClick={() => setSnap("peek")}
                    className="pointer-events-auto absolute inset-0 bg-black/40 backdrop-blur-sm"
                />
            )}

            <div
                ref={sheetRef}
                data-testid="vibe-sheet"
                data-snap={snap}
                className="pointer-events-auto absolute inset-x-0 bottom-0 flex flex-col overflow-clip rounded-t-2xl border-t border-white/10 bg-[var(--bg-primary)] shadow-[0_-20px_48px_-16px_rgba(0,0,0,0.85)]"
                style={{
                    height,
                    transition: animate ? SETTLE : "none",
                }}
            >
                <div
                    onPointerDown={onHandleDown}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="vibe panel"
                    className="flex h-11 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
                >
                    <span className="h-1 w-10 rounded-full bg-white/20" />
                </div>

                {hasPlayback && (
                    <div
                        data-testid="vibe-peek-player"
                        role="region"
                        aria-label="now playing"
                        className="flex shrink-0 items-center gap-3 px-3 pb-2"
                        style={{ minHeight: PLAYER_ROW }}
                    >
                        <button
                            type="button"
                            onClick={openOverlay}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                            aria-label="Open the full player"
                        >
                            <span className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md bg-black/40">
                                {coverUrl ? (
                                    <CachedImage src={coverUrl} alt={playingTitle} fill sizes="36px" className="object-cover" />
                                ) : (
                                    <span className="flex h-full w-full items-center justify-center">
                                        <Music className="h-4 w-4 text-[var(--text-secondary)]" />
                                    </span>
                                )}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{playingTitle}</span>
                                <span className="block truncate text-xs text-[var(--text-secondary)]">{playingSubtitle}</span>
                            </span>
                        </button>
                        <button
                            type="button"
                            onClick={() => (isPlaying ? pause() : resumeWithGesture())}
                            aria-label={isPlaying ? "pause" : "play"}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand)] text-black transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                        >
                            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
                        </button>
                    </div>
                )}

                <div className="relative shrink-0 px-3 pb-2">
                    <Search className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" />
                    <input
                        type="text"
                        role="combobox"
                        aria-expanded={searching}
                        aria-controls="vibe-search-results"
                        aria-autocomplete="list"
                        aria-activedescendant={searching && results && results.top.length > 0 ? `vibe-result-${activeIndex}` : undefined}
                        value={query}
                        onChange={(event) => {
                            const next = event.target.value;
                            setQuery(next);
                            // Typing opens the sheet far enough to read the results.
                            if (next.trim().length >= 2) setSnap((current) => (current === "peek" ? "half" : current));
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Escape" && query) {
                                event.preventDefault();
                                setQuery("");
                                return;
                            }
                            onResultKey(event);
                        }}
                        placeholder="find a track or artist"
                        aria-label="Search tracks or artists"
                        className="h-11 w-full rounded-full bg-white/[0.06] pl-10 pr-10 text-[15px] text-white placeholder-white/55 caret-[var(--color-brand)] outline-none focus:bg-white/[0.09]"
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => setQuery("")}
                            aria-label="Clear search"
                            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-white/60 hover:text-white"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>

                {searching && results ? (
                    <VibeSearchResults
                        results={results}
                        query={query}
                        activeIndex={activeIndex}
                        onHover={setActive}
                        onPick={pickResult}
                        inert={snap === "peek"}
                        className="flex-1 overflow-y-auto overscroll-contain border-t border-white/5 py-1"
                    />
                ) : (
                    <div
                        inert={snap === "peek"}
                        className="flex min-h-0 flex-1 flex-col"
                    >
                        {hasActions && onTrackOperation && onStartSongPath && (
                            <div
                                data-testid="vibe-sheet-actions"
                                className="shrink-0 border-b border-white/5 px-3 pb-2"
                            >
                                {(selectedTrackTitle || selectedTrackArtist) && (
                                    <p className="mb-2 mt-0.5 truncate text-xs text-[var(--text-muted)]">
                                        <span className="text-[var(--text-secondary)]">{selectedTrackTitle}</span>
                                        {selectedTrackArtist && (
                                            <> &middot; {selectedArtistId
                                                ? <Link href={`/artist/${selectedArtistId}`} className="underline-offset-2 hover:underline">{selectedTrackArtist}</Link>
                                                : selectedTrackArtist}</>
                                        )}
                                    </p>
                                )}
                                <div className="flex gap-2">
                                    {onPlay && <SheetAction primary icon={Play} label="Play" onClick={onPlay} aria-label="Play this track" />}
                                    <SheetAction
                                        icon={Sparkles}
                                        label="Match Vibe"
                                        onClick={() => onTrackOperation("vibe")}
                                        aria-label="Match Vibe -- build a queue of similar-sounding tracks"
                                    />
                                    <SheetAction
                                        icon={AudioWaveform}
                                        label="Similar"
                                        onClick={() => onTrackOperation("similar")}
                                        aria-label="Similar -- highlight similar tracks on the map"
                                    />
                                    <SheetAction
                                        icon={Waypoints}
                                        label="Song Path"
                                        onClick={onStartSongPath}
                                        aria-label="Song Path -- set this track as the start of a song path, then tap the destination"
                                    />
                                </div>
                                {songPathActive && (
                                    <p className="mt-2 text-center text-micro text-[var(--text-secondary)] animate-pulse">
                                        tap another track to complete the song path
                                    </p>
                                )}
                            </div>
                        )}

                        {!hasActions && intro && (
                            <div className="shrink-0 border-b border-white/5 px-4 pb-3">{intro}</div>
                        )}

                        <PanelOptions<SheetTab>
                            label="vibe panel"
                            controls="vibe-sheet-tab"
                            value={activeTab}
                            onChange={handleTabClick}
                            options={[
                                { key: "now-playing", label: "now playing" },
                                { key: "queue", label: "queue" },
                                { key: "lyrics", label: "lyrics" },
                                { key: "activity", label: "activity", count: counts.unread + counts.downloads, urgent: true },
                            ]}
                        />
                        {activeTab === "activity" && (
                            <ActivityOptions controls="vibe-sheet-activity" value={activity} onChange={setActivity} />
                        )}
                        <div
                            id="vibe-sheet-tab"
                            role="tabpanel"
                            aria-labelledby={panelTabId("vibe-sheet-tab", activeTab)}
                            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
                        >
                            {activeTab === "now-playing" && <NowPlayingTab />}
                            {activeTab === "queue" && <QueueTab />}
                            {activeTab === "lyrics" && <LyricsView variant="panel" />}
                            {activeTab === "activity" && (
                                <div
                                    id="vibe-sheet-activity"
                                    role="tabpanel"
                                    aria-labelledby={panelTabId("vibe-sheet-activity", activity)}
                                >
                                    <ActivityPane view={activity} onOpen={setActivity} />
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
