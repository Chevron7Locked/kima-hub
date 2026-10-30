"use client";

import { KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { createPortal } from "react-dom";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsTV } from "@/lib/tv-utils";
import { LibraryFilter, SortOption } from "@/hooks/useQueries";
import { Tab } from "../types";

interface RefineProps {
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

// Human-readable labels -- backend filter values ("owned"/"discovery") unchanged. The description says what the chosen
// one shows, in the tab's own noun.
const FILTER_OPTIONS: { label: string; value: LibraryFilter; describe: (noun: string) => string }[] = [
    { label: "In your library", value: "owned", describe: () => "Music you own or have saved" },
    { label: "Recommended", value: "discovery", describe: (noun) => `${noun} suggested by your listening history` },
    { label: "All", value: "all", describe: () => "Everything, owned and recommended" },
];

export const PER_PAGE_OPTIONS = [24, 40, 80, 200];

/** What the collection shows when the address names nothing else. */
export const DEFAULT_REFINE = { filter: "owned" as LibraryFilter, sortBy: "name" as SortOption, itemsPerPage: 40 };

/** The refinements that differ from DEFAULT_REFINE, in words, for the phone button's spoken name. */
function changedFromDefault(filter: LibraryFilter, sortBy: SortOption, itemsPerPage: number): string[] {
    const changed: string[] = [];
    if (filter !== DEFAULT_REFINE.filter) changed.push(FILTER_OPTIONS.find((o) => o.value === filter)?.label ?? filter);
    if (sortBy !== DEFAULT_REFINE.sortBy) changed.push(SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? sortBy);
    if (itemsPerPage !== DEFAULT_REFINE.itemsPerPage) changed.push(`${itemsPerPage} per page`);
    return changed;
}

/** What the controls share: whether the tab has a filter, and what is changed from the default. */
function useRefineState({ activeTab, filter, sortBy, itemsPerPage }: RefineProps) {
    const showFilterSection = activeTab === "artists" || activeTab === "albums";
    const changed = changedFromDefault(showFilterSection ? filter : DEFAULT_REFINE.filter, sortBy, itemsPerPage);
    const noun = activeTab === "albums" ? "Albums" : "Artists";
    const description = (FILTER_OPTIONS.find((o) => o.value === filter) ?? FILTER_OPTIONS[0]).describe(noun);
    return { showFilterSection, changed, hasRefinements: changed.length > 0, description };
}

/** The width from which the controls sit on the toolbar line; below it they open as a sheet (Tailwind's `sm`). */
const WIDE = "(min-width: 640px)";

interface Choice<T> {
    label: string;
    value: T;
}

/**
 * One choice of several, as a radio group: arrow keys, Home and End move and choose; Tab enters on the chosen one and
 * leaves. `inline` hides the legend (the choices name themselves on the toolbar line).
 */
function ChoiceGroup<T extends string | number>({
    legend,
    choices,
    value,
    onChange,
    numeric,
    inline,
    description,
    tvCards,
}: {
    legend: string;
    choices: Choice<T>[];
    value: T;
    onChange: (value: T) => void;
    numeric?: boolean;
    inline?: boolean;
    description?: string;
    /** Each choice is a stop in the TV remote's row. */
    tvCards?: boolean;
}) {
    const legendId = useId();
    const descriptionId = useId();
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
        <div className={cn("flex flex-col gap-1.5", inline && "gap-0")}>
            <span id={legendId} className={cn("text-xs font-medium text-[var(--text-muted)]", inline && "sr-only")}>
                {legend}
            </span>
            <div
                role="radiogroup"
                aria-labelledby={legendId}
                aria-describedby={description ? descriptionId : undefined}
                title={inline && description ? description.toLowerCase() : undefined}
                // On a TV the remote's arrows move between stops and Enter chooses, so the group leaves arrows alone.
                onKeyDown={tvCards ? undefined : onKeyDown}
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
                            data-tv-card={tvCards || undefined}
                            onClick={() => onChange(choice.value)}
                            className={cn(
                                // A touch target where fingers choose; a mouse needs far less.
                                "min-h-[44px] can-hover:min-h-8 flex-auto whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-150",
                                inline && "px-2.5",
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
            {description && (
                <p id={descriptionId} className={cn("px-1 pt-0.5 text-xs text-[var(--text-muted)]", inline && "sr-only")}>
                    {description}
                </p>
            )}
        </div>
    );
}

/** A native select styled as one of the toolbar's controls. Option text is lowercased in source: CSS cannot reach it. */
function ToolbarSelect<T extends string | number>({
    label,
    choices,
    value,
    onChange,
}: {
    label: string;
    choices: Choice<T>[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <label className="relative flex items-stretch">
            <span className="sr-only">{label}</span>
            <select
                value={String(value)}
                onChange={(e) => {
                    const chosen = choices.find((c) => String(c.value) === e.target.value);
                    if (chosen) onChange(chosen.value);
                }}
                className="min-h-11 can-hover:min-h-9 cursor-pointer appearance-none rounded-lg border border-white/10 bg-white/5 pl-3 pr-8 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:border-white/20 hover:text-white focus-visible:border-brand focus-visible:outline-none [&>option]:bg-[var(--bg-secondary)] [&>option]:text-white"
            >
                {choices.map((c) => (
                    <option key={String(c.value)} value={String(c.value)}>
                        {c.label.toLowerCase()}
                    </option>
                ))}
            </select>
            <ChevronDown
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
            />
        </label>
    );
}

/** The refine controls on the toolbar line, beside a phone: show, sort and page size, and Reset once one is changed. */
export function RefineBar(props: RefineProps) {
    const { activeTab, filter, sortBy, itemsPerPage, onFilterChange, onSortChange, onItemsPerPageChange, onReset } =
        props;
    const { showFilterSection, hasRefinements, description } = useRefineState(props);
    // A TV remote moves between buttons only, and a native dropdown's list may not take it: there sort and page size
    // are switches like the filter.
    const tv = useIsTV();
    const sortChoices = sortOptionsFor(activeTab);
    const barRef = useRef<HTMLDivElement>(null);

    return (
        // Stretched, so the dropdowns stand as tall as the show switch beside them.
        <div
            ref={barRef}
            role="group"
            aria-label="Refine options"
            className="hidden min-w-0 flex-wrap items-stretch gap-2 sm:flex"
        >
            {showFilterSection && (
                <ChoiceGroup
                    legend="Show"
                    choices={FILTER_OPTIONS}
                    value={filter}
                    onChange={onFilterChange}
                    description={description}
                    inline
                    tvCards={tv}
                />
            )}
            {tv ? (
                <>
                    <ChoiceGroup
                        legend="Sort by"
                        choices={sortChoices}
                        value={sortBy}
                        onChange={onSortChange}
                        inline
                        tvCards
                    />
                    <ChoiceGroup
                        legend="Per page"
                        choices={PER_PAGE_OPTIONS.map((n) => ({ label: `${n} per page`, value: n }))}
                        value={itemsPerPage}
                        onChange={onItemsPerPageChange}
                        numeric
                        inline
                        tvCards
                    />
                </>
            ) : (
                <>
                    <ToolbarSelect
                        label="Sort by"
                        choices={sortChoices.map((o) => ({ label: `Sort: ${o.label}`, value: o.value }))}
                        value={sortBy}
                        onChange={onSortChange}
                    />
                    <ToolbarSelect
                        label="Per page"
                        choices={PER_PAGE_OPTIONS.map((n) => ({ label: `${n} per page`, value: n }))}
                        value={itemsPerPage}
                        onChange={onItemsPerPageChange}
                    />
                </>
            )}
            {hasRefinements && (
                <button
                    type="button"
                    data-tv-card={tv || undefined}
                    onClick={() => {
                        // This button goes once nothing is changed: hand focus to the row's first control first, or a
                        // keyboard or TV remote is left with nothing focused.
                        barRef.current?.querySelector<HTMLElement>('[role="radio"], select')?.focus();
                        onReset();
                    }}
                    className="min-h-[44px] can-hover:min-h-9 rounded-lg px-2.5 text-sm font-medium text-brand hover:bg-brand/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                >
                    Reset
                </button>
            )}
        </div>
    );
}

/** On a phone the toolbar line has no room for the controls: a Refine button opens them as a sheet. */
export function RefinePanel(props: RefineProps) {
    const { activeTab, filter, sortBy, itemsPerPage, onFilterChange, onSortChange, onItemsPerPageChange, onReset } =
        props;
    const { showFilterSection, changed, hasRefinements, description } = useRefineState(props);
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const close = useCallback((refocus: boolean) => {
        setOpen(false);
        if (refocus) buttonRef.current?.focus();
    }, []);

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

        // A window widened past a phone's shows the controls on the toolbar line, so the sheet goes.
        const wide = window.matchMedia?.(WIDE);
        const onWide = () => {
            if (wide?.matches) setOpen(false);
        };

        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        wide?.addEventListener?.("change", onWide);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
            wide?.removeEventListener?.("change", onWide);
        };
    }, [open, close]);

    // The sheet is drawn at the end of the page, so the page's Tab order cannot reach it: opening it moves focus to the
    // chosen sort, and Tab past either end closes it and returns to the button, from where Tab carries on.
    useEffect(() => {
        if (open) panelRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
    }, [open]);

    const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Tab") return;
        const stops = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not([tabindex='-1'])") ?? [])];
        const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
        if (document.activeElement === edge) {
            e.preventDefault();
            close(true);
        }
    };

    const panel = (
        <>
            {/* The sheet covers the page; the scrim says the page behind is not live. */}
            <div aria-hidden className="fixed inset-0 z-(--z-dropdown) bg-black/50 animate-fade-in" />
            <div
                id="refine-panel"
                ref={panelRef}
                role="dialog"
                aria-modal
                aria-label="Refine options"
                onKeyDown={onPanelKeyDown}
                // Tabbing out of the sheet closes it, as tapping outside does.
                onBlur={(e) => {
                    const next = e.relatedTarget as Node | null;
                    if (next && !panelRef.current?.contains(next) && !buttonRef.current?.contains(next)) close(false);
                }}
                // Along the bottom edge, clear of the home indicator.
                className="fixed inset-x-0 bottom-0 z-(--z-dropdown) flex max-h-[80dvh] flex-col overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] animate-panel-up"
            >
                <div className="sticky top-0 z-(--z-raised) -mx-4 flex min-h-[44px] items-center justify-between bg-[var(--bg-secondary)] px-2 pt-1">
                    {hasRefinements ? (
                        <button
                            type="button"
                            onClick={() => {
                                // This button goes once nothing is changed: keep focus in the sheet, on the sort.
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
                    <Button variant="icon" aria-label="Close refine panel" onClick={() => close(true)}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>

                <div className="flex flex-col gap-4">
                    <ChoiceGroup
                        legend="Sort by"
                        choices={sortOptionsFor(activeTab)}
                        value={sortBy}
                        onChange={onSortChange}
                    />

                    {showFilterSection && (
                        <ChoiceGroup
                            legend="Show"
                            choices={FILTER_OPTIONS}
                            value={filter}
                            onChange={onFilterChange}
                            description={description}
                        />
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
        <div className="relative sm:hidden">
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
