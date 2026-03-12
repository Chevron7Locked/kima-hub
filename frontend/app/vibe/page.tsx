"use client";

import React, { useState, useCallback } from "react";
import { useVibeMap } from "@/features/vibe/useVibeMap";
import { VibeMap } from "@/features/vibe/VibeMap";
import { VibeToolbar } from "@/features/vibe/VibeToolbar";
import { VibeInfoPanel } from "@/features/vibe/VibeInfoPanel";
import { VibeSongPath } from "@/features/vibe/VibeSongPath";
import { VibeAlchemy } from "@/features/vibe/VibeAlchemy";
import { Loader2 } from "lucide-react";
import type { TrackResult } from "@/features/vibe/types";

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
        showSimilar,
        startPathPicking,
        completePathPicking,
        resetMode,
        setMode,
        setHighlightedIds,
    } = useVibeMap();

    const [similarTracks, setSimilarTracks] = useState<TrackResult[]>([]);
    const [showPathPicker, setShowPathPicker] = useState(false);
    const [showAlchemy, setShowAlchemy] = useState(false);

    const selectedTrack = selectedTrackId ? trackMap.get(selectedTrackId) || null : null;

    const handleTrackClick = useCallback((trackId: string) => {
        if (mode === "path-picking") {
            completePathPicking(trackId);
            return;
        }
        selectTrack(trackId);
    }, [mode, selectTrack, completePathPicking]);

    const handleShowSimilar = useCallback(async (trackId: string) => {
        const tracks = await showSimilar(trackId);
        setSimilarTracks(tracks);
    }, [showSimilar]);

    const handleSearch = useCallback((query: string) => {
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
        setSimilarTracks([]);
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
                <VibeMap
                    tracks={mapData.tracks}
                    highlightedIds={highlightedIds}
                    selectedTrackId={selectedTrackId}
                    pathResult={pathResult}
                    mode={mode}
                    trackMap={trackMap}
                    onTrackClick={handleTrackClick}
                    onBackgroundClick={handleBackgroundClick}
                />
            </VibeMapErrorBoundary>

            <VibeToolbar
                mode={mode}
                onSearch={handleSearch}
                onPathMode={handlePathMode}
                onAlchemyMode={handleAlchemyMode}
                onReset={handleClose}
            />

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

            <VibeInfoPanel
                mode={mode}
                selectedTrack={selectedTrack}
                similarTracks={similarTracks}
                pathResult={pathResult}
                onClose={handleClose}
                onShowSimilar={handleShowSimilar}
                onStartPath={startPathPicking}
                onTrackSelect={selectTrack}
            />

            <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] z-10 text-white/15 text-[10px] tracking-widest uppercase font-medium">
                {mapData.trackCount} tracks
            </div>
        </div>
    );
}
