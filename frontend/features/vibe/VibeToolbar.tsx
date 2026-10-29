"use client";

import { useState, useCallback, useRef } from "react";
import { Search, Waypoints, Blend, X } from "lucide-react";
import type { LibraryMatches } from "./librarySearch";
import type { VibeMode } from "./types";
import { useVibeSearch, VibeSearchResults } from "./useVibeSearch";

interface VibeToolbarProps {
    mode: VibeMode;
    /** Phones and tablets: the tools become a rail on the right edge and the search lives in the sheet. */
    compact: boolean;
    onSearch: (query: string) => void;
    /** Matches for the current query, or null when not searching. */
    results: LibraryMatches | null;
    onPickResult: (trackId: string) => void;
    onPathMode: () => void;
    onAlchemyMode: () => void;
    onReset: () => void;
    /** Bumped by the page whenever everything is cleared, so the search box empties too. */
    clearSignal: number;
}

const TOOL = "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";
const RAIL_TOOL = "vibe-glass flex h-11 w-11 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";

export function VibeToolbar({ mode, compact, onSearch, results, onPickResult, onPathMode, onAlchemyMode, onReset, clearSignal }: VibeToolbarProps) {
    const [open, setOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const pick = useCallback((id: string) => {
        onPickResult(id);
        setOpen(false);
        inputRef.current?.blur();
    }, [onPickResult]);

    // Phones search from inside the sheet.
    const { query, setQuery, activeIndex, setActive, searching, onResultKey } = useVibeSearch({
        onSearch,
        results,
        onPick: pick,
        clearSignal,
        enabled: !compact,
    });

    const clearSearch = useCallback(() => {
        onReset();
        inputRef.current?.focus();
    }, [onReset]);

    const showList = open && searching;
    const pathOn = mode === "path-picking";
    const blendOn = mode === "alchemy";

    const search = (
        <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/55" />
            <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={showList}
                aria-controls="vibe-search-results"
                aria-autocomplete="list"
                value={query}
                aria-activedescendant={showList && results && results.top.length > 0 ? `vibe-result-${activeIndex}` : undefined}
                onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={(e) => {
                    if (e.key === "Escape" && query) { e.preventDefault(); clearSearch(); return; }
                    if (showList) onResultKey(e);
                }}
                placeholder="find a track or artist"
                className="h-9 w-64 rounded-lg bg-white/[0.04] pl-8 pr-8 text-sm text-white placeholder-white/55 caret-[var(--color-brand)] outline-none transition-colors focus:bg-white/[0.07]"
                aria-label="Search tracks or artists"
            />
            {query && (
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={clearSearch} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-full p-1 text-white/60 hover:text-white" aria-label="Clear search">
                    <X className="h-3.5 w-3.5" />
                </button>
            )}

            {showList && results && (
                <VibeSearchResults
                    results={results}
                    query={query}
                    activeIndex={activeIndex}
                    onHover={setActive}
                    onPick={pick}
                    keepFocus
                    className="vibe-glass vibe-glass--solid absolute left-0 top-full z-10 mt-2 w-full min-w-72 overflow-hidden rounded-xl py-1"
                />
            )}
        </div>
    );

    if (compact) {
        return (
            <div className="absolute right-3 top-[7.25rem] z-(--z-scene) flex flex-col gap-2 landscape-short:right-3 landscape-short:top-[max(0.75rem,env(safe-area-inset-top))] landscape-short:flex-row" role="toolbar" aria-label="Map tools">
                <button
                    type="button"
                    onClick={onPathMode}
                    aria-pressed={pathOn}
                    className={`${RAIL_TOOL} ${pathOn ? "text-[var(--color-brand)]" : "text-white/80"}`}
                    aria-label="Song Path: build a queue that glides from one track to another"
                >
                    <Waypoints className="h-[18px] w-[18px]" />
                </button>
                <button
                    type="button"
                    onClick={onAlchemyMode}
                    aria-pressed={blendOn}
                    className={`${RAIL_TOOL} ${blendOn ? "text-[var(--color-brand)]" : "text-white/80"}`}
                    aria-label="Blend: mix tracks you like (and ones you don't) into a new playlist"
                >
                    <Blend className="h-[18px] w-[18px]" />
                </button>
                {mode !== "idle" && (
                    <button type="button" onClick={onReset} className={`${RAIL_TOOL} text-white/80`} aria-label="Clear highlights and paths">
                        <X className="h-[18px] w-[18px]" />
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="vibe-glass absolute left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-(--z-scene) flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-xl p-1">
            {search}
            <button
                type="button"
                onClick={onPathMode}
                aria-pressed={pathOn}
                className={`${TOOL} ${pathOn ? "bg-white/15 text-white" : "text-white/75 hover:bg-white/[0.07] hover:text-white"}`}
                title="song path: build a queue that glides from one track to another"
                aria-label="Song Path: build a queue that glides from one track to another"
            >
                <Waypoints className="h-4 w-4" />
                <span>Song Path</span>
            </button>
            <button
                type="button"
                onClick={onAlchemyMode}
                aria-pressed={blendOn}
                className={`${TOOL} ${blendOn ? "bg-white/15 text-white" : "text-white/75 hover:bg-white/[0.07] hover:text-white"}`}
                title="blend: mix tracks you like (and ones you don't) into a new playlist"
                aria-label="Blend: mix tracks you like (and ones you don't) into a new playlist"
            >
                <Blend className="h-4 w-4" />
                <span>Blend</span>
            </button>
            {mode !== "idle" && (
                <button
                    type="button"
                    onClick={onReset}
                    className={`${TOOL} text-white/75 hover:bg-white/[0.07] hover:text-white`}
                    title="clear highlights and paths"
                    aria-label="Clear highlights and paths"
                >
                    <X className="h-4 w-4" />
                </button>
            )}
        </div>
    );
}
