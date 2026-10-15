"use client";

import React, { useState, lazy, Suspense } from "react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { RefreshCw, AudioWaveform } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useHomeData } from "@/features/home/hooks/useHomeData";
import { HomeHero } from "@/features/home/components/HomeHero";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { ContinueListening } from "@/features/home/components/ContinueListening";
import { ArtistsGrid, PopularArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { MixesGrid } from "@/features/home/components/MixesGrid";
import { PodcastShelf } from "@/features/podcast/components/PodcastShelf";
import { AudiobooksGrid } from "@/features/home/components/AudiobooksGrid";
import { FeaturedPlaylistsGrid, FeaturedPlaylistsSkeleton } from "@/features/home/components/FeaturedPlaylistsGrid";
import { LibraryRadioStations } from "@/features/home/components/LibraryRadioStations";
import { Button } from "@/components/ui/Button";

const MoodMixer = lazy(() => import("@/components/MoodMixer").then(mod => ({ default: mod.MoodMixer })));

export default function HomePage() {
    const [showMoodMixer, setShowMoodMixer] = useState(false);
    const {
        recentlyListened,
        recentlyAdded,
        recommended,
        mixes,
        popularArtists,
        popularPodcasts,
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
        <div className="min-h-screen">
            <div className="relative">
                <HomeHero />

                <div className="section-stack relative page-shell pb-32 pt-2">
                {/* Sections rise in staggered order on mount. Only the first 8 visible sections animate;
                    items 9+ render immediately. Animation is mount-only (CSS animation-fill-mode: both). */}
                {(() => {
                    const sections: Array<{ key: string; visible: boolean; content: React.ReactNode }> = [
                        { key: "library-radio", visible: true, content: (
                            <section data-tv-section="library-radio">
                                <SectionHeader title="Library Radio" showAllHref="/radio" type="featured" />
                                <LibraryRadioStations />
                            </section>
                        )},
                        { key: "continue-listening", visible: recentlyListened.length > 0, content: (
                            <section data-tv-section="continue-listening">
                                <SectionHeader title="Continue Listening" showAllHref="/collection?tab=artists" type="featured" />
                                <ContinueListening items={recentlyListened} />
                            </section>
                        )},
                        { key: "recently-added", visible: recentlyAdded.length > 0, content: (
                            <section data-tv-section="recently-added">
                                <SectionHeader title="Recently Added" showAllHref="/collection?tab=artists" type="artist" />
                                <ArtistsGrid artists={recentlyAdded} />
                            </section>
                        )},
                        { key: "made-for-you", visible: mixes.length > 0, content: (
                            <section data-tv-section="made-for-you">
                                <SectionHeader
                                    title="Made For You"
                                    type="track"
                                    action={
                                        <div className="flex items-center gap-2">
                                            <Button
                                                variant="primary"
                                                size="sm"
                                                onClick={() => setShowMoodMixer(true)}
                                            >
                                                <AudioWaveform className="w-3.5 h-3.5" />
                                                <span className="hidden sm:inline">Mood Mixer</span>
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={handleRefreshMixes}
                                                disabled={isRefreshingMixes}
                                                aria-label="Refresh mixes"
                                            >
                                                {isRefreshingMixes ? (
                                                    <GradientSpinner size="sm" />
                                                ) : (
                                                    <RefreshCw className="w-3.5 h-3.5 group-hover:rotate-180 transition-transform duration-150" />
                                                )}
                                                <span className="hidden sm:inline">
                                                    {isRefreshingMixes ? "Refreshing..." : "Refresh"}
                                                </span>
                                            </Button>
                                        </div>
                                    }
                                />
                                <MixesGrid mixes={mixes} />
                            </section>
                        )},
                        { key: "recommended", visible: recommended.length > 0, content: (
                            <section data-tv-section="recommended">
                                <SectionHeader title="Recommended" showAllHref="/discover" badge="Local Engine" type="artist" />
                                <ArtistsGrid artists={recommended} />
                            </section>
                        )},
                        { key: "popular-artists", visible: popularArtists.length > 0, content: (
                            <section data-tv-section="popular-artists">
                                <SectionHeader title="Popular Artists" badge="ListenBrainz" type="artist" />
                                <PopularArtistsGrid artists={popularArtists} />
                            </section>
                        )},
                        { key: "featured-playlists", visible: isBrowseLoading || featuredPlaylists.length > 0, content: (
                            <section data-tv-section="featured-playlists">
                                <SectionHeader title="Featured Playlists" showAllHref="/browse/playlists" badge="Deezer" type="track" />
                                {isBrowseLoading && featuredPlaylists.length === 0 ? (
                                    <FeaturedPlaylistsSkeleton />
                                ) : (
                                    <FeaturedPlaylistsGrid playlists={featuredPlaylists} />
                                )}
                            </section>
                        )},
                        { key: "popular-podcasts", visible: popularPodcasts.length > 0, content: (
                            <section data-tv-section="popular-podcasts">
                                <SectionHeader title="Popular Podcasts" showAllHref="/podcasts" type="podcast" />
                                <PodcastShelf podcasts={popularPodcasts} />
                            </section>
                        )},
                        { key: "audiobooks", visible: recentAudiobooks.length > 0, content: (
                            <section data-tv-section="audiobooks">
                                <SectionHeader title="Audiobooks" showAllHref="/audiobooks" type="audiobook" />
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

            {showMoodMixer && (
                <Suspense fallback={null}>
                    <MoodMixer isOpen={showMoodMixer} onClose={() => setShowMoodMixer(false)} />
                </Suspense>
            )}
        </div>
    );
}
