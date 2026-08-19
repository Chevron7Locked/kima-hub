"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { LibraryFilter, SortOption } from "@/hooks/useQueries";
import { Tab } from "../types";

interface RefinePanelProps {
    activeTab: Tab;
    filter: LibraryFilter;
    sortBy: SortOption;
    itemsPerPage: number;
    onFilterChange: (filter: LibraryFilter) => void;
    onSortChange: (sort: SortOption) => void;
    onItemsPerPageChange: (items: number) => void;
}

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
    { label: "Name (A–Z)", value: "name" },
    { label: "Name (Z–A)", value: "name-desc" },
    { label: "Year (Newest)", value: "recent" },
    { label: "Most Tracks", value: "tracks" },
];

// Human-readable labels -- backend filter values ("owned"/"discovery") unchanged
const FILTER_OPTIONS: { label: string; description: string; value: LibraryFilter }[] = [
    {
        label: "In your library",
        description: "Music you own or have saved",
        value: "owned",
    },
    {
        label: "Recommended",
        description: "Artists suggested by your listening history",
        value: "discovery",
    },
    {
        label: "All",
        description: "Everything, owned and recommended",
        value: "all",
    },
];

const PER_PAGE_OPTIONS = [24, 40, 80, 200];

function isNonDefault(filter: LibraryFilter, sortBy: SortOption, itemsPerPage: number): boolean {
    return filter !== "owned" || sortBy !== "name" || itemsPerPage !== 40;
}

export function RefinePanel({
    activeTab,
    filter,
    sortBy,
    itemsPerPage,
    onFilterChange,
    onSortChange,
    onItemsPerPageChange,
}: RefinePanelProps) {
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const showFilterSection = activeTab === "artists" || activeTab === "albums";
    const hasRefinements = isNonDefault(filter, sortBy, itemsPerPage);

    // Dismiss on click-outside
    useEffect(() => {
        if (!open) return;

        function handlePointerDown(e: PointerEvent) {
            if (
                panelRef.current &&
                !panelRef.current.contains(e.target as Node) &&
                buttonRef.current &&
                !buttonRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        }

        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [open]);

    // Dismiss on Escape
    useEffect(() => {
        if (!open) return;

        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") {
                setOpen(false);
                buttonRef.current?.focus();
            }
        }

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [open]);

    // Visible sort options depend on active tab
    const sortOptions = SORT_OPTIONS.filter((opt) => {
        if (opt.value === "recent") return activeTab === "albums";
        if (opt.value === "tracks") return activeTab === "artists";
        return true;
    });

    return (
        <div className="relative">
            {/* Refine trigger button */}
            <button
                ref={buttonRef}
                type="button"
                aria-expanded={open}
                aria-controls="refine-panel"
                aria-label="Refine: filter, sort, and per-page options"
                onClick={() => setOpen((prev) => !prev)}
                className={cn(
                    // Matches the segmented control beside it: sentence case,
                    // medium weight, a hairline border. It was set in the
                    // 12px bold-caps-tracked micro-label style, which is for
                    // metadata, not for a control you press.
                    "relative flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition-colors min-h-[44px] select-none",
                    open
                        ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-brand)]"
                        : hasRefinements
                          ? "border-[var(--color-brand)]/50 bg-white/5 text-[var(--color-brand)] hover:border-[var(--color-brand)] hover:bg-[var(--color-brand)]/10"
                          : "border-white/10 bg-white/5 text-[var(--text-secondary)] hover:text-white hover:bg-white/10 hover:border-white/20",
                )}
            >
                <SlidersHorizontal className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Refine</span>
                {/* Active-state dot */}
                {hasRefinements && !open && (
                    <span
                        aria-label="Refinements active"
                        className="w-1.5 h-1.5 rounded-full bg-[var(--color-brand)] flex-shrink-0"
                    />
                )}
            </button>

            {/* Disclosure panel */}
            {open && (
                <div
                    id="refine-panel"
                    ref={panelRef}
                    role="dialog"
                    aria-label="Refine options"
                    // Anchored to the button's LEFT edge, not its right. The
                    // trigger is the first thing in the toolbar at every
                    // width, so right-0 hung the panel off the start of the
                    // page: at 388px, 162px of its 288px was unreachable.
                    className="absolute left-0 top-full mt-2 z-(--z-dropdown) w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] shadow-xl shadow-black/50 p-4 flex flex-col gap-5"
                >
                    {/* Panel header */}
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-white">Refine</span>
                        <button
                            type="button"
                            aria-label="Close refine panel"
                            onClick={() => {
                                setOpen(false);
                                buttonRef.current?.focus();
                            }}
                            className="p-1 rounded text-[var(--text-muted)] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)] transition-colors"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    {/* Filter section -- hidden for Tracks tab */}
                    {showFilterSection && (
                        <fieldset className="flex flex-col gap-1.5">
                            <legend className="text-xs font-medium text-[var(--text-muted)] mb-2">
                                Show
                            </legend>
                            {FILTER_OPTIONS.map((opt) => {
                                const isActive = filter === opt.value;
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        aria-pressed={isActive}
                                        onClick={() => onFilterChange(opt.value)}
                                        className={cn(
                                            "flex flex-col items-start px-3 py-2.5 rounded-lg border text-left transition-colors",
                                            isActive
                                                ? "border-[var(--color-brand)]/50 bg-[var(--color-brand)]/10"
                                                : "border-white/5 bg-white/3 hover:bg-white/8 hover:border-white/15",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "text-sm font-medium",
                                                isActive ? "text-[var(--color-brand)]" : "text-white",
                                            )}
                                        >
                                            {opt.label}
                                        </span>
                                        <span className="text-xs text-[var(--text-muted)] mt-0.5">
                                            {opt.description}
                                        </span>
                                    </button>
                                );
                            })}
                        </fieldset>
                    )}

                    {/* Sort section */}
                    <fieldset className="flex flex-col gap-1">
                        <legend className="text-xs font-medium text-[var(--text-muted)] mb-2">
                            Sort by
                        </legend>
                        <div className="grid grid-cols-2 gap-1.5">
                            {sortOptions.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    aria-pressed={sortBy === opt.value}
                                    onClick={() => onSortChange(opt.value)}
                                    className={cn(
                                        "px-3 py-2 min-h-[44px] text-sm font-medium rounded-lg border transition-colors",
                                        sortBy === opt.value
                                            ? "border-[var(--color-brand)]/50 bg-[var(--color-brand)]/10 text-[var(--color-brand)]"
                                            : "border-white/5 bg-white/3 text-[var(--text-secondary)] hover:bg-white/8 hover:border-white/15 hover:text-white",
                                    )}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </fieldset>

                    {/* Per-page section */}
                    <fieldset className="flex flex-col gap-1">
                        <legend className="text-xs font-medium text-[var(--text-muted)] mb-2">
                            Items per page
                        </legend>
                        <div className="grid grid-cols-4 gap-1.5">
                            {PER_PAGE_OPTIONS.map((n) => (
                                <button
                                    key={n}
                                    type="button"
                                    aria-pressed={itemsPerPage === n}
                                    onClick={() => onItemsPerPageChange(n)}
                                    className={cn(
                                        "py-2 min-h-[44px] text-sm font-medium tabular-nums rounded-lg border transition-colors",
                                        itemsPerPage === n
                                            ? "border-[var(--color-brand)]/50 bg-[var(--color-brand)]/10 text-[var(--color-brand)]"
                                            : "border-white/5 bg-white/3 text-[var(--text-secondary)] hover:bg-white/8 hover:border-white/15 hover:text-white",
                                    )}
                                >
                                    {n}
                                </button>
                            ))}
                        </div>
                    </fieldset>
                </div>
            )}
        </div>
    );
}
