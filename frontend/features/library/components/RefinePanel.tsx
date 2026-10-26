"use client";

import { KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
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
    /** Puts filter, sort and page size back to DEFAULT_REFINE in one change. */
    onReset: () => void;
}

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
    { label: "Name (A–Z)", value: "name" },
    { label: "Name (Z–A)", value: "name-desc" },
    { label: "Year (Newest)", value: "recent" },
    { label: "Most Tracks", value: "tracks" },
];

/** The sorts a tab offers: year for albums, track count for artists. */
export function sortOptionsFor(tab: Tab) {
    return SORT_OPTIONS.filter((opt) => {
        if (opt.value === "recent") return tab === "albums";
        if (opt.value === "tracks") return tab === "artists";
        return true;
    });
}

// Human-readable labels -- backend filter values ("owned"/"discovery") unchanged. The line under the switch
// describes the chosen one, in the tab's own noun.
const FILTER_OPTIONS: { label: string; value: LibraryFilter; describe: (noun: string) => string }[] = [
    { label: "In your library", value: "owned", describe: () => "Music you own or have saved" },
    { label: "Recommended", value: "discovery", describe: (noun) => `${noun} suggested by your listening history` },
    { label: "All", value: "all", describe: () => "Everything, owned and recommended" },
];

export const PER_PAGE_OPTIONS = [24, 40, 80, 200];

/** What the collection shows when the address names nothing else. */
export const DEFAULT_REFINE = { filter: "owned" as LibraryFilter, sortBy: "name" as SortOption, itemsPerPage: 40 };

/** The refinements that differ from DEFAULT_REFINE, in words, for the trigger's spoken name. */
function changedFromDefault(filter: LibraryFilter, sortBy: SortOption, itemsPerPage: number): string[] {
    const changed: string[] = [];
    if (filter !== DEFAULT_REFINE.filter) changed.push(FILTER_OPTIONS.find((o) => o.value === filter)?.label ?? filter);
    if (sortBy !== DEFAULT_REFINE.sortBy) changed.push(SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? sortBy);
    if (itemsPerPage !== DEFAULT_REFINE.itemsPerPage) changed.push(`${itemsPerPage} per page`);
    return changed;
}

const GAP = 8;
/** sm:w-96, the panel's width beside a phone. */
const PANEL_WIDTH = 384;

type Placement = { top: number; left: number; maxHeight: number };

/**
 * Where the panel sits above a phone-width screen: under its button, kept inside the page's scrolling area (which
 * ends above the player bar and the bottom navigation) and scrolling inside itself when that area is shorter. When
 * the page scrolls the button out of that area, `onLost` is called (the panel would otherwise follow it under the
 * top bar). On a phone the panel is a sheet placed by CSS, so nothing is measured.
 */
function usePanelPlacement(
    open: boolean,
    buttonRef: React.RefObject<HTMLButtonElement | null>,
    panelRef: React.RefObject<HTMLDivElement | null>,
    onLost: () => void,
) {
    const [place, setPlace] = useState<Placement | null>(null);

    const measure = useCallback(
        (e?: Event) => {
            const button = buttonRef.current;
            if (!button) return;
            if (e?.target instanceof Node && panelRef.current?.contains(e.target)) return;
            if (!window.matchMedia("(min-width: 640px)").matches) {
                setPlace((prev) => prev ?? { top: 0, left: 0, maxHeight: 0 });
                return;
            }
            const rect = button.getBoundingClientRect();
            const area = button.closest("#main-content")?.getBoundingClientRect();
            const areaTop = area?.top ?? 0;
            const areaBottom = Math.min(area?.bottom ?? window.innerHeight, window.innerHeight);
            if (rect.top < areaTop || rect.bottom > areaBottom) {
                onLost();
                return;
            }
            const top = Math.round(rect.bottom + GAP);
            const left = Math.round(Math.max(GAP, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 2 * GAP)));
            const maxHeight = Math.max(Math.round(areaBottom - top - GAP), 0);
            setPlace((prev) =>
                prev && prev.top === top && prev.left === left && prev.maxHeight === maxHeight
                    ? prev
                    : { top, left, maxHeight },
            );
        },
        [buttonRef, panelRef, onLost],
    );

    useLayoutEffect(() => {
        if (!open) return;
        // Measured before paint, so the panel never shows in the wrong place for a frame.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        measure();
        window.addEventListener("resize", measure);
        // The page scrolls inside #main-content, not the window: listen in the capture phase to hear it.
        window.addEventListener("scroll", measure, true);
        return () => {
            window.removeEventListener("resize", measure);
            window.removeEventListener("scroll", measure, true);
        };
    }, [open, measure]);

    // A closed panel has no placement; the last one is measured afresh on the next open.
    return open ? place : null;
}

interface Choice<T> {
    label: string;
    value: T;
}

/**
 * One choice of several, as a radio group: arrow keys, Home and End move and choose; Tab enters on the chosen one and
 * leaves.
 */
function ChoiceGroup<T extends string | number>({
    legend,
    choices,
    value,
    onChange,
    numeric,
}: {
    legend: string;
    choices: Choice<T>[];
    value: T;
    onChange: (value: T) => void;
    numeric?: boolean;
}) {
    const legendId = useId();
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const selected = Math.max(
        choices.findIndex((c) => c.value === value),
        0,
    );

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        // From the focused choice, not `value`: a second press can land before the address has the first one.
        const focused = refs.current.findIndex((el) => el === document.activeElement);
        const from = focused === -1 ? selected : focused;
        const last = choices.length - 1;
        const next = {
            ArrowRight: from === last ? 0 : from + 1,
            ArrowDown: from === last ? 0 : from + 1,
            ArrowLeft: from === 0 ? last : from - 1,
            ArrowUp: from === 0 ? last : from - 1,
            Home: 0,
            End: last,
        }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        onChange(choices[next].value);
        refs.current[next]?.focus();
    };

    return (
        <div className="flex flex-col gap-1.5">
            <span id={legendId} className="text-xs font-medium text-[var(--text-muted)]">
                {legend}
            </span>
            <div
                role="radiogroup"
                aria-labelledby={legendId}
                onKeyDown={onKeyDown}
                className="flex gap-1 rounded-lg border border-white/5 bg-white/[0.03] p-1"
            >
                {choices.map((choice, i) => {
                    const checked = i === selected;
                    return (
                        <button
                            key={String(choice.value)}
                            ref={(el) => {
                                refs.current[i] = el;
                            }}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            tabIndex={checked ? 0 : -1}
                            onClick={() => onChange(choice.value)}
                            className={cn(
                                "min-h-[44px] flex-auto whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-150",
                                numeric && "tabular-nums",
                                checked
                                    ? "bg-brand/10 text-brand"
                                    : "text-[var(--text-secondary)] hover:bg-white/5 hover:text-white",
                            )}
                        >
                            {choice.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function RefinePanel({
    activeTab,
    filter,
    sortBy,
    itemsPerPage,
    onFilterChange,
    onSortChange,
    onItemsPerPageChange,
    onReset,
}: RefinePanelProps) {
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const showFilterSection = activeTab === "artists" || activeTab === "albums";
    const changed = changedFromDefault(showFilterSection ? filter : DEFAULT_REFINE.filter, sortBy, itemsPerPage);
    const hasRefinements = changed.length > 0;

    const close = useCallback((refocus: boolean) => {
        setOpen(false);
        if (refocus) buttonRef.current?.focus();
    }, []);
    const lose = useCallback(() => setOpen(false), []);
    const place = usePanelPlacement(open, buttonRef, panelRef, lose);

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

        function handleKeyDown(e: globalThis.KeyboardEvent) {
            if (e.key === "Escape") {
                e.preventDefault();
                close(true);
            }
        }

        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [open, close]);

    // The panel is drawn at the end of the page, so the page's Tab order cannot reach it: opening it moves focus to the
    // chosen sort, and Tab past either end closes it and returns to the button, from where Tab carries on.
    const placed = place !== null;
    useEffect(() => {
        if (open && placed) panelRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
    }, [open, placed]);

    const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Tab") return;
        const stops = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not([tabindex='-1'])") ?? [])];
        const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
        if (document.activeElement === edge) {
            e.preventDefault();
            close(true);
        }
    };

    const noun = activeTab === "albums" ? "Albums" : "Artists";
    const filterChoice = FILTER_OPTIONS.find((o) => o.value === filter) ?? FILTER_OPTIONS[0];

    const panel = (
        <>
            {/* On a phone the panel is a sheet over the page; the scrim says the page behind is not live. */}
            <div aria-hidden className="fixed inset-0 z-(--z-dropdown) bg-black/50 animate-fade-in sm:hidden" />
            <div
                id="refine-panel"
                ref={panelRef}
                role="group"
                aria-label="Refine options"
                onKeyDown={onPanelKeyDown}
                // Tabbing out of the panel closes it, as clicking outside does.
                onBlur={(e) => {
                    const next = e.relatedTarget as Node | null;
                    if (next && !panelRef.current?.contains(next) && !buttonRef.current?.contains(next)) close(false);
                }}
                style={
                    place
                        ? ({
                              "--refine-top": `${place.top}px`,
                              "--refine-left": `${place.left}px`,
                              "--refine-max-h": `${place.maxHeight}px`,
                          } as React.CSSProperties)
                        : undefined
                }
                className={cn(
                    "fixed z-(--z-dropdown) flex flex-col overflow-y-auto overscroll-contain border border-[var(--border-subtle)] bg-[var(--bg-secondary)] animate-panel-up",
                    // Phone: a sheet along the bottom edge, clear of the home indicator.
                    "inset-x-0 bottom-0 max-h-[80dvh] rounded-t-2xl border-b-0 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]",
                    // Wider: a panel under its button, inside the page's scrolling area.
                    "sm:inset-x-auto sm:bottom-auto sm:top-(--refine-top) sm:left-(--refine-left) sm:max-h-(--refine-max-h) sm:w-96 sm:rounded-xl sm:border-b sm:pb-4",
                )}
            >
                <div className="sticky top-0 z-(--z-raised) -mx-4 flex min-h-[44px] items-center justify-between bg-[var(--bg-secondary)] px-2 pt-1">
                    {hasRefinements ? (
                        <button
                            type="button"
                            onClick={() => {
                                // This button goes once nothing is changed: keep focus in the panel, on the sort.
                                panelRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
                                onReset();
                            }}
                            className="min-h-[44px] rounded-md px-2 text-sm font-medium text-brand hover:bg-brand/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                        >
                            Reset
                        </button>
                    ) : (
                        <span />
                    )}
                    <button
                        type="button"
                        aria-label="Close refine panel"
                        onClick={() => close(true)}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex flex-col gap-4">
                    <ChoiceGroup
                        legend="Sort by"
                        choices={sortOptionsFor(activeTab)}
                        value={sortBy}
                        onChange={onSortChange}
                    />

                    {showFilterSection && (
                        <div className="flex flex-col gap-2">
                            <ChoiceGroup
                                legend="Show"
                                choices={FILTER_OPTIONS}
                                value={filter}
                                onChange={onFilterChange}
                            />
                            <p className="px-1 text-xs text-[var(--text-muted)]">{filterChoice.describe(noun)}</p>
                        </div>
                    )}

                    <ChoiceGroup
                        legend="Per page"
                        choices={PER_PAGE_OPTIONS.map((n) => ({ label: String(n), value: n }))}
                        value={itemsPerPage}
                        onChange={onItemsPerPageChange}
                        numeric
                    />
                </div>
            </div>
        </>
    );

    return (
        <div className="relative">
            <button
                ref={buttonRef}
                type="button"
                aria-expanded={open}
                aria-controls={open ? "refine-panel" : undefined}
                aria-label={
                    hasRefinements ? `Refine, changed: ${changed.join(", ")}` : "Refine: filter, sort, and per-page options"
                }
                onClick={() => setOpen((prev) => !prev)}
                className={cn(
                    // Matches the segmented control beside it: sentence case,
                    // medium weight, a hairline border.
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
                {hasRefinements && !open && (
                    <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-[var(--color-brand)] flex-shrink-0" />
                )}
            </button>

            {/* Drawn over the page, not inside it: the page's scrolling area would clip it. */}
            {open && createPortal(panel, document.body)}
        </div>
    );
}
