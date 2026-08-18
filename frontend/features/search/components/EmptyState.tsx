import { Search as SearchIcon } from "lucide-react";

interface EmptyStateProps {
    hasSearched: boolean;
    isLoading: boolean;
}

export function EmptyState({ hasSearched, isLoading }: EmptyStateProps) {
    // Don't show empty state while loading or if search has been performed
    if (isLoading || hasSearched) {
        return null;
    }

    return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
            <SearchIcon className="w-16 h-16 text-[var(--text-muted)] mb-4" />
            <h3 className="text-xl font-bold text-white mb-2">Search your library</h3>
            <p className="text-[var(--text-secondary)]">Use the search bar above to find music, artists, and albums</p>
        </div>
    );
}
