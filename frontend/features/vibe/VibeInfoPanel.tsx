"use client";

import { useCallback } from "react";
import { X, Play, ListMusic, Route, SkipForward } from "lucide-react";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { MapTrack, PathResult, VibeMode } from "./types";
import type { Track } from "@/lib/audio-state-context";

interface TrackResult {
    id: string;
    title: string;
    similarity?: number;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
}

interface VibeInfoPanelProps {
    mode: VibeMode;
    selectedTrack: MapTrack | null;
    similarTracks: TrackResult[];
    searchResults: TrackResult[];
    pathResult: PathResult | null;
    onClose: () => void;
    onShowSimilar: (trackId: string) => void;
    onStartPath: (trackId: string) => void;
    onTrackSelect: (trackId: string) => void;
}

function toPlayable(tracks: TrackResult[]): Track[] {
    return tracks.map(t => ({
        id: t.id,
        title: t.title,
        duration: 0,
        album: { id: t.album.id, title: t.album.title, coverArt: t.album.coverUrl ?? undefined },
        artist: { id: t.artist.id, name: t.artist.name },
    }));
}

export function VibeInfoPanel({
    mode,
    selectedTrack,
    similarTracks,
    searchResults,
    pathResult,
    onClose,
    onShowSimilar,
    onStartPath,
    onTrackSelect,
}: VibeInfoPanelProps) {
    const { playTracks } = useAudioControls();

    const isVisible = selectedTrack || similarTracks.length > 0 || searchResults.length > 0 || pathResult;
    if (!isVisible) return null;

    const handlePlayAll = useCallback((tracks: TrackResult[]) => {
        playTracks(toPlayable(tracks), 0, true);
    }, [playTracks]);

    const handlePlayPath = useCallback(() => {
        if (!pathResult) return;
        const all = [pathResult.startTrack, ...pathResult.path, pathResult.endTrack];
        const playable: Track[] = all.map(t => ({
            id: t.id,
            title: t.title,
            duration: t.duration,
            album: { id: t.albumId, title: t.albumTitle, coverArt: t.albumCoverUrl ?? undefined },
            artist: { id: t.artistId, name: t.artistName },
        }));
        playTracks(playable, 0, true);
    }, [pathResult, playTracks]);

    const activeTracks = mode === "similar" ? similarTracks : mode === "search" ? searchResults : [];

    return (
        <div className="absolute right-0 top-0 bottom-0 w-80 bg-black/90 backdrop-blur-lg border-l border-white/10 flex flex-col z-20 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h3 className="text-sm font-medium text-white/90">
                    {mode === "similar" && "Similar Tracks"}
                    {mode === "search" && "Search Results"}
                    {mode === "path-result" && "Song Path"}
                    {mode === "idle" && selectedTrack && "Track Info"}
                </h3>
                <button onClick={onClose} className="text-white/40 hover:text-white">
                    <X className="w-4 h-4" />
                </button>
            </div>

            {selectedTrack && mode === "idle" && (
                <div className="px-4 py-3 border-b border-white/10">
                    <p className="text-white text-sm font-medium truncate">{selectedTrack.title}</p>
                    <p className="text-white/50 text-xs truncate">{selectedTrack.artist}</p>
                    <div className="flex gap-2 mt-3">
                        <button
                            onClick={() => onShowSimilar(selectedTrack.id)}
                            className="flex-1 px-3 py-1.5 bg-white/10 hover:bg-white/15 rounded text-xs text-white/80 hover:text-white flex items-center justify-center gap-1"
                        >
                            <ListMusic className="w-3 h-3" /> Similar
                        </button>
                        <button
                            onClick={() => onStartPath(selectedTrack.id)}
                            className="flex-1 px-3 py-1.5 bg-white/10 hover:bg-white/15 rounded text-xs text-white/80 hover:text-white flex items-center justify-center gap-1"
                        >
                            <Route className="w-3 h-3" /> Path From Here
                        </button>
                    </div>
                </div>
            )}

            {activeTracks.length > 0 && (
                <div className="px-4 py-2 border-b border-white/10">
                    <button
                        onClick={() => handlePlayAll(activeTracks)}
                        className="w-full px-3 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-sm text-white/80 hover:text-white flex items-center justify-center gap-2"
                    >
                        <Play className="w-4 h-4" /> Play All ({activeTracks.length})
                    </button>
                </div>
            )}

            {pathResult && mode === "path-result" && (
                <div className="px-4 py-2 border-b border-white/10">
                    <button
                        onClick={handlePlayPath}
                        className="w-full px-3 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-sm text-white/80 hover:text-white flex items-center justify-center gap-2"
                    >
                        <Play className="w-4 h-4" /> Play Journey ({pathResult.metadata.totalTracks} tracks)
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto">
                {activeTracks.map((track, i) => (
                    <button
                        key={track.id}
                        onClick={() => onTrackSelect(track.id)}
                        className="w-full px-4 py-2.5 hover:bg-white/5 flex items-center gap-3 text-left"
                    >
                        <span className="text-white/30 text-xs w-5 text-right">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm text-white/90 truncate">{track.title}</p>
                            <p className="text-xs text-white/40 truncate">{track.artist.name}</p>
                        </div>
                        {track.similarity !== undefined && (
                            <span className="text-xs text-white/30">{Math.round(track.similarity * 100)}%</span>
                        )}
                    </button>
                ))}

                {pathResult && mode === "path-result" && (
                    <>
                        <div className="px-4 py-2.5 flex items-center gap-3">
                            <span className="text-white/30 text-xs w-5 text-right">1</span>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white/90 truncate">{pathResult.startTrack.title}</p>
                                <p className="text-xs text-white/40 truncate">{pathResult.startTrack.artistName}</p>
                            </div>
                            <span className="text-xs text-emerald-400/60">start</span>
                        </div>
                        {pathResult.path.map((track, i) => (
                            <button
                                key={track.id}
                                onClick={() => onTrackSelect(track.id)}
                                className="w-full px-4 py-2.5 hover:bg-white/5 flex items-center gap-3 text-left"
                            >
                                <span className="text-white/30 text-xs w-5 text-right">{i + 2}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-white/90 truncate">{track.title}</p>
                                    <p className="text-xs text-white/40 truncate">{track.artistName}</p>
                                </div>
                                <SkipForward className="w-3 h-3 text-white/20" />
                            </button>
                        ))}
                        <div className="px-4 py-2.5 flex items-center gap-3">
                            <span className="text-white/30 text-xs w-5 text-right">{pathResult.metadata.totalTracks}</span>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white/90 truncate">{pathResult.endTrack.title}</p>
                                <p className="text-xs text-white/40 truncate">{pathResult.endTrack.artistName}</p>
                            </div>
                            <span className="text-xs text-rose-400/60">end</span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
