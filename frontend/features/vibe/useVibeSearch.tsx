"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { normalizeNFC } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { LibraryMatches } from "./librarySearch";

/**
 * The vibe page's search box state, shared by the desktop toolbar and the phone sheet: the query, sent to `onSearch`
 * 150 ms after typing stops (while `enabled`), the highlighted result, and the arrow and Enter keys over the results.
 * A new `clearSignal` from the page empties it.
 */
export function useVibeSearch({
    onSearch,
    results,
    onPick,
    clearSignal,
    enabled = true,
}: {
    onSearch: (query: string) => void;
    /** Matches for the current query, or null when not searching. */
    results: LibraryMatches | null;
    onPick: (trackId: string) => void;
    clearSignal: number;
    enabled?: boolean;
}) {
    const [query, setQueryState] = useState("");
    const [active, setActive] = useState(0);
    const [seenClear, setSeenClear] = useState(clearSignal);
    if (clearSignal !== seenClear) {
        setSeenClear(clearSignal);
        setQueryState("");
        setActive(0);
    }

    const onSearchRef = useRef(onSearch);
    useEffect(() => { onSearchRef.current = onSearch; }, [onSearch]);
    useEffect(() => {
        if (!enabled) return;
        const timer = setTimeout(() => onSearchRef.current(query.trim()), 150);
        return () => clearTimeout(timer);
    }, [query, enabled]);

    const items = results?.top ?? [];
    const activeIndex = items.length > 0 ? Math.min(active, items.length - 1) : 0;
    const searching = results !== null && query.trim().length >= 2;

    const setQuery = (next: string) => {
        setQueryState(next);
        setActive(0);
    };

    /** Arrows move through the results and Enter picks one; true when the key was used. */
    const onResultKey = (event: KeyboardEvent) => {
        if (!searching || items.length === 0) return false;
        if (event.key === "ArrowDown") setActive(Math.min(items.length - 1, activeIndex + 1));
        else if (event.key === "ArrowUp") setActive(Math.max(0, activeIndex - 1));
        else if (event.key === "Enter") onPick(items[activeIndex].id);
        else return false;
        event.preventDefault();
        return true;
    };

    return { query, setQuery, items, activeIndex, setActive, searching, onResultKey };
}

/** The matches under a vibe search box: how many there are, then the first of them. */
export function VibeSearchResults({
    results,
    query,
    activeIndex,
    onHover,
    onPick,
    keepFocus = false,
    className,
    inert,
}: {
    results: LibraryMatches;
    query: string;
    activeIndex: number;
    onHover: (index: number) => void;
    onPick: (trackId: string) => void;
    /** A click leaves the focus in the field (the toolbar's list closes when the field loses it). */
    keepFocus?: boolean;
    className?: string;
    inert?: boolean;
}) {
    return (
        <div id="vibe-search-results" role="listbox" aria-label="Matching tracks" inert={inert} className={className}>
            <p className="px-3 pb-1 pt-1.5 text-[11px] text-white/60" aria-live="polite">
                {results.count === 0
                    ? `no tracks match "${query.trim()}"`
                    : `${results.count.toLocaleString()} ${results.count === 1 ? "match" : "matches"}${results.count > results.top.length ? `, showing the first ${results.top.length}` : ""}`}
            </p>
            {results.top.map((track, index) => (
                <button
                    key={track.id}
                    id={`vibe-result-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
                    onMouseEnter={() => onHover(index)}
                    onClick={() => onPick(track.id)}
                    className={cn(
                        "block w-full px-3 py-2 text-left",
                        index === activeIndex ? "bg-white/[0.08]" : "hover:bg-white/[0.06]",
                    )}
                >
                    <span className="block truncate text-sm text-[var(--text-primary)]">{normalizeNFC(track.title)}</span>
                    <span className="block truncate text-xs text-white/60">{normalizeNFC(track.artist)}</span>
                </button>
            ))}
        </div>
    );
}
