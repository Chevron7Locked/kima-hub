"use client";

import { useState, useCallback, useRef } from "react";
import { Search, Route, FlaskConical, X, Sparkles } from "lucide-react";
import type { VibeMode } from "./types";

const PRESETS = ["Chill", "High Energy", "Acoustic", "Dark", "Party", "Electronic"];

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

    const handleSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = query.trim();
        if (trimmed.length >= 2) {
            onSearch(trimmed);
        }
    }, [query, onSearch]);

    const handlePreset = useCallback((preset: string) => {
        setQuery(preset.toLowerCase());
        onSearch(preset.toLowerCase());
    }, [onSearch]);

    const handleClear = useCallback(() => {
        setQuery("");
        onReset();
        inputRef.current?.focus();
    }, [onReset]);

    return (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
            <form onSubmit={handleSubmit} className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search vibes..."
                    className="w-64 md:w-80 pl-9 pr-8 py-2 bg-white/10 backdrop-blur-md border border-white/10 rounded-lg text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/30"
                />
                {query && (
                    <button type="button" onClick={handleClear} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </form>

            <button
                onClick={onPathMode}
                className={`p-2 rounded-lg backdrop-blur-md border text-sm flex items-center gap-1.5 transition-colors ${
                    mode === "path-picking" || mode === "path-result"
                        ? "bg-white/20 border-white/30 text-white"
                        : "bg-white/10 border-white/10 text-white/60 hover:text-white hover:bg-white/15"
                }`}
                title="Song Path"
            >
                <Route className="w-4 h-4" />
                <span className="hidden md:inline">Path</span>
            </button>

            <button
                onClick={onAlchemyMode}
                className={`p-2 rounded-lg backdrop-blur-md border text-sm flex items-center gap-1.5 transition-colors ${
                    mode === "alchemy"
                        ? "bg-white/20 border-white/30 text-white"
                        : "bg-white/10 border-white/10 text-white/60 hover:text-white hover:bg-white/15"
                }`}
                title="Song Alchemy"
            >
                <FlaskConical className="w-4 h-4" />
                <span className="hidden md:inline">Alchemy</span>
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

            {mode === "idle" && (
                <div className="absolute top-full mt-2 left-0 flex gap-1.5 flex-wrap">
                    {PRESETS.map(preset => (
                        <button
                            key={preset}
                            onClick={() => handlePreset(preset)}
                            className="px-3 py-1 text-xs bg-white/8 hover:bg-white/15 border border-white/10 rounded-full text-white/50 hover:text-white/80 transition-colors flex items-center gap-1"
                        >
                            <Sparkles className="w-3 h-3" />
                            {preset}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
