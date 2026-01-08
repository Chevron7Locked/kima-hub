"use client";

import { useState, lazy, Suspense } from "react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { RefreshCw, AudioWaveform } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { Badge } from "@/components/ui/Badge";
import { useHomeData } from "@/features/home/hooks/useHomeData";
import { HomeHero } from "@/features/home/components/HomeHero";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { ContinueListening } from "@/features/home/components/ContinueListening";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { MixesGrid } from "@/features/home/components/MixesGrid";
import { PopularArtistsGrid } from "@/features/home/components/PopularArtistsGrid";
import { PodcastsGrid } from "@/features/home/components/PodcastsGrid";
import { AudiobooksGrid } from "@/features/home/components/AudiobooksGrid";
import { FeaturedPlaylistsGrid } from "@/features/home/components/FeaturedPlaylistsGrid";
import { LibraryRadioStations } from "@/features/home/components/LibraryRadioStations";

// Lazy load MoodMixer - only loads when user opens it
const MoodMixer = lazy(() => import("@/components/MoodMixer").then(mod => ({ default: mod.MoodMixer })));

// Loading skeleton for playlist cards
function PlaylistSkeleton() {
    return (
        <div className="flex gap-3 overflow-hidden">
            {[...Array(8)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px] p-3">
                    <div className="aspect-square rounded-md bg-white/5 animate-pulse mb-3" />
                    <div className="h-4 bg-white/5 rounded animate-pulse w-3/4 mb-2" />
                    <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                </div>
            ))}
        </div>
    );
}

export default function HomePage() {
    const [showMoodMixer, setShowMoodMixer] = useState(false);
    const {
        recentlyListened,
        recentlyAdded,
        recommended,
        mixes,
        popularArtists,
        recentPodcasts,
        recentAudiobooks,
        featuredPlaylists,
        isLoading,
        isRefreshingMixes,
        isBrowseLoading,
        handleRefreshMixes,
    } = useHomeData();

    if (isLoading) {
        return <LoadingScreen />;
    }

    return (
        <div className="relative">
            <HomeHero />

            <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 pb-8">
                <div className="space-y-8">
                    {/* Library Radio Stations - Quick shuffle from your library */}
                    <section>
                        <SectionHeader title="Library Radio" showAllHref="/radio" />
                        <LibraryRadioStations />
                    </section>

                    {/* Continue Listening - #1 Priority */}
                    {recentlyListened.length > 0 && (
                        <section>
                            <SectionHeader title="Continue Listening" showAllHref="/library?tab=artists" />
                            <ContinueListening items={recentlyListened} />
                        </section>
                    )}

                    {/* Recently Added - #2 Priority */}
                    {recentlyAdded.length > 0 && (
                        <section>
                            <SectionHeader title="Recently Added" showAllHref="/library?tab=artists" />
                            <ArtistsGrid artists={recentlyAdded} />
                        </section>
                    )}

                    {/* Made For You - #3 Priority */}
                    {mixes.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Made For You"
                                rightAction={
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => setShowMoodMixer(true)}
                                            className="flex items-center gap-2 px-3 py-1.5 text-sm text-black font-semibold bg-[#ecb200] hover:bg-[#d4a000] rounded-full transition-colors"
                                        >
                                            <AudioWaveform className="w-4 h-4" />
                                            <span className="hidden sm:inline">Mood Mixer</span>
                                        </button>
                                        <button
                                            onClick={handleRefreshMixes}
                                            disabled={isRefreshingMixes}
                                            className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors font-semibold group bg-white/5 hover:bg-white/10 rounded-full disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {isRefreshingMixes ? (
                                                <GradientSpinner size="sm" />
                                            ) : (
                                                <RefreshCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" />
                                            )}
                                            <span className="hidden sm:inline">
                                                {isRefreshingMixes ? "Refreshing..." : "Refresh"}
                                            </span>
                                        </button>
                                    </div>
                                }
                            />
                            <MixesGrid mixes={mixes} />
                        </section>
                    )}

                    {/* Recommended For You - #4 Priority */}
                    {recommended.length > 0 && (
                        <section>
                            <SectionHeader title="Recommended For You" showAllHref="/discover" badge="Last.FM" />
                            <ArtistsGrid artists={recommended} />
                        </section>
                    )}

                    {/* Popular Artists - #5 Priority */}
                    {popularArtists.length > 0 && (
                        <section>
                            <SectionHeader title="Popular Artists" badge="Last.FM" />
                            <PopularArtistsGrid artists={popularArtists} />
                        </section>
                    )}

                    {/* Featured Playlists - After Popular Artists */}
                    {(isBrowseLoading || featuredPlaylists.length > 0) && (
                        <section>
                            <SectionHeader title="Featured Playlists" showAllHref="/browse/playlists" badge="Deezer" />
                            {isBrowseLoading && featuredPlaylists.length === 0 ? (
                                <PlaylistSkeleton />
                            ) : (
                                <FeaturedPlaylistsGrid playlists={featuredPlaylists} />
                            )}
                        </section>
                    )}

                    {/* Popular Podcasts - #6 Priority */}
                    {recentPodcasts.length > 0 && (
                        <section>
                            <SectionHeader title="Popular Podcasts" showAllHref="/podcasts" />
                            <PodcastsGrid podcasts={recentPodcasts} />
                        </section>
                    )}

                    {/* Audiobooks - #7 Priority */}
                    {recentAudiobooks.length > 0 && (
                        <section>
                            <SectionHeader title="Audiobooks" showAllHref="/audiobooks" />
                            <AudiobooksGrid audiobooks={recentAudiobooks} />
                        </section>
                    )}
                </div>
            </div>

            {/* Mood Mixer Modal - Lazy loaded */}
            {showMoodMixer && (
                <Suspense fallback={null}>
                    <MoodMixer isOpen={showMoodMixer} onClose={() => setShowMoodMixer(false)} />
                </Suspense>
            )}
        </div>
    );
}
