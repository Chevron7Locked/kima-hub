"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { tabListKeyDown } from "@/lib/tabListKeys";

/**
 * The side panels' shared grammar, as the left library panel draws it: a quiet heading with a count and room for an
 * action, and a strip of text options where amber marks the current one.
 */
export function PanelHeading({
    label,
    count,
    actions,
    className,
}: {
    label: string;
    count?: number;
    actions?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex h-11 shrink-0 items-center justify-between gap-2 pl-3 pr-1.5", className)}>
            <h2 className="flex min-w-0 items-baseline gap-2 truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-secondary)]">
                {label}
                {count !== undefined && (
                    <span className="text-[11px] font-normal tabular-nums text-[var(--text-muted)]">{count}</span>
                )}
            </h2>
            {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
        </div>
    );
}

/** A small square control for a panel heading: same size, ring and hover as the left panel's. */
export const panelIconButton =
    "flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] outline-none transition-colors duration-150 hover:bg-white/[0.06] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-brand/60 disabled:pointer-events-none disabled:opacity-40";

export interface PanelOption<K extends string> {
    key: K;
    label: string;
    /** Shown after the label when above zero, in brand amber when `urgent`. */
    count?: number;
    urgent?: boolean;
}

/** The id of a PanelOptions tab, for its tabpanel's aria-labelledby. */
export const panelTabId = (controls: string, key: string) => `${controls}-tab-${key}`;

/**
 * Text options that switch what a panel half shows. They are tabs to assistive technology; to the eye, words with a
 * short amber underline under the current one.
 */
export function PanelOptions<K extends string>({
    options,
    value,
    onChange,
    label,
    controls,
    className,
}: {
    options: PanelOption<K>[];
    /** The chosen option; null while the region shows something none of them names (a page's settings). */
    value: K | null;
    onChange: (key: K) => void;
    label: string;
    /** The id of the region the options switch, for aria-controls. */
    controls: string;
    className?: string;
}) {
    return (
        <div
            role="tablist"
            aria-label={label}
            onKeyDown={(e) => tabListKeyDown(e, options.map((o) => o.key), value ?? options[0]?.key ?? ("" as K), onChange)}
            className={cn("flex shrink-0 items-center gap-3.5 overflow-x-auto border-b border-white/[0.05] px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
        >
            {options.map((option, i) => {
                const current = option.key === value;
                const tabStop = current || (value === null && i === 0);
                return (
                    <button
                        key={option.key}
                        type="button"
                        role="tab"
                        id={panelTabId(controls, option.key)}
                        data-tab-key={option.key}
                        aria-selected={current}
                        aria-controls={controls}
                        tabIndex={tabStop ? 0 : -1}
                        onClick={() => onChange(option.key)}
                        className={cn(
                            "flex h-8 shrink-0 items-center gap-1 text-xs outline-none transition-colors duration-150",
                            "focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-brand/60",
                            current
                                ? "text-[var(--text-primary)]"
                                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                        )}
                    >
                        {/* The underline sits under the word: a touch screen widens the button to its minimum size. */}
                        <span
                            className={cn(
                                "relative self-stretch flex items-center after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:rounded-full after:transition-colors",
                                current ? "after:bg-brand" : "after:bg-transparent",
                            )}
                        >
                            {option.label}
                        </span>
                        {!!option.count && (
                            <span
                                className={cn(
                                    "text-[11px] tabular-nums",
                                    option.urgent ? "text-brand" : "text-[var(--text-muted)]",
                                )}
                            >
                                {option.count > 99 ? "99+" : option.count}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
