"use client";

import { cn } from "@/lib/cn";
import { tabListKeyDown } from "@/lib/tabListKeys";

/**
 * The side panels' shared parts: a round control, the "you are here" mark, and a strip of text options where amber
 * marks the current one.
 */
/** A small round control for a panel heading, like the top bar's: it brightens on hover and carries no box. */
export const panelIconButton =
    "flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors duration-150 hover:text-white focus-visible:ring-2 focus-visible:ring-brand/60 disabled:pointer-events-none disabled:opacity-40";

/** The one "you are here" mark, as on a playing song's row: a short amber bar at the panel's edge. The parent sets the amber text. */
export const panelCurrentBar =
    "relative before:absolute before:-left-2 before:inset-y-2.5 before:w-[3px] before:rounded-full before:bg-brand";

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
 * Text options that switch what a panel half shows. They are tabs to assistive technology; to the eye, words, the current one
 * in amber.
 */
export function PanelOptions<K extends string>({
    options,
    value,
    onChange,
    label,
    controls,
    className,
    quiet = false,
}: {
    options: PanelOption<K>[];
    /** The chosen option; null while the region shows something none of them names (a page's settings). */
    value: K | null;
    onChange: (key: K) => void;
    label: string;
    /** The id of the region the options switch, for aria-controls. */
    controls: string;
    className?: string;
    /** A secondary strip, such as the panel's foot: smaller than the options that switch the content. */
    quiet?: boolean;
}) {
    return (
        <div
            role="tablist"
            aria-label={label}
            onKeyDown={(e) => tabListKeyDown(e, options.map((o) => o.key), value ?? options[0]?.key ?? ("" as K), onChange)}
            className={cn("flex shrink-0 items-center gap-4 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
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
                            "flex shrink-0 items-center gap-1 outline-none transition-colors duration-150",
                            quiet ? "h-9 text-xs font-medium" : "h-10 text-sm font-medium",
                            "focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-brand/60",
                            current
                                ? "text-brand"
                                : "text-[var(--text-secondary)] hover:text-white",
                        )}
                    >
                        <span>{option.label}</span>
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
