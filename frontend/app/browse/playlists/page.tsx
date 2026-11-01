"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Search,
    Music2,
    Link2,
    X,
    ChevronRight,
    Info,
    ArrowLeft,
} from "lucide-react";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { DeezerIcon } from "@/features/home/components/DeezerIcon";
import type { PlaylistPreview } from "@/features/home/types";
import { MediaCard } from "@/components/cards/MediaCard";
import { TileCard } from "@/components/cards/TileCard";
import { plural } from "@/lib/format";

interface Genre {
    id: number;
    name: string;
    imageUrl: string | null;
}

type BrowseTab = "playlists" | "genres";

export default function BrowsePlaylistsPage() {
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

    const fetchAllContent = useCallback(() => {
        return api
            .get<{
                playlists: PlaylistPreview[];
                genres: Genre[];
            }>("/browse/all")
            .then((response) => {
                setPlaylists(response.playlists);
                setGenres(response.genres);
            })
            .catch((error) => {
                console.error("Failed to fetch browse content:", error);
                setLoadError(
                    "Couldn't load playlists. Check your connection and try again.",
                );
            })
            .finally(() => setIsLoading(false));
    }, []);

    const reloadContent = () => {
        setIsLoading(true);
        setLoadError(null);
        fetchAllContent();
    };

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
        setSelectedGenre(null);
        setActiveTab("playlists");

        try {
            const response = await api.get<{ playlists: PlaylistPreview[] }>(
                `/browse/playlists/search?q=${encodeURIComponent(searchQuery)}&limit=100`,
            );
            setPlaylists(response.playlists);
        } catch (error) {
            console.error("Search failed:", error);
            notify.error("Failed to search playlists");
        } finally {
            setIsSearching(false);
        }
    };

    const clearSearch = () => {
        setSearchQuery("");
        setHasSearched(false);
        reloadContent();
    };

    const handleUrlSubmit = async () => {
        if (!urlInput.trim()) return;
        setIsParsing(true);

        try {
            // Parse URL first to validate it
            const response = await api.post<{ url: string }>(
                "/browse/playlists/parse",
                { url: urlInput.trim() },
            );

            await api.post("/spotify/import/quick", { url: response.url });

            setShowUrlModal(false);
            setUrlInput("");
        } catch (error: unknown) {
            notify.error("Couldn't import playlist", { message: error instanceof Error ? error.message : undefined });
        } finally {
            setIsParsing(false);
        }
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
            notify.error("Failed to load genre playlists");
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
        <MediaCard
            key={`${item.source}-${item.type}-${item.id}-${context || "main"}-${index}`}
            href={`/browse/playlists/${item.id}`}
            title={item.title}
            subtitle={`${plural(item.trackCount, "song")} · ${item.creator}`}
            imageUrl={item.imageUrl}
            fallbackIcon={Music2}
            type="track"
            index={index}
        />
    );

    const renderGenreCard = (genre: Genre, index: number) => (
        <TileCard
            key={genre.id}
            title={genre.name}
            imageUrl={genre.imageUrl}
            tint="from-type-track/30 to-type-track/10"
            hoverBorder="hover:border-type-track/40"
            accent="from-type-track to-type-track"
            onClick={() => handleGenreClick(genre)}
            index={index}
            className="aspect-square"
        />
    );

    if (isLoading && !selectedGenre && !hasSearched) {
        return <LoadingScreen />;
    }

    let sectionIndex = 0;

    return (
        <div className="min-h-screen">
            <div className="section-stack">
                <PageHeader
                    title="Browse playlists"
                    description="Find playlists on Deezer and import them into your library"
                    className="pb-2"
                />

                <div className="relative page-shell page-end animate-rise">
                    <div className="mb-6">
                        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-type-track/5 border border-type-track/20">
                            <Info className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                            <p className="text-xs tabular-nums text-[var(--text-secondary)] leading-relaxed">
                                <span className="font-bold text-brand">
                                    Beta
                                </span>{" "}
                                · Importing from Spotify and Deezer relies on
                                matching tracks through Soulseek and your
                                configured indexers. Results may vary depending
                                on track availability and metadata quality.
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 mb-6">
                        <form
                            onSubmit={handleSearch}
                            className="relative flex-1 max-w-md"
                        >
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search playlists..."
                                aria-label="Search playlists"
                                className="w-full bg-white/5 border border-white/10 rounded-lg pl-11 pr-10 py-2.5 text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-brand/40 transition-all tabular-nums"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    onClick={clearSearch}
                                    aria-label="Clear search"
                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-white transition-colors"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </form>

                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setShowUrlModal(true)}
                        >
                            <Link2 className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Import URL</span>
                        </Button>
                    </div>

                    {!selectedGenre && !hasSearched && (
                        <div className="flex items-center gap-2 mb-8">
                            <Button
                                variant={activeTab === "playlists" ? "primary" : "secondary"}
                                size="sm"
                                onClick={() => setActiveTab("playlists")}
                            >
                                Playlists
                            </Button>
                            <Button
                                variant={activeTab === "genres" ? "primary" : "secondary"}
                                size="sm"
                                onClick={() => setActiveTab("genres")}
                            >
                                Genres
                            </Button>
                        </div>
                    )}

                    {selectedGenre && (
                        <div className="flex items-center gap-2 mb-6">
                            <button
                                onClick={handleBackFromGenre}
                                className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                Genres
                            </button>
                            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                            <span className="text-xs font-semibold text-white tracking-tight">
                                {selectedGenre.name}
                            </span>
                        </div>
                    )}

                    {(isLoading || isSearching) && !loadError && (
                        <div className="flex items-center justify-center py-24">
                            <GradientSpinner size="md" />
                        </div>
                    )}

                    {loadError && !isLoading && (
                        <EmptyState
                            icon={<Music2 className="w-12 h-12" />}
                            title="Couldn't load content"
                            description={loadError}
                            action={{ label: "Try again", onClick: reloadContent }}
                        />
                    )}

                    {!isLoading && !isSearching && hasSearched && (
                        <div>
                            <SectionHeader type="track"
                                title={`Results for "${searchQuery}"`}
                                count={playlists.length}
                            />
                            {playlists.length === 0 ?
                                <EmptyState
                                    icon={<Search className="w-12 h-12" />}
                                    title="No playlists found"
                                    description="Try a different search or import a URL directly"
                                    action={{ label: "Import by URL", onClick: () => setShowUrlModal(true) }}
                                />
                            :   <div className="grid-media">
                                    {playlists.map((item, idx) =>
                                        renderCard(item, idx, "search"),
                                    )}
                                </div>
                            }
                        </div>
                    )}

                    {!isLoading && selectedGenre && (
                        <div>
                            <SectionHeader type="track"
                                title={`${selectedGenre.name} Playlists`}
                                count={genrePlaylists.length}
                            />
                            {genrePlaylists.length === 0 ?
                                <p className="text-xs text-[var(--text-muted)]">
                                    No playlists found for this genre
                                </p>
                            :   <div className="grid-media">
                                    {genrePlaylists.map((item, idx) =>
                                        renderCard(item, idx, "genre"),
                                    )}
                                </div>
                            }
                        </div>
                    )}

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
                                        <SectionHeader type="track"
                                            title="Featured Playlists"
                                            count={playlists.length}
                                        />
                                        <div className="grid-media">
                                            {playlists.map((item, idx) =>
                                                renderCard(
                                                    item,
                                                    idx,
                                                    "featured",
                                                ),
                                            )}
                                        </div>
                                        {playlists.length >= 20 && (
                                            <p className="text-center text-xs tabular-nums text-[var(--text-muted)] mt-8">
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
                                        <SectionHeader type="track"
                                            title="Browse by Genre"
                                            count={genres.length}
                                        />
                                        <div className="grid-media">
                                            {genres.map(renderGenreCard)}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                </div>
            </div>

            <Modal
                isOpen={showUrlModal}
                onClose={() => setShowUrlModal(false)}
                title="Import Playlist"
                footer={
                    <>
                        <Button variant="secondary" size="sm" onClick={() => setShowUrlModal(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={handleUrlSubmit}
                            disabled={!urlInput.trim()}
                            isLoading={isParsing}
                        >
                            {isParsing ? "Importing..." : (
                                <>
                                    <ChevronRight className="w-3.5 h-3.5" />
                                    Continue
                                </>
                            )}
                        </Button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div className="flex items-center gap-3 p-3 bg-white/[0.02] rounded-lg border border-white/5">
                        <div className="flex items-center gap-2 px-2.5 py-1 bg-spotify/10 rounded border border-spotify/20">
                            <svg
                                viewBox="0 0 24 24"
                                className="w-3.5 h-3.5 text-spotify"
                                fill="currentColor"
                            >
                                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                            </svg>
                            <span className="text-xs font-semibold text-spotify">
                                Spotify
                            </span>
                        </div>
                        <div className="flex items-center gap-2 px-2.5 py-1 bg-type-track/10 rounded border border-type-track/20">
                            <DeezerIcon className="w-3.5 h-3.5 text-brand" />
                            <span className="text-xs font-semibold text-brand">
                                Deezer
                            </span>
                        </div>
                        <div className="flex items-center gap-2 px-2.5 py-1 bg-[#FF0000]/10 rounded border border-[#FF0000]/20">
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-[#FF0000]" fill="currentColor">
                                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                            </svg>
                            <span className="text-xs font-semibold text-[#FF0000]">
                                YouTube
                            </span>
                        </div>
                        <div className="flex items-center gap-2 px-2.5 py-1 bg-[#FF5500]/10 rounded border border-[#FF5500]/20">
                            <span className="text-xs font-semibold text-[#FF5500]">
                                SC
                            </span>
                        </div>
                        <span className="text-xs text-[var(--text-muted)] ml-auto">
                            +more
                        </span>
                    </div>
                    <div>
                        <div className="relative">
                            <input
                                type="text"
                                value={urlInput}
                                onChange={(e) =>
                                    setUrlInput(e.target.value)
                                }
                                placeholder="Paste a playlist URL (Spotify, YouTube, SoundCloud...)"
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-brand/40 transition-all tabular-nums"
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
                                    <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                                </button>
                            )}
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-2 ml-1">
                            Spotify, Deezer, YouTube, SoundCloud, Bandcamp, Mixcloud
                        </p>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
