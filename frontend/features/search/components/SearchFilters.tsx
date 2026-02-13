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
        gradient?: string;
    }> = [
        {
            id: "all",
            label: "All Results",
            gradient: "from-[#eab308] to-[#f59e0b]",
        },
        {
            id: "library",
            label: "Library",
            gradient: "from-[#22c55e] to-[#16a34a]",
        },
        {
            id: "discover",
            label: "Discover",
            gradient: "from-[#a855f7] to-[#9333ea]",
        },
    ];

    if (soulseekEnabled) {
        filters.push({
            id: "soulseek",
            label: "P2P Network",
            icon: <Download className="w-4 h-4" />,
            count: soulseekResultCount,
            gradient: "from-[#ec4899] to-[#db2777]",
        });
    }

    return (
        <div className="relative">
            {/* Background blur effect */}
            <div className="absolute -inset-x-4 -inset-y-2 bg-[#0a0a0a]/60 backdrop-blur-xl rounded-2xl border border-white/5" />

            {/* Filters */}
            <div
                className="relative flex flex-wrap gap-2 p-2"
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
                                "relative px-5 py-2.5 text-sm font-bold rounded-xl transition-all duration-300 flex items-center gap-2 overflow-hidden group",
                                isActive
                                    ? "text-black scale-105 shadow-lg"
                                    : "text-gray-400 hover:text-white hover:scale-105 bg-white/5 hover:bg-white/10"
                            )}
                        >
                            {/* Active gradient background */}
                            {isActive && (
                                <>
                                    <div
                                        className={cn(
                                            "absolute inset-0 bg-gradient-to-r",
                                            filter.gradient
                                        )}
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                                </>
                            )}

                            {/* Content */}
                            <span className="relative z-10 flex items-center gap-2">
                                {filter.icon}
                                {filter.label}
                                {filter.count != null && filter.count > 0 && (
                                    <span
                                        className={cn(
                                            "px-2 py-0.5 text-xs font-bold rounded-full",
                                            isActive
                                                ? "bg-black/20 text-black"
                                                : "bg-white/10 text-gray-300"
                                        )}
                                    >
                                        {filter.count}
                                    </span>
                                )}
                            </span>

                            {/* Hover effect */}
                            {!isActive && (
                                <div
                                    className={cn(
                                        "absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-r",
                                        filter.gradient
                                    )}
                                />
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
