"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { Mic2, Search, Plus, RefreshCw, Rss, X, Loader2 } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { Pagination } from "@/components/ui/Pagination";
import { usePodcastsQuery, useTopPodcastsQuery, queryKeys } from "@/hooks/useQueries";
import Image from "next/image";
import { cn } from "@/utils/cn";

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

interface SearchResult {
    type?: string;
    id: number | string;
    name?: string;
    artist?: string;
    title?: string;
    author?: string;
    coverUrl: string;
    feedUrl: string | null;
    trackCount?: number;
    itunesId?: number | null;
}

function PodcastCard({
    podcast,
    onClick,
    index,
}: {
    podcast: { id: string; title: string; author: string; coverUrl?: string; episodeCount?: number };
    onClick: () => void;
    index: number;
}) {
    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
    return (
        <button
            onClick={onClick}
            data-tv-card
            data-tv-card-index={index}
            tabIndex={0}
            className="group text-left bg-[var(--bg-primary)] border border-white/10 rounded-lg overflow-hidden hover:border-[#3b82f6]/40 hover:shadow-lg hover:shadow-[#3b82f6]/10 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
            <div className="relative w-full aspect-square bg-[var(--bg-secondary)] overflow-hidden">
                {imageUrl ? (
                    <Image
                        src={imageUrl}
                        alt={podcast.title}
                        fill
                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                        className="object-cover group-hover:scale-105 transition-transform duration-150"
                        unoptimized
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <Mic2 className="w-12 h-12 text-[var(--text-muted)]" />
                    </div>
                )}
            </div>
            <div className="p-3">
                <h3 className="text-sm font-bold text-white truncate tracking-tight">
                    {podcast.title}
                </h3>
                <p className="text-xs tabular-nums text-[var(--text-muted)] truncate mt-0.5">
                    {podcast.author}
                </p>
            </div>
            <div className={cn(
                "h-0.5 bg-gradient-to-r from-[#3b82f6] to-[#2563eb]",
                "transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150 origin-center"
            )} />
        </button>
    );
}

function SectionHeader({
    title,
    count,
    rightAction,
}: {
    title: string;
    count?: number;
    rightAction?: React.ReactNode;
}) {
    return (
        <h2 className="text-2xl font-bold tracking-tight flex items-center gap-3 mb-6">
            <span className="w-1 h-8 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
            <span className="tracking-tight">{title}</span>
            {count !== undefined && (
                <span className="text-xs tabular-nums text-[#3b82f6]">
                    {count}
                </span>
            )}
            <span className="flex-1 border-t border-white/10" />
            {rightAction}
        </h2>
    );
}

export default function PodcastsPage() {
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const { isAuthenticated } = useAuth();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [showRssInput, setShowRssInput] = useState(false);
    const [rssUrl, setRssUrl] = useState("");
    const [isSubscribingRss, setIsSubscribingRss] = useState(false);
    const [rssError, setRssError] = useState<string | null>(null);

    const { data: podcasts = [], isLoading: isLoadingPodcasts } =
        usePodcastsQuery();
    const { data: topPodcasts = [], isLoading: isLoadingTopPodcasts } =
        useTopPodcastsQuery(12);

    const { data: relatedPodcasts = {} } = useQuery({
        queryKey: ["podcasts", "discovery", "genres"],
        queryFn: async () => {
            const genreIds = [1303, 1324, 1489, 1488, 1321, 1545, 1502];
            return api.getPodcastsByGenre(genreIds);
        },
        staleTime: 10 * 60 * 1000,
        enabled: isAuthenticated,
    });

    type SortOption = "title" | "author" | "recent";
    const [sortBy, setSortBy] = useState<SortOption>("title");
    const [itemsPerPage, setItemsPerPage] = useState<number>(50);
    const [currentPage, setCurrentPage] = useState(1);

    const isLoading = isLoadingPodcasts || isLoadingTopPodcasts;
    const [isRefreshingAll, setIsRefreshingAll] = useState(false);

    const handleRefreshAll = async () => {
        setIsRefreshingAll(true);
        try {
            await api.refreshAllPodcasts();
            queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
        } catch (error) {
            console.error("Failed to refresh podcasts:", error);
            toast.error(`Failed to refresh podcasts: ${error instanceof Error ? error.message : "Unknown error"}`);
        } finally {
            setIsRefreshingAll(false);
        }
    };

    const handleRssSubscribe = async () => {
        const url = rssUrl.trim();
        if (!url) return;

        try {
            new URL(url);
        } catch {
            setRssError("Please enter a valid URL");
            return;
        }

        setIsSubscribingRss(true);
        setRssError(null);
        try {
            const result = await api.subscribePodcast(url);
            if (result.success && result.podcast?.id) {
                queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
                router.push(`/podcasts/${result.podcast.id}`);
            }
            setRssUrl("");
            setShowRssInput(false);
        } catch (error: unknown) {
            setRssError(error instanceof Error ? error.message : "Failed to subscribe");
        } finally {
            setIsSubscribingRss(false);
        }
    };

    const sortedPodcasts = useMemo(() => {
        const sorted = [...podcasts];
        switch (sortBy) {
            case "title":
                sorted.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
                break;
            case "author":
                sorted.sort((a, b) => (a.author || "").localeCompare(b.author || ""));
                break;
            case "recent":
                sorted.sort((a, b) => (b.episodeCount || 0) - (a.episodeCount || 0));
                break;
        }
        return sorted;
    }, [podcasts, sortBy]);

    const totalPages = Math.ceil(sortedPodcasts.length / itemsPerPage);
    const paginatedPodcasts = useMemo(() => {
        const start = (currentPage - 1) * itemsPerPage;
        return sortedPodcasts.slice(start, start + itemsPerPage);
    }, [sortedPodcasts, currentPage, itemsPerPage]);

    useEffect(() => {
        setCurrentPage(1);
    }, [sortBy]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(event.target as Node)
            ) {
                setShowDropdown(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    useEffect(() => {
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (searchQuery.trim().length < 2) {
            setSearchResults([]);
            setShowDropdown(false);
            return;
        }

        setIsSearching(true);
        searchTimeoutRef.current = setTimeout(async () => {
            try {
                const results = await api.discoverSearch(searchQuery, "podcasts", 8);
                const podcastResults =
                    results?.results?.filter(
                        (r: { type: string }) => r.type === "podcast"
                    ) || [];
                setSearchResults(podcastResults);
                setShowDropdown(podcastResults.length > 0);
            } catch (error) {
                console.error("Podcast search failed:", error);
                setSearchResults([]);
                setShowDropdown(false);
            } finally {
                setIsSearching(false);
            }
        }, 500);

        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery]);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <div className="min-h-screen relative bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Atmospheric overlay */}
            <div className="fixed inset-0 pointer-events-none opacity-50">
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-transparent" />
            </div>

            <div className="relative">
                {/* Editorial Hero */}
                <div className="relative bg-gradient-to-b from-[#0a0a0a] via-[#0f0f0f] to-transparent pt-6 pb-8 px-4 sm:px-6 md:px-8 border-b border-white/5">
                    <div className="max-w-[1800px] mx-auto">
                        {/* System status */}
                        <div className="flex items-center gap-2 mb-6">
                            <div className="w-1.5 h-1.5 bg-[#3b82f6] rounded-full" />
                            <span className="t-eyebrow">
                                Podcast Library
                            </span>
                        </div>

                        <div className="flex items-end justify-between flex-wrap gap-4">
                            <div>
                                <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-none mb-3">
                                    Pod<br />
                                    <span className="text-[#3b82f6]">casts</span>
                                </h1>
                                <p className="text-sm text-[var(--text-muted)]">
                                    Subscribe, discover, and listen
                                </p>
                                <div className="mt-3">
                                    {showRssInput ? (
                                        <div className="flex gap-2 items-start">
                                            <div className="flex-1">
                                                <div className="flex gap-2">
                                                    <input
                                                        type="url"
                                                        value={rssUrl}
                                                        onChange={(e) => { setRssUrl(e.target.value); setRssError(null); }}
                                                        onKeyDown={(e) => e.key === "Enter" && handleRssSubscribe()}
                                                        placeholder="https://example.com/feed.xml"
                                                        className="flex-1 px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-[#3b82f6] text-sm"
                                                        autoFocus
                                                    />
                                                    <button
                                                        onClick={handleRssSubscribe}
                                                        disabled={isSubscribingRss || !rssUrl.trim()}
                                                        className="px-4 py-2.5 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-2 transition-all whitespace-nowrap"
                                                    >
                                                        {isSubscribingRss ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                                        Subscribe
                                                    </button>
                                                    <button
                                                        onClick={() => { setShowRssInput(false); setRssUrl(""); setRssError(null); }}
                                                        aria-label="Cancel RSS input"
                                                        className="p-2.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-all"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                                {rssError && <p className="text-red-400 text-xs mt-1">{rssError}</p>}
                                            </div>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => setShowRssInput(true)}
                                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all text-xs"
                                            title="Add podcast by RSS feed URL"
                                        >
                                            <Rss className="w-3.5 h-3.5" />
                                            <span className="hidden md:inline">Add RSS Feed</span>
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Search + Stats */}
                            <div className="flex items-center gap-4">
                                {podcasts.length > 0 && (
                                    <div className="border-2 border-white/10 bg-[var(--bg-primary)] px-4 py-3 rounded hidden sm:block">
                                        <span className="text-3xl font-bold tabular-nums text-[#3b82f6]">
                                            {podcasts.length}
                                        </span>
                                        <span className="text-xs text-[var(--text-muted)] ml-2">
                                            subscribed
                                        </span>
                                    </div>
                                )}

                                {/* Search */}
                                <div className="relative w-64 md:w-80" ref={dropdownRef}>
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] z-10" />
                                    <input
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="Quick add..."
                                        role="combobox"
                                        aria-expanded={showDropdown}
                                        aria-controls="podcast-search-listbox"
                                        aria-label="Search podcasts to subscribe"
                                        aria-autocomplete="list"
                                        className="w-full pl-10 pr-4 py-2.5 bg-[var(--bg-primary)] border-2 border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-[#3b82f6]/50 transition-all text-sm tabular-nums"
                                    />
                                    {isSearching && (
                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 z-10">
                                            <GradientSpinner size="sm" />
                                        </div>
                                    )}

                                    {/* Search Dropdown */}
                                    {showDropdown && searchResults.length > 0 && (
                                        <div
                                            id="podcast-search-listbox"
                                            role="listbox"
                                            aria-label="Podcast search results"
                                            className="absolute top-full left-0 mt-2 w-full bg-[var(--bg-secondary)] border-2 border-white/10 rounded-lg shadow-2xl overflow-hidden z-50 max-h-96 overflow-y-auto"
                                        >
                                            {searchResults.map((result) => {
                                                const imageUrl = getProxiedImageUrl(result.coverUrl);
                                                return (
                                                    <div
                                                        key={result.id}
                                                        role="option"
                                                        aria-selected={false}
                                                        className="flex items-center gap-3 p-3 hover:bg-white/5 transition-colors cursor-pointer border-b border-white/5 last:border-b-0"
                                                        onClick={() => {
                                                            router.push(`/podcasts/${result.id}`);
                                                            setShowDropdown(false);
                                                        }}
                                                    >
                                                        <div className="w-10 h-10 rounded-lg bg-[var(--bg-primary)] flex-shrink-0 overflow-hidden relative border border-white/10">
                                                            {imageUrl ? (
                                                                <Image
                                                                    src={imageUrl}
                                                                    alt={result.name || "Podcast"}
                                                                    fill
                                                                    sizes="40px"
                                                                    className="object-cover"
                                                                    unoptimized
                                                                />
                                                            ) : (
                                                                <div className="w-full h-full flex items-center justify-center">
                                                                    <Mic2 className="w-4 h-4 text-[var(--text-muted)]" />
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <h3 className="text-sm font-bold text-white truncate tracking-tight">
                                                                {result.name}
                                                            </h3>
                                                            <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                                                                {result.artist}
                                                            </p>
                                                        </div>
                                                        <div className="flex-shrink-0">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    router.push(`/podcasts/${result.id}`);
                                                                    setShowDropdown(false);
                                                                }}
                                                                aria-label={`Subscribe to ${result.name}`}
                                                                className="min-h-[44px] min-w-[44px] rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] flex items-center justify-center transition-colors"
                                                            >
                                                                <Plus className="w-3.5 h-3.5 text-white" />
                                                            </button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {showDropdown &&
                                        searchResults.length === 0 &&
                                        !isSearching &&
                                        searchQuery.length >= 2 && (
                                            <div className="absolute top-full left-0 mt-2 w-full bg-[var(--bg-secondary)] border-2 border-white/10 rounded-lg shadow-2xl p-4 z-50">
                                                <p className="text-xs text-[var(--text-muted)] text-center">
                                                    No podcasts found
                                                </p>
                                            </div>
                                        )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 md:px-8 pb-32 pt-8">
                    <div className="section-stack">
                        {/* My Podcasts */}
                        {podcasts.length > 0 && (
                            <section>
                                <SectionHeader
                                    title="My Podcasts"
                                    count={podcasts.length}
                                    rightAction={
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={handleRefreshAll}
                                                disabled={isRefreshingAll}
                                                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all text-xs disabled:opacity-50"
                                                title="Check all podcasts for new episodes"
                                            >
                                                <RefreshCw className={cn("w-3.5 h-3.5", isRefreshingAll && "animate-spin")} />
                                                <span className="hidden md:inline">{isRefreshingAll ? "Refreshing..." : "Refresh All"}</span>
                                            </button>
                                            <select
                                                value={sortBy}
                                                onChange={(e) => setSortBy(e.target.value as SortOption)}
                                                aria-label="Sort podcasts"
                                                className="px-3 py-1.5 bg-[var(--bg-primary)] border-2 border-white/10 rounded-lg text-white text-xs focus:outline-none focus:border-[#3b82f6]/50 [&>option]:bg-[var(--bg-primary)] [&>option]:text-white cursor-pointer"
                                            >
                                                <option value="title">Title</option>
                                                <option value="author">Author</option>
                                                <option value="recent">Episodes</option>
                                            </select>
                                            <select
                                                value={itemsPerPage}
                                                onChange={(e) => {
                                                    setItemsPerPage(Number(e.target.value));
                                                    setCurrentPage(1);
                                                }}
                                                aria-label="Podcasts per page"
                                                className="px-3 py-1.5 bg-[var(--bg-primary)] border-2 border-white/10 rounded-lg text-white text-xs tabular-nums focus:outline-none focus:border-[#3b82f6]/50 [&>option]:bg-[var(--bg-primary)] [&>option]:text-white cursor-pointer"
                                            >
                                                <option value={25}>25</option>
                                                <option value={50}>50</option>
                                                <option value={100}>100</option>
                                                <option value={250}>250</option>
                                            </select>
                                        </div>
                                    }
                                />
                                <div
                                    className="grid-media"
                                    data-tv-section="my-podcasts"
                                >
                                    {paginatedPodcasts.map((podcast, index) => (
                                        <PodcastCard
                                            key={podcast.id}
                                            podcast={podcast}
                                            onClick={() => router.push(`/podcasts/${podcast.id}`)}
                                            index={index}
                                        />
                                    ))}
                                </div>

                                <Pagination
                                    currentPage={currentPage}
                                    totalPages={totalPages}
                                    onPageChange={setCurrentPage}
                                    label="My podcasts"
                                    className="mt-8"
                                />
                            </section>
                        )}

                        {/* Top Podcasts */}
                        {topPodcasts.length > 0 && (
                            <section>
                                <SectionHeader title="Top Podcasts" />
                                <div
                                    className="grid-media"
                                    data-tv-section="top-podcasts"
                                >
                                    {topPodcasts.map((podcast, index) => (
                                        <PodcastCard
                                            key={podcast.id}
                                            podcast={podcast}
                                            onClick={() => router.push(`/podcasts/${podcast.id}`)}
                                            index={index}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* Genre Discovery */}
                        {[
                            { id: "1303", name: "Comedy" },
                            { id: "1324", name: "Society & Culture" },
                            { id: "1489", name: "News" },
                            { id: "1488", name: "True Crime" },
                            { id: "1321", name: "Business" },
                            { id: "1545", name: "Sports" },
                            { id: "1502", name: "Leisure" },
                        ].map(({ id: genreId, name: genreName }) => {
                            const genrePodcasts = relatedPodcasts[genreId] || [];
                            return genrePodcasts.length > 0 ? (
                                <section
                                    key={genreId}
                                   
                                   
                                >
                                    <SectionHeader
                                        title={genreName}
                                        rightAction={
                                            <button
                                                onClick={() => router.push(`/podcasts/genre/${genreId}`)}
                                                className="text-xs text-[var(--text-muted)] hover:text-[#3b82f6] transition-colors"
                                            >
                                                View All
                                            </button>
                                        }
                                    />
                                    <div
                                        className="grid-media"
                                        data-tv-section={`genre-${genreId}`}
                                    >
                                        {genrePodcasts.map((podcast: { id: string; title: string; author: string; coverUrl?: string; episodeCount?: number }, index: number) => (
                                            <PodcastCard
                                                key={podcast.id}
                                                podcast={podcast}
                                                onClick={() => router.push(`/podcasts/${podcast.id}`)}
                                                index={index}
                                            />
                                        ))}
                                    </div>
                                </section>
                            ) : null;
                        })}

                        {/* Empty State */}
                        {podcasts.length === 0 && topPodcasts.length === 0 && (
                            <section>
                                <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-12">
                                    <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-[#3b82f6] to-[#2563eb]" />
                                    <div className="flex flex-col items-center text-center">
                                        <Mic2 className="w-16 h-16 text-[var(--text-muted)] mb-6" />
                                        <h2 className="text-2xl font-bold tracking-tight text-white mb-2">
                                            Discover Podcasts
                                        </h2>
                                        <p className="text-sm text-[var(--text-muted)] max-w-md">
                                            Search for podcasts above to subscribe and start listening
                                        </p>
                                    </div>
                                </div>
                            </section>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
