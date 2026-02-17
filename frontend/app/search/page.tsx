"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useSearchData } from "@/features/search/hooks/useSearchData";
import { useSoulseekSearch } from "@/features/search/hooks/useSoulseekSearch";
import { SearchFilters } from "@/features/search/components/SearchFilters";
import { TopResult } from "@/features/search/components/TopResult";
import { EmptyState } from "@/features/search/components/EmptyState";
import { LibraryAlbumsGrid } from "@/features/search/components/LibraryAlbumsGrid";
import { LibraryPodcastsGrid } from "@/features/search/components/LibraryPodcastsGrid";
import { LibraryAudiobooksGrid } from "@/features/search/components/LibraryAudiobooksGrid";
import { LibraryTracksList } from "@/features/search/components/LibraryTracksList";
import { SimilarArtistsGrid } from "@/features/search/components/SimilarArtistsGrid";
import { AliasResolutionBanner } from "@/features/search/components/AliasResolutionBanner";
import { UnifiedSongsList } from "@/features/search/components/UnifiedSongsList";
import { SoulseekBrowser } from "@/features/search/components/SoulseekBrowser";
import { TVSearchInput } from "@/features/search/components/TVSearchInput";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import type { FilterTab } from "@/features/search/types";

export default function SearchPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const [filterTab, setFilterTab] = useState<FilterTab>("all");
    const [query, setQuery] = useState(() => searchParams.get("q") ?? "");

    const {
        libraryResults,
        discoverResults,
        similarArtists,
        aliasInfo,
        isLibrarySearching,
        isDiscoverSearching,
        hasSearched,
    } = useSearchData({ query });
    const {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        isSearchComplete,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
        handleBulkDownload,
        uniqueUserCount,
    } = useSoulseekSearch({ query });

    const urlQuery = searchParams.get("q") ?? "";
    const [prevUrlQuery, setPrevUrlQuery] = useState(urlQuery);
    if (urlQuery !== prevUrlQuery) {
        setPrevUrlQuery(urlQuery);
        if (urlQuery) {
            setQuery(urlQuery);
        }
    }

    const topArtist = discoverResults.find((r) => r.type === "music");
    const isLoading =
        isLibrarySearching ||
        isDiscoverSearching ||
        isSoulseekSearching ||
        isSoulseekPolling;
    const showLibrary = filterTab === "all" || filterTab === "library";
    const showDiscover = filterTab === "all" || filterTab === "discover";

    const hasTopResult = libraryResults?.artists?.[0] || topArtist;
    const hasTracks =
        (libraryResults?.tracks?.length ?? 0) > 0 || soulseekResults.length > 0;
    const show2ColumnLayout =
        hasSearched &&
        hasTopResult &&
        hasTracks &&
        filterTab !== "soulseek" &&
        (showLibrary || showDiscover);

    const handleTVSearch = (searchQuery: string) => {
        setQuery(searchQuery);
        router.push(`/search?q=${encodeURIComponent(searchQuery)}`);
    };

    return (
        <div className="min-h-screen relative overflow-hidden">
            {/* Main content */}
            <div className="relative z-10 px-6 py-8 max-w-[1600px] mx-auto">
                <TVSearchInput initialQuery={query} onSearch={handleTVSearch} />

                {/* Hero Header - Only show when no search */}
                {!hasSearched && (
                    <div className="mb-12 text-center animate-fade-in">
                        <div className="inline-flex items-center gap-3 mb-4 text-[#eab308]">
                            <span className="text-sm font-semibold tracking-wider uppercase">
                                Discovery Engine
                            </span>
                        </div>
                        <h1 className="text-6xl md:text-7xl font-black mb-4 bg-gradient-to-br from-white via-white to-gray-500 bg-clip-text text-transparent leading-tight">
                            Find Your Sound
                        </h1>
                        <p className="text-lg text-gray-400 max-w-2xl mx-auto">
                            Search your library, discover new artists, or tap
                            into the P2P network for rare tracks
                        </p>
                    </div>
                )}

                {/* Search state indicator bar */}
                {hasSearched && (
                    <div className="mb-8">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h1 className="text-4xl font-black mb-2 tracking-tight">
                                    {query}
                                </h1>
                                {isLoading && (
                                    <div className="flex items-center gap-2 text-sm text-[#eab308]">
                                        <div className="w-1 h-1 rounded-full bg-[#eab308] animate-ping" />
                                        <span className="font-medium">
                                            Searching across sources...
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>

                        <SearchFilters
                            filterTab={filterTab}
                            onFilterChange={setFilterTab}
                            soulseekEnabled={soulseekEnabled}
                            hasSearched={hasSearched}
                            soulseekResultCount={soulseekResults.length}
                        />
                    </div>
                )}

                {aliasInfo && (
                    <div className="mb-8">
                        <AliasResolutionBanner aliasInfo={aliasInfo} />
                    </div>
                )}

                <EmptyState hasSearched={hasSearched} isLoading={isLoading} />

                {/* Loading state - only when no results yet */}
                {hasSearched &&
                    filterTab !== "soulseek" &&
                    (isLibrarySearching ||
                        isDiscoverSearching ||
                        isSoulseekSearching) &&
                    (!libraryResults || !libraryResults.artists?.length) &&
                    discoverResults.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-24 relative">
                            <div className="relative">
                                <GradientSpinner size="xl" className="mb-6" />
                                <div className="absolute inset-0 bg-gradient-to-r from-[#eab308] to-[#a855f7] opacity-20 blur-xl animate-pulse" />
                            </div>
                            <p className="text-gray-400 text-sm animate-pulse">
                                Scanning library and network...
                            </p>
                        </div>
                    )}

                {/* Soulseek Tab */}
                {filterTab === "soulseek" && hasSearched && (
                    <div>
                        <SoulseekBrowser
                            results={soulseekResults}
                            isSearching={isSoulseekSearching}
                            isPolling={isSoulseekPolling}
                            isComplete={isSearchComplete}
                            uniqueUserCount={uniqueUserCount}
                            downloadingFiles={downloadingFiles}
                            onDownload={handleDownload}
                            onBulkDownload={handleBulkDownload}
                        />
                    </div>
                )}

                {/* All / Library / Discover Tabs */}
                {filterTab !== "soulseek" && (
                    <div className="space-y-12">
                        {show2ColumnLayout ?
                            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-8">
                                {/* Featured Result - Larger card */}
                                <div className="space-y-4">
                                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3">
                                        <span className="w-1 h-8 bg-gradient-to-b from-[#eab308] to-[#f59e0b] rounded-full" />
                                        Top Match
                                    </h2>
                                    <TopResult
                                        libraryArtist={
                                            libraryResults?.artists?.[0]
                                        }
                                        discoveryArtist={topArtist}
                                    />
                                </div>

                                {/* Songs list - More prominent */}
                                <div className="space-y-4">
                                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3">
                                        <span className="w-1 h-8 bg-gradient-to-b from-[#a855f7] to-[#c026d3] rounded-full" />
                                        Tracks
                                    </h2>
                                    {filterTab === "all" ?
                                        <UnifiedSongsList
                                            tracks={
                                                libraryResults?.tracks ?? []
                                            }
                                            soulseekResults={soulseekResults}
                                            downloadingFiles={downloadingFiles}
                                            onDownload={handleDownload}
                                        />
                                    : filterTab === "library" ?
                                        <LibraryTracksList
                                            tracks={
                                                libraryResults?.tracks ?? []
                                            }
                                        />
                                    :   null}
                                </div>
                            </div>
                        :   <>
                                {hasSearched &&
                                    (showDiscover || showLibrary) &&
                                    hasTopResult && (
                                        <section>
                                            <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                                <span className="w-1 h-8 bg-gradient-to-b from-[#eab308] to-[#f59e0b] rounded-full" />
                                                Top Match
                                            </h2>
                                            <TopResult
                                                libraryArtist={
                                                    libraryResults?.artists?.[0]
                                                }
                                                discoveryArtist={topArtist}
                                            />
                                        </section>
                                    )}

                                {hasSearched && hasTracks && (
                                    <section>
                                        <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                            <span className="w-1 h-8 bg-gradient-to-b from-[#a855f7] to-[#c026d3] rounded-full" />
                                            Tracks
                                        </h2>
                                        {filterTab === "all" ?
                                            <UnifiedSongsList
                                                tracks={
                                                    libraryResults?.tracks ?? []
                                                }
                                                soulseekResults={
                                                    soulseekResults
                                                }
                                                downloadingFiles={
                                                    downloadingFiles
                                                }
                                                onDownload={handleDownload}
                                            />
                                        : filterTab === "library" ?
                                            <LibraryTracksList
                                                tracks={
                                                    libraryResults?.tracks ?? []
                                                }
                                            />
                                        :   null}
                                    </section>
                                )}
                            </>
                        }

                        {/* Albums Grid */}
                        {hasSearched &&
                            showLibrary &&
                            (libraryResults?.albums?.length ?? 0) > 0 && (
                                <section>
                                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                        <span className="w-1 h-8 bg-gradient-to-b from-[#22c55e] to-[#16a34a] rounded-full" />
                                        Albums
                                    </h2>
                                    <LibraryAlbumsGrid
                                        albums={libraryResults!.albums!}
                                    />
                                </section>
                            )}

                        {/* Podcasts Grid */}
                        {hasSearched &&
                            showLibrary &&
                            (libraryResults?.podcasts?.length ?? 0) > 0 && (
                                <section>
                                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                        <span className="w-1 h-8 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full" />
                                        Podcasts
                                    </h2>
                                    <LibraryPodcastsGrid
                                        podcasts={libraryResults!.podcasts!}
                                    />
                                </section>
                            )}

                        {/* Audiobooks Grid */}
                        {hasSearched &&
                            showLibrary &&
                            (libraryResults?.audiobooks?.length ?? 0) > 0 && (
                                <section>
                                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                        <span className="w-1 h-8 bg-gradient-to-b from-[#f59e0b] to-[#d97706] rounded-full" />
                                        Audiobooks
                                    </h2>
                                    <LibraryAudiobooksGrid
                                        audiobooks={libraryResults!.audiobooks!}
                                    />
                                </section>
                            )}

                        {/* Related Artists */}
                        {hasSearched &&
                            showDiscover &&
                            similarArtists.length > 0 && (
                                <section>
                                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                        <span className="w-1 h-8 bg-gradient-to-b from-[#ec4899] to-[#db2777] rounded-full" />
                                        Related Artists
                                    </h2>
                                    <SimilarArtistsGrid
                                        similarArtists={similarArtists}
                                    />
                                </section>
                            )}
                    </div>
                )}

                {/* No Results */}
                {hasSearched &&
                    !isLoading &&
                    !topArtist &&
                    soulseekResults.length === 0 &&
                    (!libraryResults ||
                        (!libraryResults.artists?.length &&
                            !libraryResults.albums?.length &&
                            !libraryResults.tracks?.length &&
                            !libraryResults.podcasts?.length &&
                            !libraryResults.audiobooks?.length &&
                            !libraryResults.episodes?.length)) && (
                        <div className="flex flex-col items-center justify-center py-32 text-center animate-fade-in">
                            <div className="relative mb-8">
                                <SearchIcon className="w-20 h-20 text-gray-800" />
                                <div className="absolute inset-0 bg-gradient-to-br from-[#eab308]/20 to-[#a855f7]/20 blur-2xl" />
                            </div>
                            <h3 className="text-2xl font-bold text-white mb-3">
                                No matches found
                            </h3>
                            <p className="text-gray-400 mb-2">
                                Try a different search term or check your
                                spelling
                            </p>
                            <p className="text-sm text-gray-500">
                                Tip: Enable Soulseek to search the P2P network
                            </p>
                        </div>
                    )}
            </div>
        </div>
    );
}
