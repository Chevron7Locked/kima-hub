"use client";

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useVibeMap } from "@/features/vibe/useVibeMap";
import { VibeMap } from "@/features/vibe/VibeMap";
import { VibeToolbar } from "@/features/vibe/VibeToolbar";
import { VibeSongPath } from "@/features/vibe/VibeSongPath";
import { VibePanelSheet } from "@/features/vibe/VibePanelSheet";
import { VibeAlchemy } from "@/features/vibe/VibeAlchemy";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import type { Track, VibeOperation } from "@/lib/audio-state-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { Loader2 } from "lucide-react";
type VibeView = "map" | "galaxy";

const GalacticMap = dynamic(
    () => import("@/features/vibe/scenes/GravityGridScene").then(m => ({ default: m.GravityGridScene })),
    { ssr: false },
);

class VibeMapErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean; error: string | null }
> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error: error.message };
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="w-full h-full vibe-map-bg flex items-center justify-center">
                    <div className="text-center">
                        <p className="text-white/40 text-sm">Map rendering failed</p>
                        <p className="text-white/20 text-xs mt-1">{this.state.error}</p>
                        <button
                            onClick={() => this.setState({ hasError: false, error: null })}
                            className="mt-3 px-4 py-1.5 bg-white/10 hover:bg-white/15 rounded text-xs text-white/60 hover:text-white"
                        >
                            Retry
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

export default function VibePage() {
    const {
        mapData,
        isLoading,
        error,
        refetch,
        trackMap,
        mode,
        selectedTrackId,
        highlightedIds,
        pathResult,
        selectTrack,
        completePathPicking,
        resetMode,
        setMode,
        setHighlightedIds,
    } = useVibeMap();

    // Suppress async WebGL teardown crash on rapid refresh. deck.gl's luma.gl
    // has a ResizeObserver that can fire after device destruction, accessing
    // device.limits.maxTextureDimension2D on an undefined object. Error
    // boundaries can't catch this (async callback). We intercept in the
    // capture phase with stopImmediatePropagation to prevent Next.js dev
    // overlay from displaying it -- the error is harmless (old page teardown).
    useEffect(() => {
        const handler = (e: ErrorEvent) => {
            if (e.message?.includes("maxTextureDimension2D")) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        };
        window.addEventListener("error", handler, true);
        return () => window.removeEventListener("error", handler, true);
    }, []);

    const [view, setView] = useState<VibeView>(() => {
        try {
            const saved = sessionStorage.getItem("kima_vibe_view");
            if (saved === "map" || saved === "galaxy") return saved;
        } catch { /* noop */ }
        return "map";
    });
    const [driftSourceId, setDriftSourceId] = useState<string | null>(null);
    const handleViewChange = useCallback((v: VibeView) => {
        setView(v);
        setDriftSourceId(null);
        try { sessionStorage.setItem("kima_vibe_view", v); } catch { /* noop */ }
    }, []);

    const [showLabels, setShowLabels] = useState(() => {
        try { return localStorage.getItem("kima_vibe_labels") !== "false"; } catch { return true; }
    });
    const handleToggleLabels = useCallback(() => {
        setShowLabels((prev) => {
            const next = !prev;
            try { localStorage.setItem("kima_vibe_labels", String(next)); } catch { /* noop */ }
            return next;
        });
    }, []);
    const [showPathPicker, setShowPathPicker] = useState(false);
    const [showAlchemy, setShowAlchemy] = useState(false);
    const { currentTrack, queue, activeOperation } = useAudioState();
    const { playTrack, replaceOperation } = useAudioControls();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const queueTrackIds = useMemo(() => queue.map(t => t.id), [queue]);
    const vibeRequestRef = useRef<AbortController | null>(null);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { vibeRequestRef.current?.abort(); }, []);
    useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);

    const handleTrackContextMenu = useCallback(async (trackId: string, op: 'vibe' | 'similar' | 'drift') => {
        if (op === 'drift') {
            setDriftSourceId(trackId);
            return;
        }

        // Cancel any in-flight request from a previous right-click
        vibeRequestRef.current?.abort();
        const controller = new AbortController();
        vibeRequestRef.current = controller;

        try {
            const response = await api.getVibeSimilarTracks(trackId, 50, controller.signal);
            if (controller.signal.aborted) return;
            if (!response.tracks || response.tracks.length === 0) return;

            if (!mapData?.tracks.some(t => t.id === trackId)) return;

            const tracks: Track[] = response.tracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                artist: { name: t.artist.name, id: t.artist.id },
                album: { title: t.album.title, coverArt: t.album.coverUrl ?? undefined, id: t.album.id },
            }));

            if (op === 'vibe') {
                const sourceTrackFull = await api.getTrack(trackId);
                if (controller.signal.aborted) return;
                if (!sourceTrackFull) return;
                const newOp: VibeOperation = {
                    type: 'vibe',
                    sourceTrackId: trackId,
                    sourceFeatures: {},
                    trackIds: [trackId, ...tracks.map(t => t.id)],
                };
                await replaceOperation(newOp, [sourceTrackFull, ...tracks], 0);
            } else {
                // similar -- highlight on map, no queue replacement
                setHighlightedIds(new Set(response.tracks.map(t => t.id)));
                setMode("similar");
            }
        } catch {
            // silently fail (includes abort errors)
        }
    }, [mapData, replaceOperation, setHighlightedIds, setMode]);

    // Galaxy is not suitable for mobile -- fall back to map view
    const effectiveView: VibeView = isMobile && view === "galaxy" ? "map" : view;

    const handleTrackClick = useCallback(async (trackId: string) => {
        if (mode === "path-picking") {
            completePathPicking(trackId);
            return;
        }
        if (driftSourceId) {
            const sourceId = driftSourceId;
            setDriftSourceId(null);
            try {
                const result = await api.getVibePath(sourceId, trackId, { length: 12, mode: "smooth" });
                const allPath = [result.startTrack, ...result.path, result.endTrack];
                const driftTracks: Track[] = allPath.map((t) => ({
                    id: t.id,
                    title: t.title,
                    duration: t.duration,
                    artist: { name: t.artistName, id: t.artistId },
                    album: { title: t.albumTitle, coverArt: t.albumCoverUrl ?? undefined, id: t.albumId },
                }));
                const newOp: VibeOperation = {
                    type: 'drift',
                    startTrackId: sourceId,
                    endTrackId: trackId,
                    pathTrackIds: driftTracks.map(t => t.id),
                };
                await replaceOperation(newOp, driftTracks, 0);
            } catch {
                // silently fail
            }
            return;
        }
        selectTrack(trackId);
    }, [mode, selectTrack, completePathPicking, driftSourceId, replaceOperation]);

    const handleTrackDoubleClick = useCallback(async (trackId: string) => {
        try {
            const track = await api.getTrack(trackId);
            if (track) playTrack(track);
        } catch {
            // Silently fail -- track may not be streamable
        }
    }, [playTrack]);

    const handleSearch = useCallback((query: string) => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            if (!query || query.length < 2 || !mapData) {
                setMode((prev) => {
                    if (prev === "search") {
                        setHighlightedIds(new Set());
                        return "idle";
                    }
                    return prev;
                });
                return;
            }
            const lower = query.toLowerCase();
            const matchIds = new Set<string>();
            for (const track of mapData.tracks) {
                if (track.title.toLowerCase().includes(lower) || track.artist.toLowerCase().includes(lower)) {
                    matchIds.add(track.id);
                }
            }
            setMode("search");
            setHighlightedIds(matchIds);
        }, 200);
    }, [mapData, setMode, setHighlightedIds]);

    const handlePathMode = useCallback(() => {
        setShowPathPicker(true);
        setShowAlchemy(false);
        setMode("path-picking");
    }, [setMode]);

    const handleAlchemyMode = useCallback(() => {
        setShowAlchemy(true);
        setShowPathPicker(false);
        setMode("alchemy");
    }, [setMode]);

    const handlePathSubmit = useCallback(async (startId: string, endId: string) => {
        setShowPathPicker(false);
        await completePathPicking(endId, startId);
    }, [completePathPicking]);

    const handleClose = useCallback(() => {
        resetMode();
        setShowPathPicker(false);
        setShowAlchemy(false);
    }, [resetMode]);

    const handleBackgroundClick = useCallback(() => {
        if (mode === "idle") selectTrack(null);
    }, [mode, selectTrack]);

    if (isLoading) {
        return (
            <div className="w-full h-full vibe-map-bg flex items-center justify-center">
                <div className="text-center">
                    <Loader2 className="w-6 h-6 text-[var(--color-ai)] animate-spin mx-auto mb-3 opacity-60" />
                    <p className="text-white/40 text-sm tracking-wide">Computing music map</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="w-full h-full vibe-map-bg flex items-center justify-center">
                <div className="text-center">
                    <p className="text-white/40 text-sm">Failed to load music map</p>
                    <p className="text-white/20 text-xs mt-1">{error instanceof Error ? error.message : "Unknown error"}</p>
                    <button
                        onClick={() => refetch()}
                        className="mt-3 px-4 py-1.5 bg-white/10 hover:bg-white/15 rounded text-xs text-white/60 hover:text-white"
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    if (!mapData || mapData.tracks.length === 0) {
        return (
            <div className="w-full h-full vibe-map-bg flex items-center justify-center">
                <div className="text-center">
                    <p className="text-white/40 text-sm">No tracks with vibe analysis yet</p>
                    <p className="text-white/20 text-xs mt-1">Run enrichment to generate embeddings</p>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full relative overflow-hidden">
                <VibeMapErrorBoundary>
                    {effectiveView === "map" ? (
                        <VibeMap
                            tracks={mapData.tracks}
                            highlightedIds={highlightedIds}
                            selectedTrackId={selectedTrackId}
                            pathResult={pathResult}
                            mode={mode}
                            trackMap={trackMap}
                            queueTrackIds={queueTrackIds}
                            showLabels={showLabels}
                            playingTrackId={currentTrack?.id ?? null}
                            activeOperation={activeOperation}
                            onTrackClick={handleTrackClick}
                            onTrackDoubleClick={handleTrackDoubleClick}
                            onBackgroundClick={handleBackgroundClick}
                        />
                    ) : (
                        <>
                            <GalacticMap
                                tracks={mapData.tracks}
                                highlightedIds={highlightedIds}
                                playingTrackId={currentTrack?.id ?? null}
                                selectedTrackId={selectedTrackId}
                                queueTrackIds={queueTrackIds}
                                activeOperation={activeOperation}
                                showLabels={showLabels}
                                onTrackClick={handleTrackClick}
                                onTrackDoubleClick={handleTrackDoubleClick}
                                onTrackContextMenu={handleTrackContextMenu}
                                onBackgroundClick={handleBackgroundClick}
                            />
                            {driftSourceId && (
                                <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 bg-black/80 text-white/70 px-4 py-2 rounded-lg text-sm backdrop-blur-sm border border-[#ecb200]/20 flex items-center gap-3">
                                    <span className="w-2 h-2 rounded-full bg-[#ecb200]/60 animate-pulse" />
                                    Click destination to begin drift
                                    <button
                                        onClick={() => setDriftSourceId(null)}
                                        className="text-white/30 hover:text-white ml-1 text-xs"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </VibeMapErrorBoundary>

                <VibeToolbar
                    mode={mode}
                    onSearch={handleSearch}
                    onPathMode={handlePathMode}
                    onAlchemyMode={handleAlchemyMode}
                    onReset={handleClose}
                />

                <div className="absolute top-[max(3.5rem,calc(env(safe-area-inset-top)+3.5rem))] left-[max(0.75rem,env(safe-area-inset-left))] z-10 flex flex-col gap-1">
                    <div className="flex gap-1 rounded-lg backdrop-blur-md border border-white/8 bg-black/20 p-0.5">
                        <button
                            onClick={() => handleViewChange("map")}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                                effectiveView === "map"
                                    ? "bg-white/10 text-white/70"
                                    : "text-white/30 hover:text-white/50"
                            }`}
                        >
                            Map
                        </button>
                        {!isMobile && (
                            <button
                                onClick={() => handleViewChange("galaxy")}
                                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                                    effectiveView === "galaxy"
                                        ? "bg-white/10 text-white/70"
                                        : "text-white/30 hover:text-white/50"
                                }`}
                            >
                                Galaxy
                            </button>
                        )}
                        <div className="w-px h-4 self-center bg-white/10" />
                        <button
                            onClick={handleToggleLabels}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                                showLabels
                                    ? "bg-white/10 text-white/70"
                                    : "text-white/30 hover:text-white/50"
                            }`}
                            title={showLabels ? "Hide labels" : "Show labels"}
                        >
                            Labels
                        </button>
                    </div>
                </div>

                {showPathPicker && (
                    <VibeSongPath
                        onStartPath={handlePathSubmit}
                        onClose={() => setShowPathPicker(false)}
                    />
                )}

                {showAlchemy && (
                    <VibeAlchemy
                        onHighlight={setHighlightedIds}
                        onClose={() => { setShowAlchemy(false); resetMode(); }}
                    />
                )}

                <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-10 text-white/15 text-[10px] tracking-widest uppercase font-medium">
                    {mapData.trackCount} tracks
                </div>

            {/* Mobile/tablet: bottom sheet for vibe details */}
            {(isMobile || isTablet) && <VibePanelSheet />}
        </div>
    );
}
