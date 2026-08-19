import { Download } from "lucide-react";
import { cn } from "@/utils/cn";
import { FilterTab } from "../types";

interface SearchFiltersProps {
    filterTab: FilterTab;
    onFilterChange: (tab: FilterTab) => void;
    soulseekEnabled: boolean;
    hasSearched: boolean;
    soulseekResultCount?: number;
}

export function SearchFilters({
    filterTab,
    onFilterChange,
    soulseekEnabled,
    hasSearched,
    soulseekResultCount,
}: SearchFiltersProps) {
    if (!hasSearched) {
        return null;
    }

    const filters: Array<{
        id: FilterTab;
        label: string;
        icon?: React.ReactNode;
        count?: number;
    }> = [
        {
            id: "all",
            label: "All Results",
        },
        {
            id: "library",
            label: "Library",
        },
        {
            id: "discover",
            label: "Discover",
        },
    ];

    if (soulseekEnabled) {
        filters.push({
            id: "soulseek",
            label: "P2P Network",
            icon: <Download className="w-4 h-4" />,
            count: soulseekResultCount,
        });
    }

    return (
        // Same segmented control as the library tabs. This file carried an
        // identical copy of the old treatment -- glass panel, per-filter
        // gradient, permanent shimmer, scale-105 on active and hover -- so it
        // gets the identical fix rather than a second look.
        <div className="relative">
            <div
                className="inline-flex flex-wrap items-center gap-1 rounded-xl bg-white/5 p-1"
                data-tv-section="search-filters"
            >
                {filters.map((filter, index) => {
                    const isActive = filterTab === filter.id;

                    return (
                        <button
                            key={filter.id}
                            data-tv-card
                            data-tv-card-index={index}
                            tabIndex={0}
                            onClick={() => onFilterChange(filter.id)}
                            className={cn(
                                "flex items-center gap-2 rounded-lg px-3 sm:px-4 py-2 min-h-[44px] text-sm font-medium transition-colors duration-150",
                                isActive
                                    ? "bg-brand text-black"
                                    : "text-[var(--text-secondary)] hover:text-white hover:bg-white/5",
                            )}
                        >
                            <span className="relative z-(--z-raised) flex items-center gap-2">
                                {filter.icon}
                                {filter.label}
                                {filter.count != null && filter.count > 0 && (
                                    <span
                                        className={cn(
                                            "px-2 py-0.5 text-xs font-semibold rounded-full",
                                            isActive
                                                ? "bg-black/20 text-black"
                                                : "bg-white/10 text-[var(--text-primary)]"
                                        )}
                                    >
                                        {filter.count}
                                    </span>
                                )}
                            </span>

                        </button>
                    );
                })}
            </div>
        </div>
    );
}
