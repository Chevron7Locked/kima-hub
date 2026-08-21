"use client";

import React, { useState, lazy, Suspense } from "react";
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

    return (
        <div className="min-h-screen relative bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Static gradient overlay */}
            <div className="fixed inset-0 pointer-events-none opacity-50">
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-transparent" />
            </div>

            <div className="relative">
                <HomeHero />

                <div className="section-stack relative max-w-[1800px] mx-auto px-4 sm:px-6 md:px-8 pb-32 pt-8">
                {/* Sections rise in staggered order on mount. Only the first 8 visible sections animate;
                    items 9+ render immediately. Animation is mount-only (CSS animation-fill-mode: both). */}
                {(() => {
                    const sections: Array<{ key: string; visible: boolean; content: React.ReactNode }> = [
                        { key: "library-radio", visible: true, content: (
                            <section data-tv-section="library-radio">
                                <SectionHeader title="Library Radio" showAllHref="/radio" color="featured" />
                                <LibraryRadioStations />
                            </section>
                        )},
                        { key: "continue-listening", visible: recentlyListened.length > 0, content: (
                            <section data-tv-section="continue-listening">
                                <SectionHeader title="Continue Listening" showAllHref="/collection?tab=artists" color="featured" />
                                <ContinueListening items={recentlyListened} />
                            </section>
                        )},
                        { key: "recently-added", visible: recentlyAdded.length > 0, content: (
                            <section data-tv-section="recently-added">
                                <SectionHeader title="Recently Added" showAllHref="/collection?tab=artists" color="artists" />
                                <ArtistsGrid artists={recentlyAdded} />
                            </section>
                        )},
                        { key: "made-for-you", visible: mixes.length > 0, content: (
                            <section data-tv-section="made-for-you">
                                <SectionHeader
                                    title="Made For You"
                                    color="discover"
                                    rightAction={
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => setShowMoodMixer(true)}
                                                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-black bg-brand hover:bg-[#f97316] rounded-lg transition-colors"
                                            >
                                                <AudioWaveform className="w-3.5 h-3.5" />
                                                <span className="hidden sm:inline">Mood Mixer</span>
                                            </button>
                                            <button
                                                onClick={handleRefreshMixes}
                                                disabled={isRefreshingMixes}
                                                aria-label="Refresh mixes"
                                                className="flex items-center gap-2 px-4 py-2 text-xs tabular-nums text-[var(--text-secondary)] hover:text-white transition-colors bg-white/5 hover:bg-white/10 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed border border-white/10 hover:border-white/20"
                                            >
                                                {isRefreshingMixes ? (
                                                    <GradientSpinner size="sm" />
                                                ) : (
                                                    <RefreshCw className="w-3.5 h-3.5 group-hover:rotate-180 transition-transform duration-150" />
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
                        )},
                        { key: "recommended", visible: recommended.length > 0, content: (
                            <section data-tv-section="recommended">
                                <SectionHeader title="Recommended" showAllHref="/discover" badge="Last.FM" color="artists" />
                                <ArtistsGrid artists={recommended} />
                            </section>
                        )},
                        { key: "popular-artists", visible: popularArtists.length > 0, content: (
                            <section data-tv-section="popular-artists">
                                <SectionHeader title="Popular Artists" badge="Last.FM" color="artists" />
                                <PopularArtistsGrid artists={popularArtists} />
                            </section>
                        )},
                        { key: "featured-playlists", visible: isBrowseLoading || featuredPlaylists.length > 0, content: (
                            <section data-tv-section="featured-playlists">
                                <SectionHeader title="Featured Playlists" showAllHref="/browse/playlists" badge="Deezer" color="tracks" />
                                {isBrowseLoading && featuredPlaylists.length === 0 ? (
                                    <FeaturedPlaylistsSkeleton />
                                ) : (
                                    <FeaturedPlaylistsGrid playlists={featuredPlaylists} />
                                )}
                            </section>
                        )},
                        { key: "popular-podcasts", visible: recentPodcasts.length > 0, content: (
                            <section data-tv-section="popular-podcasts">
                                <SectionHeader title="Popular Podcasts" showAllHref="/podcasts" color="podcasts" />
                                <PodcastsGrid podcasts={recentPodcasts} />
                            </section>
                        )},
                        { key: "audiobooks", visible: recentAudiobooks.length > 0, content: (
                            <section data-tv-section="audiobooks">
                                <SectionHeader title="Audiobooks" showAllHref="/audiobooks" color="audiobooks" />
                                <AudiobooksGrid audiobooks={recentAudiobooks} />
                            </section>
                        )},
                    ];

                    let visibleIdx = 0;
                    return sections.map((s) => {
                        if (!s.visible) return null;
                        const staggered = visibleIdx < 8;
                        const el = (
                            <div
                                key={s.key}
                                className={staggered ? "animate-rise [animation-delay:calc(var(--i)*45ms)]" : undefined}
                                style={staggered ? { "--i": visibleIdx } as React.CSSProperties : undefined}
                            >
                                {s.content}
                            </div>
                        );
                        visibleIdx++;
                        return el;
                    });
                })()}
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
