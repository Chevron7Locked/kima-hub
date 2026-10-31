"use client";

import { Shuffle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useIsTV } from "@/lib/tv-utils";
import { LibraryFilter, SortOption } from "@/hooks/useQueries";
import { Tab } from "../types";
import { RefineBar, RefinePanel } from "./RefinePanel";

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
    const refine = {
        activeTab,
        filter,
        sortBy,
        itemsPerPage,
        onFilterChange,
        onSortChange,
        onItemsPerPageChange,
        onReset,
    };
    const tv = useIsTV();
    return (
        // A section of its own for the TV remote, between the tabs and the grid: the refine choices, then shuffle.
        <div data-tv-section="library-refine" className="flex grow items-center gap-3 in-[.tv-mode]:basis-full">
            {/* The controls sit on this line beside a phone; on a phone they open from a Refine button. */}
            <RefineBar {...refine} />
            <RefinePanel {...refine} />

            <Button
                variant="primary"
                size="sm"
                onClick={onShuffleLibrary}
                aria-label="Shuffle entire library"
                data-tv-card={tv || undefined}
                className="ml-auto min-w-[44px] px-2.5"
            >
                <Shuffle className="w-4 h-4" />
            </Button>
        </div>
    );
}
