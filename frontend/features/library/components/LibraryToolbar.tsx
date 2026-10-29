"use client";

import { Shuffle } from "lucide-react";
import { Button } from "@/components/ui/Button";
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
    onReset: () => void;
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
    onReset,
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
                onReset={onReset}
            />

            <Button
                variant="primary"
                size="sm"
                onClick={onShuffleLibrary}
                aria-label="Shuffle entire library"
                className="ml-auto min-w-[44px] px-2.5"
            >
                <Shuffle className="w-4 h-4" />
            </Button>
        </div>
    );
}
