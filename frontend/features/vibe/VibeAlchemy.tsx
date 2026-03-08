"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { X, Plus, Minus, FlaskConical, Search, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";

interface VibeAlchemyProps {
    onHighlight: (ids: Set<string>) => void;
    onClose: () => void;
}

interface SelectedTrack {
    id: string;
    title: string;
    artist: string;
}

export function VibeAlchemy({ onHighlight, onClose }: VibeAlchemyProps) {
    const { playTracks } = useAudioControls();
    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);
    const [addTracks, setAddTracks] = useState<SelectedTrack[]>([]);
    const [subtractTracks, setSubtractTracks] = useState<SelectedTrack[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [addingTo, setAddingTo] = useState<"add" | "subtract">("add");
    const [results, setResults] = useState<
        Array<{
            id: string;
            title: string;
            duration: number;
            similarity: number;
            album: { id: string; title: string; coverUrl: string | null };
            artist: { id: string; name: string };
        }>
    >([]);
    const [isComputing, setIsComputing] = useState(false);

    const { data: searchResults } = useQuery({
        queryKey: ["alchemy-search", searchQuery],
        queryFn: async () => {
            if (searchQuery.length < 2) return [];
            const result = await api.vibeSearch(searchQuery, 10);
            return result.tracks;
        },
        enabled: searchQuery.length >= 2,
        staleTime: 30000,
    });

    const addToColumn = useCallback(
        (track: { id: string; title: string; artist: { name: string } }) => {
            const selected: SelectedTrack = {
                id: track.id,
                title: track.title,
                artist: track.artist.name,
            };
            if (addingTo === "add") {
                setAddTracks((prev) =>
                    prev.some((t) => t.id === track.id)
                        ? prev
                        : [...prev, selected],
                );
            } else {
                setSubtractTracks((prev) =>
                    prev.some((t) => t.id === track.id)
                        ? prev
                        : [...prev, selected],
                );
            }
            setSearchQuery("");
        },
        [addingTo],
    );

    const removeTrack = useCallback(
        (id: string, column: "add" | "subtract") => {
            if (column === "add")
                setAddTracks((prev) => prev.filter((t) => t.id !== id));
            else setSubtractTracks((prev) => prev.filter((t) => t.id !== id));
        },
        [],
    );

    const compute = useCallback(async () => {
        if (addTracks.length === 0) return;
        setIsComputing(true);
        try {
            const result = await api.getVibeAlchemy(
                addTracks.map((t) => t.id),
                subtractTracks.map((t) => t.id),
                30,
            );
            if (!mountedRef.current) return;
            setResults(result.tracks);
            onHighlight(new Set(result.tracks.map((t) => t.id)));
        } catch {
            if (!mountedRef.current) return;
            setResults([]);
        } finally {
            if (mountedRef.current) setIsComputing(false);
        }
    }, [addTracks, subtractTracks, onHighlight]);

    const handlePlayResults = useCallback(() => {
        const playable: Track[] = results.map((t) => ({
            id: t.id,
            title: t.title,
            duration: t.duration,
            album: { title: t.album.title, coverArt: t.album.coverUrl ?? undefined, id: t.album.id },
            artist: { name: t.artist.name, id: t.artist.id },
        }));
        playTracks(playable, 0, true);
    }, [results, playTracks]);

    return (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 w-[480px] max-h-[70vh] bg-black/90 backdrop-blur-lg border border-white/10 rounded-xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h3 className="text-sm font-medium text-white/90 flex items-center gap-2">
                    <FlaskConical className="w-4 h-4" /> Song Alchemy
                </h3>
                <button
                    onClick={onClose}
                    className="text-white/40 hover:text-white"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <button
                            onClick={() => setAddingTo("add")}
                            className={`text-xs mb-2 flex items-center gap-1 ${addingTo === "add" ? "text-emerald-400" : "text-white/40"}`}
                        >
                            <Plus className="w-3 h-3" /> More Like
                        </button>
                        {addTracks.map((t) => (
                            <div
                                key={t.id}
                                className="flex items-center gap-1 mb-1"
                            >
                                <span className="text-xs text-white/70 truncate flex-1">
                                    {t.title}
                                </span>
                                <button
                                    onClick={() => removeTrack(t.id, "add")}
                                    className="text-white/30 hover:text-white"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                    <div>
                        <button
                            onClick={() => setAddingTo("subtract")}
                            className={`text-xs mb-2 flex items-center gap-1 ${addingTo === "subtract" ? "text-rose-400" : "text-white/40"}`}
                        >
                            <Minus className="w-3 h-3" /> Less Like
                        </button>
                        {subtractTracks.map((t) => (
                            <div
                                key={t.id}
                                className="flex items-center gap-1 mb-1"
                            >
                                <span className="text-xs text-white/70 truncate flex-1">
                                    {t.title}
                                </span>
                                <button
                                    onClick={() =>
                                        removeTrack(t.id, "subtract")
                                    }
                                    className="text-white/30 hover:text-white"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={`Search to add to "${addingTo === "add" ? "More Like" : "Less Like"}"...`}
                        className="w-full pl-8 pr-3 py-2 bg-white/8 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/20"
                    />
                </div>

                {searchResults &&
                    searchResults.length > 0 &&
                    searchQuery.length >= 2 && (
                        <div className="max-h-32 overflow-y-auto border border-white/10 rounded-lg">
                            {searchResults.map((track) => (
                                <button
                                    key={track.id}
                                    onClick={() => addToColumn(track)}
                                    className="w-full px-3 py-2 hover:bg-white/10 text-left"
                                >
                                    <p className="text-sm text-white/90 truncate">
                                        {track.title}
                                    </p>
                                    <p className="text-xs text-white/40 truncate">
                                        {track.artist.name}
                                    </p>
                                </button>
                            ))}
                        </div>
                    )}

                <button
                    onClick={compute}
                    disabled={addTracks.length === 0 || isComputing}
                    className="w-full px-3 py-2 bg-white/10 hover:bg-white/15 disabled:opacity-30 rounded-lg text-sm text-white/80 hover:text-white flex items-center justify-center gap-2"
                >
                    <FlaskConical className="w-4 h-4" />{" "}
                    {isComputing ? "Computing..." : "Blend"}
                </button>
            </div>

            {results.length > 0 && (
                <div className="border-t border-white/10">
                    <div className="px-4 py-2">
                        <button
                            onClick={handlePlayResults}
                            className="w-full px-3 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-sm text-white/80 hover:text-white flex items-center justify-center gap-2"
                        >
                            <Play className="w-4 h-4" /> Play Result (
                            {results.length})
                        </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                        {results.map((track, i) => (
                            <div
                                key={track.id}
                                className="px-4 py-2 hover:bg-white/5 flex items-center gap-3"
                            >
                                <span className="text-white/30 text-xs w-5 text-right">
                                    {i + 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-white/90 truncate">
                                        {track.title}
                                    </p>
                                    <p className="text-xs text-white/40 truncate">
                                        {track.artist.name}
                                    </p>
                                </div>
                                <span className="text-xs text-white/30">
                                    {Math.round(track.similarity * 100)}%
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
