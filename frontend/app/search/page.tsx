"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useSearchData } from "@/features/search/hooks/useSearchData";
import { useSoulseekSearch } from "@/features/search/hooks/useSoulseekSearch";
import { SearchFilters } from "@/features/search/components/SearchFilters";
import { TopResult } from "@/features/search/components/TopResult";
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
import { EmptyState } from "@/components/ui/EmptyState";
import type { FilterTab } from "@/features/search/types";
import { SectionHeader } from "@/components/ui/SectionHeader";

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

    const topMatch = (
        <TopResult
            libraryArtist={libraryResults?.artists?.[0]}
            discoveryArtist={topArtist}
        />
    );

    const trackList =
        filterTab === "all" ? (
            <UnifiedSongsList
                tracks={libraryResults?.tracks ?? []}
                soulseekResults={soulseekResults}
                downloadingFiles={downloadingFiles}
                onDownload={handleDownload}
            />
        ) : filterTab === "library" ? (
            <LibraryTracksList tracks={libraryResults?.tracks ?? []} />
        ) : null;

    return (
        <div className="min-h-screen relative overflow-hidden">
            <div className="relative z-(--z-raised) page-shell py-8 animate-rise">
                <TVSearchInput initialQuery={query} onSearch={handleTVSearch} />

                {!hasSearched && (
                    <div className="mb-12 text-center animate-rise">
                        <div className="inline-flex items-center gap-3 mb-4 text-brand">
                            <span className="text-sm font-semibold">
                                Discovery Engine
                            </span>
                        </div>
                        <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-4 text-white leading-tight">
                            Find Your Sound
                        </h1>
                        <p className="text-lg text-[var(--text-secondary)] max-w-2xl mx-auto">
                            Search your library, discover new artists, or tap
                            into the P2P network for rare tracks
                        </p>
                    </div>
                )}

                {hasSearched && (
                    <div className="mb-8">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h1 className="text-2xl font-semibold mb-2 tracking-tight">
                                    {query}
                                </h1>
                                {isLoading && (
                                    <div className="flex items-center gap-2 text-sm text-brand">
                                        <div className="w-1 h-1 rounded-full bg-brand animate-ping" />
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

                {!hasSearched && !isLoading && (
                    <EmptyState
                        icon={<SearchIcon className="w-16 h-16" />}
                        title="Search your library"
                        description="Use the search bar above to find music, artists, and albums"
                    />
                )}

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
                                <div className="absolute inset-0 bg-gradient-to-r from-brand to-brand-dark opacity-20 blur-xl animate-pulse" />
                            </div>
                            <p className="text-[var(--text-secondary)] text-sm animate-pulse">
                                Scanning library and network...
                            </p>
                        </div>
                    )}

                {filterTab === "soulseek" && hasSearched && (
                    <div className="animate-fade-soft">
                        <SoulseekBrowser
                            results={soulseekResults}
                            isSearching={isSoulseekSearching}
                            isPolling={isSoulseekPolling}
                            uniqueUserCount={uniqueUserCount}
                            downloadingFiles={downloadingFiles}
                            onDownload={handleDownload}
                            onBulkDownload={handleBulkDownload}
                        />
                    </div>
                )}

                {filterTab !== "soulseek" && (
                    <div className="section-stack">
                        {show2ColumnLayout ?
                            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-8 animate-fade-soft">
                                <div className="space-y-4">
                                    <SectionHeader title="Top Match" className="mb-0" />
                                    {topMatch}
                                </div>

                                <div className="space-y-4">
                                    <SectionHeader type="track" title="Tracks" className="mb-0" />
                                    {trackList}
                                </div>
                            </div>
                        :   <>
                                {hasSearched &&
                                    (showDiscover || showLibrary) &&
                                    hasTopResult && (
                                        <section className="animate-fade-soft">
                                            <SectionHeader title="Top Match" />
                                            {topMatch}
                                        </section>
                                    )}

                                {hasSearched && hasTracks && (
                                    <section className="animate-fade-soft">
                                        <SectionHeader type="track" title="Tracks" />
                                        {trackList}
                                    </section>
                                )}
                            </>
                        }

                        {hasSearched &&
                            showLibrary &&
                            (libraryResults?.albums?.length ?? 0) > 0 && (
                                <section className="animate-fade-soft">
                                    <SectionHeader type="album" title="Albums" />
                                    <LibraryAlbumsGrid
                                        albums={libraryResults!.albums!}
                                    />
                                </section>
                            )}

                        {hasSearched &&
                            showLibrary &&
                            (libraryResults?.podcasts?.length ?? 0) > 0 && (
                                <section className="animate-fade-soft">
                                    <SectionHeader type="podcast" title="Podcasts" />
                                    <LibraryPodcastsGrid
                                        podcasts={libraryResults!.podcasts!}
                                    />
                                </section>
                            )}

                        {hasSearched &&
                            showLibrary &&
                            (libraryResults?.audiobooks?.length ?? 0) > 0 && (
                                <section className="animate-fade-soft">
                                    <SectionHeader type="audiobook" title="Audiobooks" />
                                    <LibraryAudiobooksGrid
                                        audiobooks={libraryResults!.audiobooks!}
                                    />
                                </section>
                            )}

                        {hasSearched &&
                            showDiscover &&
                            similarArtists.length > 0 && (
                                <section className="animate-fade-soft">
                                    <SectionHeader type="artist" title="Related Artists" />
                                    <SimilarArtistsGrid
                                        similarArtists={similarArtists}
                                    />
                                </section>
                            )}
                    </div>
                )}

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
                        <EmptyState
                            icon={<SearchIcon className="w-16 h-16" />}
                            title="No matches found"
                            description="Try a different search term or check your spelling"
                        >
                            <p className="text-sm text-[var(--text-muted)]">
                                Tip: Enable Soulseek to search the P2P network
                            </p>
                        </EmptyState>
                    )}
            </div>
        </div>
    );
}
