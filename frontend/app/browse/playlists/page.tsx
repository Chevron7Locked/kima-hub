"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
    Search,
    Loader2,
    Music2,
    Link2,
    X,
    ChevronRight,
    Info,
    ArrowLeft,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

interface Genre {
    id: number;
    name: string;
    imageUrl: string | null;
}

const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

type BrowseTab = "playlists" | "genres";

function SectionHeader({
    title,
    count,
    children,
}: {
    title: string;
    count?: number;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex items-center gap-3 mb-6">
            <span className="w-1 h-8 bg-gradient-to-b from-[#a855f7] to-[#c026d3] rounded-full shrink-0" />
            <h2 className="text-2xl font-black tracking-tighter uppercase">
                {title}
            </h2>
            {count !== undefined && (
                <span className="text-xs font-mono text-[#a855f7]">
                    {count}
                </span>
            )}
            <span className="flex-1 border-t border-white/10" />
            {children}
        </div>
    );
}

export default function BrowsePlaylistsPage() {
    const router = useRouter();
    const { toast } = useToast();

    const [activeTab, setActiveTab] = useState<BrowseTab>("playlists");
    const [searchQuery, setSearchQuery] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [showUrlModal, setShowUrlModal] = useState(false);
    const [urlInput, setUrlInput] = useState("");
    const [isParsing, setIsParsing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [playlists, setPlaylists] = useState<PlaylistPreview[]>([]);
    const [genres, setGenres] = useState<Genre[]>([]);
    const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
    const [genrePlaylists, setGenrePlaylists] = useState<PlaylistPreview[]>([]);

    const fetchAllContent = useCallback(async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
                genres: Genre[];
            }>("/browse/all");
            setPlaylists(response.playlists);
            setGenres(response.genres);
        } catch (error) {
            console.error("Failed to fetch browse content:", error);
            setLoadError(
                "Couldn't load playlists. Check your connection and try again.",
            );
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchAllContent();
    }, [fetchAllContent]);

    const handleSearch = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!searchQuery.trim() || searchQuery.length < 2) {
            if (!searchQuery.trim()) setHasSearched(false);
            return;
        }

        setIsSearching(true);
        setHasSearched(true);
        setActiveTab("playlists");

        try {
            const response = await api.get<{ playlists: PlaylistPreview[] }>(
                `/browse/playlists/search?q=${encodeURIComponent(searchQuery)}&limit=100`,
            );
            setPlaylists(response.playlists);
        } catch (error) {
            console.error("Search failed:", error);
            toast.error("Failed to search playlists");
        } finally {
            setIsSearching(false);
        }
    };

    const clearSearch = () => {
        setSearchQuery("");
        setHasSearched(false);
        fetchAllContent();
    };

    const handleUrlSubmit = async () => {
        if (!urlInput.trim()) return;
        setIsParsing(true);

        try {
            const response = await api.post<{
                source: string;
                id: string;
                url: string;
            }>("/browse/playlists/parse", { url: urlInput.trim() });
            setShowUrlModal(false);
            setUrlInput("");
            router.push(
                `/import/spotify?url=${encodeURIComponent(response.url)}`,
            );
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : "Invalid playlist URL";
            toast.error(message);
        } finally {
            setIsParsing(false);
        }
    };

    const handleItemClick = (item: PlaylistPreview) => {
        router.push(`/browse/playlists/${item.id}`);
    };

    const handleGenreClick = async (genre: Genre) => {
        setSelectedGenre(genre);
        setIsLoading(true);

        try {
            const response = await api.get<{ playlists: PlaylistPreview[] }>(
                `/browse/genres/${genre.id}/playlists?limit=50`,
            );
            setGenrePlaylists(response.playlists);
        } catch (error) {
            console.error("Failed to fetch genre playlists:", error);
            toast.error("Failed to load genre playlists");
        } finally {
            setIsLoading(false);
        }
    };

    const handleBackFromGenre = () => {
        setSelectedGenre(null);
        setGenrePlaylists([]);
    };

    const renderCard = (
        item: PlaylistPreview,
        index: number,
        context?: string,
    ) => (
        <div
            key={`${item.source}-${item.type}-${item.id}-${context || "main"}-${index}`}
            onClick={() => handleItemClick(item)}
            className="group cursor-pointer"
        >
            <div className="relative aspect-square mb-2.5 rounded-lg overflow-hidden bg-[#0a0a0a] border border-white/10 group-hover:border-[#a855f7]/40 group-hover:shadow-xl group-hover:shadow-[#a855f7]/10 transition-all duration-300">
                {item.imageUrl ?
                    <Image
                        src={item.imageUrl}
                        alt={item.title}
                        fill
                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, (max-width: 1536px) 16vw, 14vw"
                        className="object-cover group-hover:scale-105 transition-transform duration-300"
                        unoptimized
                    />
                :   <div className="w-full h-full flex items-center justify-center">
                        <Music2 className="w-12 h-12 text-white/10" />
                    </div>
                }

                {/* Hover accent line */}
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#a855f7] to-[#c026d3] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-center" />
            </div>
            <h3 className="text-sm font-black text-white truncate tracking-tight">
                {item.title}
            </h3>
            <p className="text-[11px] font-mono text-white/40 truncate uppercase tracking-wider mt-0.5">
                {item.trackCount} songs -- {item.creator}
            </p>
        </div>
    );

    const renderGenreCard = (genre: Genre) => (
        <div
            key={genre.id}
            onClick={() => handleGenreClick(genre)}
            className="group cursor-pointer relative aspect-square rounded-lg overflow-hidden border border-white/10 hover:border-[#a855f7]/40 hover:shadow-xl hover:shadow-[#a855f7]/10 transition-all duration-300"
        >
            {genre.imageUrl ?
                <Image
                    src={genre.imageUrl}
                    alt={genre.name}
                    fill
                    sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                    unoptimized
                />
            :   <div className="w-full h-full bg-gradient-to-br from-[#a855f7]/30 to-[#c026d3]/10" />
            }
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
            <div className="absolute bottom-3 left-3 right-3">
                <h3 className="text-sm font-black text-white uppercase tracking-tight">
                    {genre.name}
                </h3>
            </div>

            {/* Hover accent line */}
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#a855f7] to-[#c026d3] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-center" />
        </div>
    );

    if (isLoading && !selectedGenre && !hasSearched) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    let sectionIndex = 0;

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black relative">
            {/* Atmospheric overlay */}
            <div className="fixed inset-0 pointer-events-none opacity-30">
                <div className="absolute inset-0 bg-gradient-to-br from-[#a855f7]/5 via-transparent to-transparent" />
            </div>

            {/* Editorial Hero */}
            <div className="relative px-4 md:px-8 pt-8 pb-2">
                <div className="max-w-[1800px] mx-auto">
                    <div className="flex items-center gap-2 mb-4">
                        <DeezerIcon className="w-4 h-4 text-[#a855f7]" />
                        <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                            Deezer Discovery
                        </span>
                    </div>
                    <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter text-white leading-none mb-2">
                        BROWSE
                        <br />
                        <span className="text-[#a855f7]">PLAYLISTS</span>
                    </h1>
                    <p className="text-sm font-mono text-white/40 uppercase tracking-wider">
                        Discover and import playlists from Deezer
                    </p>
                </div>
            </div>

            <div className="relative px-4 md:px-8 pb-24">
                <div className="max-w-[1800px] mx-auto">
                    {/* Beta Notice */}
                    <div
                        className="mb-6"
                       
                    >
                        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#a855f7]/5 border border-[#a855f7]/20">
                            <Info className="w-4 h-4 text-[#a855f7] shrink-0 mt-0.5" />
                            <p className="text-xs font-mono text-white/50 leading-relaxed">
                                <span className="font-black text-[#a855f7] uppercase tracking-wider">
                                    Beta
                                </span>{" "}
                                -- Importing from Spotify and Deezer relies on
                                matching tracks through Soulseek and your
                                configured indexers. Results may vary depending
                                on track availability and metadata quality.
                            </p>
                        </div>
                    </div>

                    {/* Search Bar & Import URL */}
                    <div
                        className="flex items-center gap-3 mb-6"
                       
                    >
                        <form
                            onSubmit={handleSearch}
                            className="relative flex-1 max-w-md"
                        >
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search playlists..."
                                className="w-full bg-white/5 border border-white/10 rounded-lg pl-11 pr-10 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[#a855f7]/40 transition-all font-mono"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    onClick={clearSearch}
                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-white/30 hover:text-white transition-colors"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </form>

                        <button
                            onClick={() => setShowUrlModal(true)}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs font-black uppercase tracking-wider text-white/50 hover:text-white transition-all"
                        >
                            <Link2 className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Import URL</span>
                        </button>
                    </div>

                    {/* Tabs */}
                    {!selectedGenre && !hasSearched && (
                        <div
                            className="flex items-center gap-2 mb-8"
                           
                        >
                            <button
                                onClick={() => setActiveTab("playlists")}
                                className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all ${
                                    activeTab === "playlists" ?
                                        "bg-[#a855f7] text-white"
                                    :   "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20"
                                }`}
                            >
                                Playlists
                            </button>
                            <button
                                onClick={() => setActiveTab("genres")}
                                className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all ${
                                    activeTab === "genres" ?
                                        "bg-[#a855f7] text-white"
                                    :   "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20"
                                }`}
                            >
                                Genres
                            </button>
                        </div>
                    )}

                    {/* Genre Breadcrumb */}
                    {selectedGenre && (
                        <div className="flex items-center gap-2 mb-6">
                            <button
                                onClick={handleBackFromGenre}
                                className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white transition-colors uppercase tracking-wider"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                Genres
                            </button>
                            <ChevronRight className="w-3.5 h-3.5 text-white/20" />
                            <span className="text-xs font-black text-white uppercase tracking-tight">
                                {selectedGenre.name}
                            </span>
                        </div>
                    )}

                    {/* Loading State */}
                    {(isLoading || isSearching) && !loadError && (
                        <div className="flex items-center justify-center py-24">
                            <GradientSpinner size="md" />
                        </div>
                    )}

                    {/* Error State */}
                    {loadError && !isLoading && (
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <Music2 className="w-12 h-12 text-white/10 mb-4" />
                            <h3 className="text-lg font-black text-white mb-2 tracking-tight">
                                Couldn&apos;t load content
                            </h3>
                            <p className="text-xs font-mono text-white/40 mb-6 max-w-sm uppercase tracking-wider">
                                {loadError}
                            </p>
                            <button
                                onClick={fetchAllContent}
                                className="px-6 py-2.5 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] text-white text-xs font-black uppercase tracking-wider transition-all hover:scale-[1.02] active:scale-[0.98]"
                            >
                                Try again
                            </button>
                        </div>
                    )}

                    {/* Search Results */}
                    {!isLoading && !isSearching && hasSearched && (
                        <div
                           
                           
                        >
                            <SectionHeader
                                title={`Results for "${searchQuery}"`}
                                count={playlists.length}
                            />
                            {playlists.length === 0 ?
                                <div className="flex flex-col items-center justify-center py-20 text-center">
                                    <h3 className="text-lg font-black text-white mb-2 tracking-tight">
                                        No playlists found
                                    </h3>
                                    <p className="text-xs font-mono text-white/40 mb-4 uppercase tracking-wider">
                                        Try a different search or import a URL
                                        directly
                                    </p>
                                    <button
                                        onClick={() => setShowUrlModal(true)}
                                        className="px-6 py-2.5 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] text-white text-xs font-black uppercase tracking-wider transition-all"
                                    >
                                        Import by URL
                                    </button>
                                </div>
                            :   <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                    {playlists.map((item, idx) =>
                                        renderCard(item, idx, "search"),
                                    )}
                                </div>
                            }
                        </div>
                    )}

                    {/* Genre Playlists View */}
                    {!isLoading && selectedGenre && (
                        <div
                           
                           
                        >
                            <SectionHeader
                                title={`${selectedGenre.name} Playlists`}
                                count={genrePlaylists.length}
                            />
                            {genrePlaylists.length === 0 ?
                                <p className="text-xs font-mono text-white/40 uppercase tracking-wider">
                                    No playlists found for this genre
                                </p>
                            :   <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                    {genrePlaylists.map((item, idx) =>
                                        renderCard(item, idx, "genre"),
                                    )}
                                </div>
                            }
                        </div>
                    )}

                    {/* Main Content */}
                    {!isLoading &&
                        !isSearching &&
                        !hasSearched &&
                        !selectedGenre && (
                            <>
                                {activeTab === "playlists" && (
                                    <div
                                       
                                        style={{
                                            animationDelay: `${sectionIndex++ * 0.1}s`,
                                        }}
                                    >
                                        <SectionHeader
                                            title="Featured Playlists"
                                            count={playlists.length}
                                        />
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                            {playlists.map((item, idx) =>
                                                renderCard(
                                                    item,
                                                    idx,
                                                    "featured",
                                                ),
                                            )}
                                        </div>
                                        {playlists.length >= 20 && (
                                            <p className="text-center text-[10px] font-mono text-white/20 mt-8 uppercase tracking-wider">
                                                Showing {playlists.length}{" "}
                                                playlists -- Search for more or
                                                import by URL
                                            </p>
                                        )}
                                    </div>
                                )}

                                {activeTab === "genres" && (
                                    <div
                                       
                                        style={{
                                            animationDelay: `${sectionIndex++ * 0.1}s`,
                                        }}
                                    >
                                        <SectionHeader
                                            title="Browse by Genre"
                                            count={genres.length}
                                        />
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                            {genres.map(renderGenreCard)}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                </div>
            </div>

            {/* URL Import Modal */}
            {showUrlModal && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[80] p-4 animate-in fade-in duration-200"
                    onClick={() => setShowUrlModal(false)}
                >
                    <div
                        className="bg-[#0f0f0f] rounded-lg max-w-lg w-full shadow-2xl border border-white/10 animate-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="relative px-6 pt-6 pb-4 border-b border-white/10">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="absolute top-4 right-4 p-2 hover:bg-white/5 rounded-lg transition-colors"
                            >
                                <X className="w-4 h-4 text-white/40 hover:text-white transition-colors" />
                            </button>

                            <div className="flex items-center gap-3 mb-1">
                                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#a855f7] to-[#c026d3] flex items-center justify-center">
                                    <Link2 className="w-4 h-4 text-white" />
                                </div>
                                <h3 className="text-lg font-black text-white tracking-tight">
                                    Import Playlist
                                </h3>
                            </div>
                            <p className="text-xs font-mono text-white/40 uppercase tracking-wider ml-11">
                                Paste a link to get started
                            </p>
                        </div>

                        {/* Supported platforms */}
                        <div className="px-6 py-4">
                            <div className="flex items-center gap-3 p-3 bg-white/[0.02] rounded-lg border border-white/5">
                                <div className="flex items-center gap-2 px-2.5 py-1 bg-[#1DB954]/10 rounded border border-[#1DB954]/20">
                                    <svg
                                        viewBox="0 0 24 24"
                                        className="w-3.5 h-3.5 text-[#1DB954]"
                                        fill="currentColor"
                                    >
                                        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                                    </svg>
                                    <span className="text-[10px] font-black text-[#1DB954] uppercase tracking-wider">
                                        Spotify
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-2.5 py-1 bg-[#a855f7]/10 rounded border border-[#a855f7]/20">
                                    <DeezerIcon className="w-3.5 h-3.5 text-[#a855f7]" />
                                    <span className="text-[10px] font-black text-[#a855f7] uppercase tracking-wider">
                                        Deezer
                                    </span>
                                </div>
                                <span className="text-[10px] font-mono text-white/20 ml-auto uppercase tracking-wider">
                                    Supported
                                </span>
                            </div>
                        </div>

                        {/* Input */}
                        <div className="px-6 pb-4">
                            <div className="relative">
                                <input
                                    type="text"
                                    value={urlInput}
                                    onChange={(e) =>
                                        setUrlInput(e.target.value)
                                    }
                                    placeholder="Paste playlist URL here..."
                                    className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-[#a855f7]/40 transition-all font-mono"
                                    onKeyDown={(e) =>
                                        e.key === "Enter" && handleUrlSubmit()
                                    }
                                    autoFocus
                                />
                                {urlInput && (
                                    <button
                                        onClick={() => setUrlInput("")}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-white/5 rounded transition-colors"
                                    >
                                        <X className="w-3.5 h-3.5 text-white/30" />
                                    </button>
                                )}
                            </div>
                            <p className="text-[10px] font-mono text-white/20 mt-2 ml-1 uppercase tracking-wider">
                                Example:
                                https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
                            </p>
                        </div>

                        {/* Actions */}
                        <div className="px-6 pb-6 flex gap-3">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="flex-1 py-3 rounded-lg bg-white/5 border border-white/10 text-xs font-black uppercase tracking-wider text-white/50 hover:bg-white/10 hover:text-white transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleUrlSubmit}
                                disabled={isParsing || !urlInput.trim()}
                                className="flex-1 py-3 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] text-white text-xs font-black uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                            >
                                {isParsing ?
                                    <>
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        <span>Importing...</span>
                                    </>
                                :   <>
                                        <ChevronRight className="w-3.5 h-3.5" />
                                        <span>Continue</span>
                                    </>
                                }
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
