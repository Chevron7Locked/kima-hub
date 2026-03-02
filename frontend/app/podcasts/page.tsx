"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Mic2, Search, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { usePodcastsQuery, useTopPodcastsQuery } from "@/hooks/useQueries";
import Image from "next/image";
import { cn } from "@/utils/cn";

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

interface SearchResult {
    type?: string;
    id: number;
    name?: string;
    artist?: string;
    title?: string;
    author?: string;
    coverUrl: string;
    feedUrl: string;
    trackCount?: number;
    itunesId?: number;
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
            className="group text-left bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#3b82f6]/40 hover:shadow-lg hover:shadow-[#3b82f6]/10 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
            <div className="relative w-full aspect-square bg-[#0f0f0f] overflow-hidden">
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
                        <Mic2 className="w-12 h-12 text-gray-700" />
                    </div>
                )}
            </div>
            <div className="p-3">
                <h3 className="text-sm font-black text-white truncate tracking-tight">
                    {podcast.title}
                </h3>
                <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider truncate mt-0.5">
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
        <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
            <span className="w-1 h-8 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
            <span className="uppercase tracking-tighter">{title}</span>
            {count !== undefined && (
                <span className="text-xs font-mono text-[#3b82f6]">
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

    const sortedPodcasts = useMemo(() => {
        const sorted = [...podcasts];
        switch (sortBy) {
            case "title":
                sorted.sort((a, b) => a.title.localeCompare(b.title));
                break;
            case "author":
                sorted.sort((a, b) => a.author.localeCompare(b.author));
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
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
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
                            <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                                Podcast Library
                            </span>
                        </div>

                        <div className="flex items-end justify-between flex-wrap gap-4">
                            <div>
                                <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter text-white leading-none mb-3">
                                    POD<br />
                                    <span className="text-[#3b82f6]">CASTS</span>
                                </h1>
                                <p className="text-sm font-mono text-gray-500">
                                    Subscribe, discover, and listen
                                </p>
                            </div>

                            {/* Search + Stats */}
                            <div className="flex items-center gap-4">
                                {podcasts.length > 0 && (
                                    <div className="border-2 border-white/10 bg-[#0a0a0a] px-4 py-3 rounded hidden sm:block">
                                        <span className="text-3xl font-black font-mono text-[#3b82f6]">
                                            {podcasts.length}
                                        </span>
                                        <span className="text-xs font-mono text-gray-500 uppercase ml-2">
                                            subscribed
                                        </span>
                                    </div>
                                )}

                                {/* Search */}
                                <div className="relative w-64 md:w-80" ref={dropdownRef}>
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 z-10" />
                                    <input
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="Quick add..."
                                        className="w-full pl-10 pr-4 py-2.5 bg-[#0a0a0a] border-2 border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-[#3b82f6]/50 transition-all text-sm font-mono"
                                    />
                                    {isSearching && (
                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 z-10">
                                            <GradientSpinner size="sm" />
                                        </div>
                                    )}

                                    {/* Search Dropdown */}
                                    {showDropdown && searchResults.length > 0 && (
                                        <div className="absolute top-full left-0 mt-2 w-full bg-[#0f0f0f] border-2 border-white/10 rounded-lg shadow-2xl overflow-hidden z-50 max-h-96 overflow-y-auto">
                                            {searchResults.map((result) => {
                                                const imageUrl = getProxiedImageUrl(result.coverUrl);
                                                return (
                                                    <div
                                                        key={result.id}
                                                        className="flex items-center gap-3 p-3 hover:bg-white/5 transition-colors cursor-pointer border-b border-white/5 last:border-b-0"
                                                        onClick={() => {
                                                            router.push(`/podcasts/${result.id}`);
                                                            setShowDropdown(false);
                                                        }}
                                                    >
                                                        <div className="w-10 h-10 rounded-lg bg-[#0a0a0a] flex-shrink-0 overflow-hidden relative border border-white/10">
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
                                                                    <Mic2 className="w-4 h-4 text-gray-600" />
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <h3 className="text-sm font-black text-white truncate tracking-tight">
                                                                {result.name}
                                                            </h3>
                                                            <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider truncate">
                                                                {result.artist}
                                                            </p>
                                                        </div>
                                                        <div className="flex-shrink-0">
                                                            <div className="w-7 h-7 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] flex items-center justify-center transition-colors">
                                                                <Plus className="w-3.5 h-3.5 text-white" />
                                                            </div>
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
                                            <div className="absolute top-full left-0 mt-2 w-full bg-[#0f0f0f] border-2 border-white/10 rounded-lg shadow-2xl p-4 z-50">
                                                <p className="text-xs font-mono text-gray-500 text-center uppercase tracking-wider">
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
                    <div className="space-y-12">
                        {/* My Podcasts */}
                        {podcasts.length > 0 && (
                            <section>
                                <SectionHeader
                                    title="My Podcasts"
                                    count={podcasts.length}
                                    rightAction={
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={sortBy}
                                                onChange={(e) => setSortBy(e.target.value as SortOption)}
                                                className="px-3 py-1.5 bg-[#0a0a0a] border-2 border-white/10 rounded-lg text-white text-xs font-mono uppercase tracking-wider focus:outline-none focus:border-[#3b82f6]/50 [&>option]:bg-[#0a0a0a] [&>option]:text-white cursor-pointer"
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
                                                className="px-3 py-1.5 bg-[#0a0a0a] border-2 border-white/10 rounded-lg text-white text-xs font-mono uppercase tracking-wider focus:outline-none focus:border-[#3b82f6]/50 [&>option]:bg-[#0a0a0a] [&>option]:text-white cursor-pointer"
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
                                    className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
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

                                {/* Pagination */}
                                {totalPages > 1 && (
                                    <div className="flex items-center justify-center gap-1 mt-8 pt-4 border-t border-white/10">
                                        <button
                                            onClick={() => setCurrentPage(1)}
                                            disabled={currentPage === 1}
                                            className="px-3 py-2 text-xs font-mono uppercase tracking-wider text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                        >
                                            First
                                        </button>
                                        <button
                                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                            disabled={currentPage === 1}
                                            className="p-2 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                        >
                                            <ChevronLeft className="w-4 h-4" />
                                        </button>
                                        <span className="px-4 py-2 text-xs font-mono text-white">
                                            <span className="text-[#3b82f6] font-black">{currentPage}</span>
                                            <span className="text-gray-500 mx-1">/</span>
                                            <span className="text-gray-500">{totalPages}</span>
                                        </span>
                                        <button
                                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                            disabled={currentPage === totalPages}
                                            className="p-2 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                        >
                                            <ChevronRight className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => setCurrentPage(totalPages)}
                                            disabled={currentPage === totalPages}
                                            className="px-3 py-2 text-xs font-mono uppercase tracking-wider text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                        >
                                            Last
                                        </button>
                                    </div>
                                )}
                            </section>
                        )}

                        {/* Top Podcasts */}
                        {topPodcasts.length > 0 && (
                            <section>
                                <SectionHeader title="Top Podcasts" />
                                <div
                                    className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
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
                                                className="text-xs font-mono uppercase tracking-wider text-gray-500 hover:text-[#3b82f6] transition-colors"
                                            >
                                                View All
                                            </button>
                                        }
                                    />
                                    <div
                                        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
                                        data-tv-section={`genre-${genreId}`}
                                    >
                                        {genrePodcasts.map((podcast, index) => (
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
                                        <Mic2 className="w-16 h-16 text-gray-700 mb-6" />
                                        <h2 className="text-2xl font-black tracking-tighter text-white mb-2 uppercase">
                                            Discover Podcasts
                                        </h2>
                                        <p className="text-sm font-mono text-gray-500 max-w-md">
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
