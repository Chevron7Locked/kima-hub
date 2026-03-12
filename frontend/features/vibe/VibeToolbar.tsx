"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Search, Waypoints, Blend, X } from "lucide-react";
import type { VibeMode } from "./types";

interface VibeToolbarProps {
    mode: VibeMode;
    onSearch: (query: string) => void;
    onPathMode: () => void;
    onAlchemyMode: () => void;
    onReset: () => void;
}

export function VibeToolbar({ mode, onSearch, onPathMode, onAlchemyMode, onReset }: VibeToolbarProps) {
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const onSearchRef = useRef(onSearch);
    useEffect(() => { onSearchRef.current = onSearch; }, [onSearch]);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            onSearchRef.current(query.trim());
        }, 150);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [query]);

    const handleClear = useCallback(() => {
        setQuery("");
        onReset();
        inputRef.current?.focus();
    }, [onReset]);

    return (
        <div className="absolute top-[max(1rem,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search tracks or artists..."
                    className="w-64 md:w-80 pl-9 pr-8 py-2 bg-white/10 backdrop-blur-md border border-white/10 rounded-lg text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/30"
                    aria-label="Search tracks or artists"
                />
                {query && (
                    <button type="button" onClick={handleClear} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70" aria-label="Clear search">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            <button
                onClick={onPathMode}
                className={`p-2 rounded-lg backdrop-blur-md border text-sm flex items-center gap-1.5 transition-colors ${
                    mode === "path-picking" || mode === "path-result"
                        ? "bg-white/20 border-white/30 text-white"
                        : "bg-white/10 border-white/10 text-white/60 hover:text-white hover:bg-white/15"
                }`}
                title="Drift -- journey between two tracks"
            >
                <Waypoints className="w-4 h-4" />
                <span className="hidden md:inline">Drift</span>
            </button>

            <button
                onClick={onAlchemyMode}
                className={`p-2 rounded-lg backdrop-blur-md border text-sm flex items-center gap-1.5 transition-colors ${
                    mode === "alchemy"
                        ? "bg-white/20 border-white/30 text-white"
                        : "bg-white/10 border-white/10 text-white/60 hover:text-white hover:bg-white/15"
                }`}
                title="Blend -- mix tracks to find new vibes"
            >
                <Blend className="w-4 h-4" />
                <span className="hidden md:inline">Blend</span>
            </button>

            {mode !== "idle" && (
                <button
                    onClick={onReset}
                    className="p-2 rounded-lg bg-white/10 backdrop-blur-md border border-white/10 text-white/60 hover:text-white hover:bg-white/15 text-sm"
                    title="Reset"
                >
                    <X className="w-4 h-4" />
                </button>
            )}
        </div>
    );
}
