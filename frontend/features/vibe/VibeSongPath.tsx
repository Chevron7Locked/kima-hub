"use client";

import { useState, useCallback } from "react";
import { X, Search, Route, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

interface VibeSongPathProps {
    onStartPath: (startId: string, endId: string) => void;
    onClose: () => void;
}

export function VibeSongPath({ onStartPath, onClose }: VibeSongPathProps) {
    const [startQuery, setStartQuery] = useState("");
    const [endQuery, setEndQuery] = useState("");
    const [startTrackId, setStartTrackId] = useState<string | null>(null);
    const [endTrackId, setEndTrackId] = useState<string | null>(null);
    const [activeInput, setActiveInput] = useState<"start" | "end" | null>(null);

    const { data: startResults } = useQuery({
        queryKey: ["track-search", "start", startQuery],
        queryFn: async () => {
            if (startQuery.length < 2) return [];
            const result = await api.vibeSearch(startQuery, 10);
            return result.tracks;
        },
        enabled: startQuery.length >= 2 && activeInput === "start",
        staleTime: 30000,
    });

    const { data: endResults } = useQuery({
        queryKey: ["track-search", "end", endQuery],
        queryFn: async () => {
            if (endQuery.length < 2) return [];
            const result = await api.vibeSearch(endQuery, 10);
            return result.tracks;
        },
        enabled: endQuery.length >= 2 && activeInput === "end",
        staleTime: 30000,
    });

    const searchResults = activeInput === "start" ? startResults : activeInput === "end" ? endResults : undefined;

    const selectTrack = useCallback((track: { id: string; title: string; artist: { name: string } }) => {
        const label = `${track.title} - ${track.artist.name}`;
        if (activeInput === "start") {
            setStartTrackId(track.id);
            setStartQuery(label);
            setActiveInput("end");
        } else {
            setEndTrackId(track.id);
            setEndQuery(label);
            setActiveInput(null);
        }
    }, [activeInput]);

    const handleSubmit = useCallback(() => {
        if (startTrackId && endTrackId) {
            onStartPath(startTrackId, endTrackId);
        }
    }, [startTrackId, endTrackId, onStartPath]);

    return (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 w-96 bg-black/90 backdrop-blur-lg border border-white/10 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-white/90 flex items-center gap-2">
                    <Route className="w-4 h-4" /> Song Path
                </h3>
                <button onClick={onClose} className="text-white/40 hover:text-white">
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="space-y-2">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
                    <input
                        type="text"
                        value={startQuery}
                        onChange={(e) => { setStartQuery(e.target.value); setStartTrackId(null); }}
                        onFocus={() => setActiveInput("start")}
                        placeholder="Start track..."
                        className="w-full pl-8 pr-3 py-2 bg-white/8 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/20"
                    />
                </div>

                <div className="flex justify-center">
                    <ArrowRight className="w-4 h-4 text-white/20" />
                </div>

                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
                    <input
                        type="text"
                        value={endQuery}
                        onChange={(e) => { setEndQuery(e.target.value); setEndTrackId(null); }}
                        onFocus={() => setActiveInput("end")}
                        placeholder="End track..."
                        className="w-full pl-8 pr-3 py-2 bg-white/8 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-white/20"
                    />
                </div>
            </div>

            {activeInput && searchResults && searchResults.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto border border-white/10 rounded-lg">
                    {searchResults.map(track => (
                        <button
                            key={track.id}
                            onClick={() => selectTrack(track)}
                            className="w-full px-3 py-2 hover:bg-white/10 text-left"
                        >
                            <p className="text-sm text-white/90 truncate">{track.title}</p>
                            <p className="text-xs text-white/40 truncate">{track.artist.name}</p>
                        </button>
                    ))}
                </div>
            )}

            <button
                onClick={handleSubmit}
                disabled={!startTrackId || !endTrackId}
                className="w-full mt-3 px-3 py-2 bg-white/10 hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-white/10 rounded-lg text-sm text-white/80 hover:text-white flex items-center justify-center gap-2 transition-colors"
            >
                <Route className="w-4 h-4" /> Generate Path
            </button>
        </div>
    );
}
