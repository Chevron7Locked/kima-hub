"use client";

import { useState, lazy, Suspense } from "react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { RefreshCw, AudioWaveform } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useHomeData } from "@/features/home/hooks/useHomeData";
import { HomeHero } from "@/features/home/components/HomeHero";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { ContinueListening } from "@/features/home/components/ContinueListening";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { MixesGrid } from "@/features/home/components/MixesGrid";
import { PopularArtistsGrid } from "@/features/home/components/PopularArtistsGrid";
import { PodcastsGrid } from "@/features/home/components/PodcastsGrid";
import { AudiobooksGrid } from "@/features/home/components/AudiobooksGrid";
import { FeaturedPlaylistsGrid, FeaturedPlaylistsSkeleton } from "@/features/home/components/FeaturedPlaylistsGrid";
import { LibraryRadioStations } from "@/features/home/components/LibraryRadioStations";

const MoodMixer = lazy(() => import("@/components/MoodMixer").then(mod => ({ default: mod.MoodMixer })));

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

    const sectionIndex = 0;

    return (
        <div className="min-h-screen relative bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Static gradient overlay */}
            <div className="fixed inset-0 pointer-events-none opacity-50">
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-transparent" />
            </div>

            <div className="relative">
                <HomeHero />

                <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 md:px-8 pb-32 pt-8">
                    <div className="space-y-12">
                        {/* Library Radio Stations */}
                        <section>
                            <SectionHeader title="Library Radio" showAllHref="/radio" color="featured" />
                            <LibraryRadioStations />
                        </section>

                        {/* Continue Listening */}
                        {recentlyListened.length > 0 && (
                            <section>
                                <SectionHeader title="Continue Listening" showAllHref="/library?tab=artists" color="featured" />
                                <ContinueListening items={recentlyListened} />
                            </section>
                        )}

                        {/* Recently Added */}
                        {recentlyAdded.length > 0 && (
                            <section>
                                <SectionHeader title="Recently Added" showAllHref="/library?tab=artists" color="artists" />
                                <ArtistsGrid artists={recentlyAdded} />
                            </section>
                        )}

                        {/* Made For You */}
                        {mixes.length > 0 && (
                            <section>
                                <SectionHeader
                                    title="Made For You"
                                    color="discover"
                                    rightAction={
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => setShowMoodMixer(true)}
                                                className="flex items-center gap-2 px-4 py-2 text-xs font-black uppercase tracking-wider text-black bg-[#fca208] hover:bg-[#f97316] rounded-lg transition-colors"
                                            >
                                                <AudioWaveform className="w-3.5 h-3.5" />
                                                <span className="hidden sm:inline">Mood Mixer</span>
                                            </button>
                                            <button
                                                onClick={handleRefreshMixes}
                                                disabled={isRefreshingMixes}
                                                className="flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-wider text-gray-400 hover:text-white transition-colors bg-white/5 hover:bg-white/10 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed border border-white/10 hover:border-white/20"
                                            >
                                                {isRefreshingMixes ? (
                                                    <GradientSpinner size="sm" />
                                                ) : (
                                                    <RefreshCw className="w-3.5 h-3.5 group-hover:rotate-180 transition-transform duration-500" />
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

                        {/* Recommended For You */}
                        {recommended.length > 0 && (
                            <section>
                                <SectionHeader title="Recommended" showAllHref="/discover" badge="Last.FM" color="artists" />
                                <ArtistsGrid artists={recommended} />
                            </section>
                        )}

                        {/* Popular Artists */}
                        {popularArtists.length > 0 && (
                            <section>
                                <SectionHeader title="Popular Artists" badge="Last.FM" color="artists" />
                                <PopularArtistsGrid artists={popularArtists} />
                            </section>
                        )}

                        {/* Featured Playlists */}
                        {(isBrowseLoading || featuredPlaylists.length > 0) && (
                            <section>
                                <SectionHeader title="Featured Playlists" showAllHref="/browse/playlists" badge="Deezer" color="tracks" />
                                {isBrowseLoading && featuredPlaylists.length === 0 ? (
                                    <FeaturedPlaylistsSkeleton />
                                ) : (
                                    <FeaturedPlaylistsGrid playlists={featuredPlaylists} />
                                )}
                            </section>
                        )}

                        {/* Popular Podcasts */}
                        {recentPodcasts.length > 0 && (
                            <section>
                                <SectionHeader title="Popular Podcasts" showAllHref="/podcasts" color="podcasts" />
                                <PodcastsGrid podcasts={recentPodcasts} />
                            </section>
                        )}

                        {/* Audiobooks */}
                        {recentAudiobooks.length > 0 && (
                            <section>
                                <SectionHeader title="Audiobooks" showAllHref="/audiobooks" color="audiobooks" />
                                <AudiobooksGrid audiobooks={recentAudiobooks} />
                            </section>
                        )}
                    </div>
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
