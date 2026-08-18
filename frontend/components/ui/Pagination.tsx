"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/utils/cn";

interface PaginationProps {
    currentPage: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    /** Disables every control, e.g. while the next page is still loading. */
    disabled?: boolean;
    /**
     * What is being paged, in the user's words -- "Artists", "Podcasts".
     * Read aloud as "Artists pagination", so two paginated sections on one
     * page are tellable apart by a screen reader.
     */
    label: string;
    className?: string;
}

const CONTROL =
    "flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg border " +
    "border-white/10 bg-white/5 text-[var(--text-secondary)] transition-colors " +
    "hover:text-white hover:bg-white/10 hover:border-white/20 " +
    "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-gray-400 " +
    "disabled:hover:bg-white/5 disabled:hover:border-white/10 " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]";

/**
 * One pager for every paginated list.
 *
 * Collection, Podcasts and Audiobooks each carried a hand-rolled version of
 * this, and all three differed: Collection had text First/Prev/Next/Last in
 * bold tracked capitals inside a double-bordered box, Podcasts mixed text and
 * chevrons with a blue accent, Audiobooks offered only prev/next with no way
 * to jump to either end. None of the three named its buttons for a screen
 * reader, none announced the page change, and every control sat around 32px
 * against a 44px touch-target floor.
 */
export function Pagination({
    currentPage,
    totalPages,
    onPageChange,
    disabled = false,
    label,
    className,
}: PaginationProps) {
    if (totalPages <= 1) {
        return null;
    }

    const atFirst = currentPage <= 1;
    const atLast = currentPage >= totalPages;

    return (
        <nav
            aria-label={`${label} pagination`}
            className={cn(
                "flex items-center justify-center gap-2 pt-6 mt-12 border-t border-white/5",
                className,
            )}
        >
            <button
                type="button"
                onClick={() => onPageChange(1)}
                disabled={disabled || atFirst}
                aria-label="First page"
                className={CONTROL}
            >
                <ChevronsLeft className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
                type="button"
                onClick={() => onPageChange(Math.max(1, currentPage - 1))}
                disabled={disabled || atFirst}
                aria-label="Previous page"
                className={CONTROL}
            >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            </button>

            {/* Announced on change, so the page number is not a purely visual cue. */}
            <p
                aria-live="polite"
                aria-atomic="true"
                className="px-3 text-sm text-[var(--text-secondary)] tabular-nums whitespace-nowrap"
            >
                Page <span className="text-white font-medium">{currentPage}</span> of{" "}
                <span className="text-white font-medium">{totalPages}</span>
            </p>

            <button
                type="button"
                onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
                disabled={disabled || atLast}
                aria-label="Next page"
                className={CONTROL}
            >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
                type="button"
                onClick={() => onPageChange(totalPages)}
                disabled={disabled || atLast}
                aria-label="Last page"
                className={CONTROL}
            >
                <ChevronsRight className="w-4 h-4" aria-hidden="true" />
            </button>
        </nav>
    );
}
