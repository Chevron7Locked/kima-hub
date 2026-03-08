"use client";

import { useState, useCallback } from "react";
import { useVibeMap } from "@/features/vibe/useVibeMap";
import { VibeMap } from "@/features/vibe/VibeMap";
import { VibeToolbar } from "@/features/vibe/VibeToolbar";
import { VibeInfoPanel } from "@/features/vibe/VibeInfoPanel";
import { VibeSongPath } from "@/features/vibe/VibeSongPath";
import { VibeAlchemy } from "@/features/vibe/VibeAlchemy";
import { Loader2 } from "lucide-react";

export default function VibePage() {
    const {
        mapData,
        isLoading,
        error,
        trackMap,
        mode,
        selectedTrackId,
        highlightedIds,
        pathResult,
        selectTrack,
        showSimilar,
        searchVibe,
        startPathPicking,
        completePathPicking,
        resetMode,
        setMode,
        setHighlightedIds,
    } = useVibeMap();

    const [similarTracks, setSimilarTracks] = useState<Array<{ id: string; title: string; similarity?: number; album: { id: string; title: string; coverUrl: string | null }; artist: { id: string; name: string } }>>([]);
    const [searchResults, setSearchResults] = useState<Array<{ id: string; title: string; similarity?: number; album: { id: string; title: string; coverUrl: string | null }; artist: { id: string; name: string } }>>([]);
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

    const handleSearch = useCallback(async (query: string) => {
        const tracks = await searchVibe(query);
        setSearchResults(tracks);
    }, [searchVibe]);

    const handleStartPath = useCallback((trackId: string) => {
        startPathPicking(trackId);
    }, [startPathPicking]);

    const handlePathMode = useCallback(() => {
        setShowPathPicker(true);
        setShowAlchemy(false);
    }, []);

    const handleAlchemyMode = useCallback(() => {
        setShowAlchemy(true);
        setShowPathPicker(false);
        setMode("alchemy");
    }, [setMode]);

    const handlePathSubmit = useCallback(async (startId: string, endId: string) => {
        setShowPathPicker(false);
        startPathPicking(startId);
        await completePathPicking(endId);
    }, [startPathPicking, completePathPicking]);

    const handleAlchemyHighlight = useCallback((ids: Set<string>) => {
        setHighlightedIds(ids);
    }, [setHighlightedIds]);

    const handleClose = useCallback(() => {
        resetMode();
        setSimilarTracks([]);
        setSearchResults([]);
        setShowPathPicker(false);
        setShowAlchemy(false);
    }, [resetMode]);

    const handleTrackSelect = useCallback((trackId: string) => {
        selectTrack(trackId);
    }, [selectTrack]);

    if (isLoading) {
        return (
            <div className="w-full h-full bg-[#0a0a0a] flex items-center justify-center">
                <div className="text-center">
                    <Loader2 className="w-8 h-8 text-white/30 animate-spin mx-auto mb-3" />
                    <p className="text-white/50 text-sm">Computing music map...</p>
                    <p className="text-white/30 text-xs mt-1">This may take a moment for large libraries</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="w-full h-full bg-[#0a0a0a] flex items-center justify-center">
                <div className="text-center">
                    <p className="text-white/50 text-sm">Failed to load music map</p>
                    <p className="text-white/30 text-xs mt-1">{error instanceof Error ? error.message : "Unknown error"}</p>
                </div>
            </div>
        );
    }

    if (!mapData || mapData.tracks.length === 0) {
        return (
            <div className="w-full h-full bg-[#0a0a0a] flex items-center justify-center">
                <div className="text-center">
                    <p className="text-white/50 text-sm">No tracks with vibe analysis yet</p>
                    <p className="text-white/30 text-xs mt-1">Run enrichment to generate CLAP embeddings for your library</p>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full relative overflow-hidden">
            <VibeMap
                tracks={mapData.tracks}
                highlightedIds={highlightedIds}
                selectedTrackId={selectedTrackId}
                pathResult={pathResult}
                mode={mode}
                trackMap={trackMap}
                onTrackClick={handleTrackClick}
                onTrackHover={() => {}}
                onBackgroundClick={() => {
                    if (mode === "idle") selectTrack(null);
                }}
            />

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
                    onHighlight={handleAlchemyHighlight}
                    onClose={() => { setShowAlchemy(false); resetMode(); }}
                />
            )}

            <VibeInfoPanel
                mode={mode}
                selectedTrack={selectedTrack}
                similarTracks={similarTracks}
                searchResults={searchResults}
                pathResult={pathResult}
                onClose={handleClose}
                onShowSimilar={handleShowSimilar}
                onStartPath={handleStartPath}
                onTrackSelect={handleTrackSelect}
            />

            <div className="absolute bottom-4 left-4 z-10 text-white/20 text-xs">
                {mapData.trackCount} tracks mapped
            </div>
        </div>
    );
}
