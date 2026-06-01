"use client";

import { Shuffle } from "lucide-react";
import { LibraryFilter, SortOption } from "@/hooks/useQueries";
import { Tab } from "../types";
import { RefinePanel } from "./RefinePanel";

interface LibraryToolbarProps {
    activeTab: Tab;
    filter: LibraryFilter;
    sortBy: SortOption;
    itemsPerPage: number;
    onFilterChange: (filter: LibraryFilter) => void;
    onSortChange: (sort: SortOption) => void;
    onItemsPerPageChange: (items: number) => void;
    onShuffleLibrary: () => void;
}

export function LibraryToolbar({
    activeTab,
    filter,
    sortBy,
    itemsPerPage,
    onFilterChange,
    onSortChange,
    onItemsPerPageChange,
    onShuffleLibrary,
}: LibraryToolbarProps) {
    return (
        <div className="flex items-center gap-3 pb-4 border-b border-white/5">
            <RefinePanel
                activeTab={activeTab}
                filter={filter}
                sortBy={sortBy}
                itemsPerPage={itemsPerPage}
                onFilterChange={onFilterChange}
                onSortChange={onSortChange}
                onItemsPerPageChange={onItemsPerPageChange}
            />

            {/* Shuffle button -- stays primary, always visible */}
            <button
                type="button"
                onClick={onShuffleLibrary}
                aria-label="Shuffle entire library"
                className="ml-auto p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[var(--color-brand)] hover:bg-[var(--color-brand-hover)] text-black transition-all hover:scale-105 hover:shadow-lg hover:shadow-[var(--color-brand)]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]"
            >
                <Shuffle className="w-4 h-4" />
            </button>
        </div>
    );
}
