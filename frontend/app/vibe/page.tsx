"use client";

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { LocateFixed, Tag, X, type LucideIcon } from "lucide-react";
import { useVibeMap } from "@/features/vibe/useVibeMap";
import { VibeToolbar } from "@/features/vibe/VibeToolbar";
import { VibeSongPath } from "@/features/vibe/VibeSongPath";
import { VibeAlchemy } from "@/features/vibe/VibeAlchemy";
import { VibePanelSheet } from "@/features/vibe/VibePanelSheet";
import { TrackPanel } from "@/features/vibe/TrackPanel";
import { TrackMenu } from "@/features/vibe/TrackMenu";
import { MoodLegend } from "@/features/vibe/MoodLegend";
import { buildLibraryIndex, searchLibrary } from "@/features/vibe/librarySearch";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import type { Track, VibeOperation } from "@/lib/audio-state-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

const VibeMapScene = dynamic(
    () => import("@/features/vibe/map/VibeMapScene").then((m) => ({ default: m.VibeMapScene })),
    { ssr: false, loading: () => <CenteredNote title="Charting your library" spinner /> },
);

// Width the desktop track panel takes from the right edge (20rem + its 1rem inset + a gap).
const PANEL_CLEARANCE = 352;

function CenteredNote({ title, detail, spinner, action }: { title: string; detail?: string; spinner?: boolean; action?: React.ReactNode }) {
    return (
        <div className="vibe-sky flex h-full w-full items-center justify-center">
            <div className="max-w-xs px-6 text-center">
                {spinner && <GradientSpinner size="sm" className="mx-auto mb-3 block" />}
                <p className="text-sm text-[var(--text-secondary)]">{title}</p>
                {detail && <p className="mt-1 text-xs text-[var(--text-muted)]">{detail}</p>}
                {action}
            </div>
        </div>
    );
}

// A WebGL failure must not take the rest of the app down with it.
class SceneErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
    state = { error: null as string | null };
    static getDerivedStateFromError(error: Error) {
        return { error: error.message };
    }
    render() {
        if (this.state.error !== null) {
            return (
                <CenteredNote
                    title="The map could not be drawn"
                    detail={this.state.error}
                    action={
                        <Button size="sm" className="mt-3" onClick={() => this.setState({ error: null })}>
                            Try again
                        </Button>
                    }
                />
            );
        }
        return this.props.children;
    }
}

function MapIconButton({ icon: Icon, compact, className, ...props }: { icon: LucideIcon; compact: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            type="button"
            className={cn(
                "vibe-glass flex items-center justify-center transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                compact ? "h-11 w-11 rounded-full" : "h-9 w-9 rounded-lg",
                className,
            )}
            {...props}
        >
            <Icon className={compact ? "h-[18px] w-[18px]" : "h-4 w-4"} />
        </button>
    );
}

function toQueueTrack(t: { id: string; title: string; duration?: number; artist: { id: string; name: string }; album: { id: string; title: string; coverUrl: string | null } }): Track {
    return {
        id: t.id,
        title: t.title,
        duration: t.duration ?? 0,
        artist: { name: t.artist.name, id: t.artist.id },
        album: { title: t.album.title, coverArt: t.album.coverUrl ?? undefined, id: t.album.id },
    };
}

export default function VibePage() {
    const {
        mapData, isLoading, computing, error, refetch, trackMap, mode, selectedTrackId, highlightedIds,
        selectTrack, resetMode, setMode, setHighlightedIds,
    } = useVibeMap();

    const { currentTrack, playbackType, queue, activeOperation } = useAudioState();
    const { playTrack, replaceOperation } = useAudioControls();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const compact = isMobile || isTablet;

    const [driftSourceId, setDriftSourceId] = useState<string | null>(null);
    const [showPathPicker, setShowPathPicker] = useState(false);
    const [showAlchemy, setShowAlchemy] = useState(false);
    const [menu, setMenu] = useState<{ trackId: string; at: { x: number; y: number } } | null>(null);
    const [resetSignal, setResetSignal] = useState(0);
    const [moodPreview, setMoodPreview] = useState<string | null>(null);
    const [moodPinned, setMoodPinned] = useState<string | null>(null);

    const [showLabels, setShowLabels] = useState(() => {
        try { return localStorage.getItem("kima_vibe_labels") === "true"; } catch { return false; }
    });
    const toggleLabels = useCallback(() => {
        setShowLabels((prev) => {
            try { localStorage.setItem("kima_vibe_labels", String(!prev)); } catch { /* storage unavailable */ }
            return !prev;
        });
    }, []);

    const [hintDismissed, setHintDismissed] = useState(() => {
        try { return localStorage.getItem("kima_vibe_onboarding_seen") === "true"; } catch { return false; }
    });
    const dismissHint = useCallback(() => {
        setHintDismissed(true);
        try { localStorage.setItem("kima_vibe_onboarding_seen", "true"); } catch { /* storage unavailable */ }
    }, []);

    const queueTrackIds = useMemo(() => queue.map((t) => t.id), [queue]);
    const vibeRequestRef = useRef<AbortController | null>(null);
    const driftPickedAt = useRef(0);
    useEffect(() => () => { vibeRequestRef.current?.abort(); }, []);

    // Title/artist search over the loaded map. The index is built once per map;
    // each query is a single pass over pre-folded strings.
    const libraryIndex = useMemo(() => buildLibraryIndex(mapData?.tracks ?? []), [mapData]);
    const [searchQuery, setSearchQuery] = useState("");
    const searchResults = useMemo(() => searchLibrary(libraryIndex, searchQuery), [libraryIndex, searchQuery]);
    const [flyTo, setFlyTo] = useState<{ id: string; nonce: number } | null>(null);
    const [searchClears, setSearchClears] = useState(0);

    // Mood legend highlights apply only while no search/similar/path/blend result is showing.
    const moodFocus = mode === "idle" ? moodPreview ?? moodPinned : null;
    const displayedHighlights = useMemo(() => {
        if (mode === "search") return searchResults.ids;
        if (!moodFocus || !mapData) return highlightedIds;
        return new Set(mapData.tracks.filter((t) => t.dominantMood === moodFocus).map((t) => t.id));
    }, [mode, moodFocus, mapData, highlightedIds, searchResults]);

    // ── track operations ──
    const runTrackOperation = useCallback(async (trackId: string, op: "vibe" | "similar") => {
        vibeRequestRef.current?.abort();
        const controller = new AbortController();
        vibeRequestRef.current = controller;
        try {
            const response = await api.getVibeSimilarTracks(trackId, 50, controller.signal);
            if (controller.signal.aborted) return;
            if (!response.tracks?.length) {
                notify.error("No matches for this track yet");
                return;
            }
            if (!mapData?.tracks.some((t) => t.id === trackId)) return;
            if (op === "vibe") {
                const source = await api.getTrack(trackId);
                if (controller.signal.aborted || !source) return;
                const tracks = response.tracks.map(toQueueTrack);
                const operation: VibeOperation = {
                    type: "vibe",
                    sourceTrackId: trackId,
                    matches: Object.fromEntries(response.tracks.map((t) => [t.id, t.similarity])),
                    trackIds: [trackId, ...tracks.map((t) => t.id)],
                };
                await replaceOperation(operation, [source, ...tracks], 0);
            } else {
                setMoodPinned(null);
                setHighlightedIds(new Set([trackId, ...response.tracks.map((t) => t.id)]));
                setMode("similar");
            }
        } catch (error) {
            if (controller.signal.aborted) return;
            notify.error(error instanceof Error && error.message ? error.message : "Couldn't find matches for this track");
        }
    }, [mapData, replaceOperation, setHighlightedIds, setMode]);

    const playById = useCallback(async (trackId: string) => {
        try {
            const track = await api.getTrack(trackId);
            if (track) playTrack(track);
        } catch {
            notify.error("Couldn't play this track");
        }
    }, [playTrack]);

    // The second click of a double-click that picked a song-path destination
    // must not also start that track and race the path's queue.
    const playFromMap = useCallback((trackId: string) => {
        if (Date.now() - driftPickedAt.current < 600) return;
        void playById(trackId);
    }, [playById]);

    const playSelected = useCallback(() => {
        if (selectedTrackId) void playById(selectedTrackId);
    }, [selectedTrackId, playById]);

    const finishDrift = useCallback(async (sourceId: string, targetId: string) => {
        try {
            const result = await api.getVibePath(sourceId, targetId, { length: 12, mode: "smooth" });
            const steps = [result.startTrack, ...result.path, result.endTrack];
            const tracks: Track[] = steps.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                artist: { name: t.artistName, id: t.artistId },
                album: { title: t.albumTitle, coverArt: t.albumCoverUrl ?? undefined, id: t.albumId },
            }));
            const operation: VibeOperation = {
                type: "drift",
                startTrackId: sourceId,
                endTrackId: targetId,
                pathTrackIds: tracks.map((t) => t.id),
            };
            await replaceOperation(operation, tracks, 0);
        } catch (error) {
            notify.error(error instanceof Error && error.message ? error.message : "Couldn't find a path between those two tracks");
        }
    }, [replaceOperation]);

    // ── map interaction ──
    const handleTrackClick = useCallback((trackId: string) => {
        if (driftSourceId) {
            const sourceId = driftSourceId;
            setDriftSourceId(null);
            driftPickedAt.current = Date.now();
            if (sourceId !== trackId) void finishDrift(sourceId, trackId);
            return;
        }
        selectTrack(trackId);
    }, [driftSourceId, finishDrift, selectTrack]);

    const handleBackgroundClick = useCallback(() => {
        setMenu(null);
        setDriftSourceId(null);
        if (mode === "idle") selectTrack(null);
    }, [mode, selectTrack]);

    const handleTrackMenu = useCallback((trackId: string, at: { x: number; y: number }) => {
        setMenu({ trackId, at });
    }, []);

    const handleSearch = useCallback((query: string) => {
        setSearchQuery(query);
        if (query.trim().length >= 2) {
            setMoodPinned(null);
            setMode("search");
        } else {
            setMode((prev) => (prev === "search" ? "idle" : prev));
        }
    }, [setMode]);

    // Picking a search result selects that track and flies the camera to it.
    const pickSearchResult = useCallback((trackId: string) => {
        selectTrack(trackId);
        setFlyTo({ id: trackId, nonce: Date.now() });
    }, [selectTrack]);

    const openPathPicker = useCallback(() => {
        setShowPathPicker(true);
        setShowAlchemy(false);
        setMode("path-picking");
    }, [setMode]);

    const openAlchemy = useCallback(() => {
        setShowAlchemy(true);
        setShowPathPicker(false);
        setMode("alchemy");
    }, [setMode]);

    // The toolbar's Song Path and the one started from a track are the same drift.
    const submitPath = useCallback(async (startId: string, endId: string) => {
        setShowPathPicker(false);
        setMode("idle");
        await finishDrift(startId, endId);
    }, [finishDrift, setMode]);

    const clearAll = useCallback(() => {
        resetMode();
        setShowPathPicker(false);
        setShowAlchemy(false);
        setDriftSourceId(null);
        setMoodPinned(null);
        setSearchQuery("");
        setSearchClears((n) => n + 1);
    }, [resetMode]);

    // One Escape handler for the page, undoing the latest thing first: the menu,
    // an open Song Path or Blend panel, a pending song-path pick, then the
    // selection. Inputs that handle Escape themselves mark the event handled.
    const escapeState = useRef({ menu: false, panel: false, drift: false, selected: false });
    useEffect(() => {
        escapeState.current = { menu: !!menu, panel: showAlchemy || showPathPicker, drift: !!driftSourceId, selected: !!selectedTrackId };
    }, [menu, showAlchemy, showPathPicker, driftSourceId, selectedTrackId]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented) return;
            const state = escapeState.current;
            if (state.menu) setMenu(null);
            else if (state.panel) { setShowAlchemy(false); setShowPathPicker(false); resetMode(); }
            else if (state.drift) setDriftSourceId(null);
            else if (state.selected) selectTrack(null);
            else return;
            e.preventDefault();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [selectTrack, resetMode]);

    // A refetch can drop the selected track; do not leave the map dimmed for a
    // selection that no longer exists.
    useEffect(() => {
        if (selectedTrackId && mapData && !trackMap.has(selectedTrackId)) selectTrack(null);
    }, [selectedTrackId, mapData, trackMap, selectTrack]);

    if (isLoading) return <CenteredNote title="Charting your library" spinner />;
    if (computing) {
        return (
            <CenteredNote
                title="Charting your library"
                detail="Building the map. Large libraries take a few minutes."
                spinner
            />
        );
    }

    if (error) {
        return (
            <CenteredNote
                title="The music map did not load"
                detail={error instanceof Error ? error.message : undefined}
                action={
                    <Button size="sm" className="mt-3" onClick={() => refetch()}>
                        Try again
                    </Button>
                }
            />
        );
    }

    if (!mapData || mapData.tracks.length === 0) {
        return <CenteredNote title="No tracks with vibe analysis yet" detail="Run enrichment to analyse your library; tracks appear here as they finish." />;
    }

    const selectedTrack = selectedTrackId ? trackMap.get(selectedTrackId) : undefined;
    const showHint = mode === "idle" && !hintDismissed && !selectedTrack;
    const menuTrack = menu ? trackMap.get(menu.trackId) : undefined;

    return (
        <div className="vibe-sky relative h-full w-full overflow-hidden animate-rise">
            <SceneErrorBoundary>
                <VibeMapScene
                    tracks={mapData.tracks}
                    trackMap={trackMap}
                    highlightedIds={displayedHighlights}
                    selectedTrackId={selectedTrackId}
                    playingTrackId={currentTrack?.id ?? null}
                    queueTrackIds={queueTrackIds}
                    activeOperation={activeOperation}
                    showLabels={showLabels}
                    focusMood={moodFocus}
                    picking={!!driftSourceId}
                    resetSignal={resetSignal}
                    flyTo={flyTo}
                    coveredRight={!compact && selectedTrack ? PANEL_CLEARANCE : 0}
                    onTrackClick={handleTrackClick}
                    onTrackDoubleClick={playFromMap}
                    onTrackMenu={handleTrackMenu}
                    onBackgroundClick={handleBackgroundClick}
                />
            </SceneErrorBoundary>

            <VibeToolbar
                clearSignal={searchClears}
                mode={mode}
                compact={compact}
                onSearch={handleSearch}
                results={mode === "search" ? searchResults : null}
                onPickResult={pickSearchResult}
                onPathMode={openPathPicker}
                onAlchemyMode={openAlchemy}
                onReset={clearAll}
            />

            <div className={`absolute z-(--z-scene) flex ${compact
                ? "right-3 top-[max(0.75rem,env(safe-area-inset-top))] gap-2"
                : "left-[max(0.75rem,env(safe-area-inset-left))] top-[max(1rem,env(safe-area-inset-top))] gap-1"}`}>
                <MapIconButton
                    icon={Tag}
                    compact={compact}
                    onClick={toggleLabels}
                    aria-pressed={showLabels}
                    title={showLabels ? "hide labels" : "show labels"}
                    aria-label={showLabels ? "Hide labels" : "Show labels"}
                    className={showLabels ? "text-white" : "text-white/45"}
                />
                <MapIconButton
                    icon={LocateFixed}
                    compact={compact}
                    onClick={() => setResetSignal((n) => n + 1)}
                    title="show the whole library"
                    aria-label="Show the whole library"
                    className="text-white/70"
                />
            </div>

            {driftSourceId && (
                <div role="status" className={`vibe-glass absolute left-1/2 z-(--z-scene) flex -translate-x-1/2 items-center gap-3 rounded-full px-4 py-2 text-sm text-[var(--text-secondary)] ${compact ? "top-[max(7rem,calc(env(safe-area-inset-top)+7rem))] w-max max-w-[calc(100%-1.5rem)]" : "top-[max(4.25rem,calc(env(safe-area-inset-top)+4.25rem))]"}`}>
                    <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-brand)]" />
                    {compact ? "Tap the track the path should end on" : "Click the track the song path should end on"}
                    <button type="button" onClick={() => setDriftSourceId(null)} className="text-xs text-[var(--text-muted)] hover:text-white">
                        Cancel
                    </button>
                </div>
            )}

            {showPathPicker && <VibeSongPath library={libraryIndex} onStartPath={submitPath} onClose={() => { setShowPathPicker(false); setMode((m) => (m === "path-picking" ? "idle" : m)); }} />}
            {showAlchemy && <VibeAlchemy library={libraryIndex} onHighlight={setHighlightedIds} onClose={() => { setShowAlchemy(false); resetMode(); }} />}

            <div className={`absolute z-(--z-scene) ${compact
                ? "left-0 right-0 top-[max(4rem,calc(env(safe-area-inset-top)+4rem))] px-3"
                : "left-[max(0.75rem,env(safe-area-inset-left))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-w-[min(30rem,calc(100%-25rem))]"}`}>
                <MoodLegend
                    tracks={mapData.tracks}
                    trackCount={mapData.trackCount}
                    activeMood={moodFocus}
                    scroll={compact}
                    onPreview={setMoodPreview}
                    onToggle={(m) => { if (mode !== "idle") clearAll(); setMoodPinned((cur) => (cur === m ? null : m)); }}
                />
            </div>

            {!compact && showHint && (
                <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-[max(0.75rem,env(safe-area-inset-right))] z-(--z-scene) w-[22rem] max-w-sm">
                    <div className="vibe-glass flex items-start gap-3 rounded-xl px-4 py-3">
                        <div className="min-w-0 flex-1">
                            <p className="mb-0.5 text-xs font-semibold text-[var(--text-primary)]">This is your music, mapped by vibe.</p>
                            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                                Click: details · Double-click: play · Right-click: more · Drag: rotate · Right-drag: pan · Scroll: zoom
                            </p>
                        </div>
                        <button onClick={dismissHint} aria-label="Dismiss" className="shrink-0 rounded text-[var(--text-muted)] transition-colors hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}

            {!compact && selectedTrack && (
                <TrackPanel
                    track={selectedTrack}
                    songPathActive={driftSourceId === selectedTrack.id}
                    onClose={() => selectTrack(null)}
                    onPlay={playSelected}
                    onVibe={() => runTrackOperation(selectedTrack.id, "vibe")}
                    onSimilar={() => runTrackOperation(selectedTrack.id, "similar")}
                    onSongPath={() => setDriftSourceId((cur) => (cur === selectedTrack.id ? null : selectedTrack.id))}
                />
            )}

            {menuTrack && menu && (
                <TrackMenu
                    track={menuTrack}
                    at={menu.at}
                    avoidRight={!compact && selectedTrack ? PANEL_CLEARANCE : 0}
                    onClose={() => setMenu(null)}
                    onPlay={() => playById(menuTrack.id)}
                    onVibe={() => runTrackOperation(menuTrack.id, "vibe")}
                    onSimilar={() => runTrackOperation(menuTrack.id, "similar")}
                    onSongPath={() => setDriftSourceId(menuTrack.id)}
                />
            )}

            {compact && (
                <VibePanelSheet
                    selectedTrackId={selectedTrackId}
                    selectedTrackTitle={selectedTrack?.title ?? null}
                    selectedTrackArtist={selectedTrack?.artist ?? null}
                    onTrackOperation={selectedTrack ? (op) => runTrackOperation(selectedTrack.id, op) : undefined}
                    onStartSongPath={selectedTrack ? () => setDriftSourceId(selectedTrack.id) : undefined}
                    onPlay={selectedTrack ? playSelected : undefined}
                    selectedArtistId={selectedTrack?.artistId ?? null}
                    songPathActive={!!driftSourceId}
                    aboveMiniPlayer={!!playbackType}
                    intro={showHint ? (
                        <div className="flex items-start gap-3">
                            <p className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--text-secondary)] landscape-short:text-[11px]">
                                <span className="font-semibold text-[var(--text-primary)]">This is your music, mapped by vibe. </span>
                                Tap: details · Double-tap: play · Drag: rotate · Pinch: zoom · Two fingers: pan
                            </p>
                            <button onClick={dismissHint} aria-label="Dismiss" className="-mr-2 -mt-2 flex shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    ) : undefined}
                />
            )}
        </div>
    );
}
