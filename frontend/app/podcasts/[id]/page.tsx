"use client";

import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useImageColor } from "@/hooks/useImageColor";

// Hooks
import { usePodcastData } from "@/features/podcast/hooks/usePodcastData";
import { usePodcastActions } from "@/features/podcast/hooks/usePodcastActions";

// Components
import { PodcastHero } from "@/features/podcast/components/PodcastHero";
import { PodcastActionBar } from "@/features/podcast/components/PodcastActionBar";
import { ContinueListening } from "@/features/podcast/components/ContinueListening";
import { EpisodeList } from "@/features/podcast/components/EpisodeList";
import { PreviewEpisodes } from "@/features/podcast/components/PreviewEpisodes";
import { SimilarPodcasts } from "@/features/podcast/components/SimilarPodcasts";

export default function PodcastDetailPage() {
    // Data hook
    const {
        podcastId,
        podcast,
        previewData,
        displayData,
        isLoading,
        heroImage,
        similarPodcasts,
        sortOrder,
        setSortOrder,
        inProgressEpisodes,
        sortedEpisodes,
    } = usePodcastData();

    // Extract colors from the proxied image URL
    const { colors } = useImageColor(heroImage);

    // Action hooks - pass sortedEpisodes for queue building
    const {
        isSubscribing,
        showDeleteConfirm,
        setShowDeleteConfirm,
        handleSubscribe,
        handleRemovePodcast,
        handlePlayEpisode,
        handlePlayPauseEpisode,
        handleMarkEpisodeComplete,
        isEpisodePlaying,
        isPlaying,
    } = usePodcastActions(podcastId, sortedEpisodes);

    // Loading state
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!podcast && !previewData) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-500">Podcast not found</p>
            </div>
        );
    }

    // Safety check
    if (!displayData) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    const isSubscribed = !!podcast;
    const episodeCount = podcast
        ? podcast.episodes.length
        : previewData?.episodeCount || 0;

    return (
        <div className="min-h-screen flex flex-col">
            <PodcastHero
                title={displayData.title}
                author={displayData.author}
                description={displayData.description}
                genres={displayData.genres}
                heroImage={heroImage}
                colors={colors}
                episodeCount={episodeCount}
                inProgressCount={inProgressEpisodes.length}
            >
                <PodcastActionBar
                    isSubscribed={isSubscribed}
                    feedUrl={podcast?.feedUrl || previewData?.feedUrl}
                    colors={colors}
                    isSubscribing={isSubscribing}
                    showDeleteConfirm={showDeleteConfirm}
                    onSubscribe={() => handleSubscribe(previewData)}
                    onRemove={handleRemovePodcast}
                    onShowDeleteConfirm={setShowDeleteConfirm}
                />
            </PodcastHero>

            {/* Main Content */}
            <div className="relative flex-1">
                {/* Fixed height gradient - not dependent on content */}
                <div
                    className="absolute inset-x-0 top-0 pointer-events-none"
                    style={{
                        height: "25vh",
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}15 0%, ${colors.vibrant}08 40%, transparent 100%)`
                            : "transparent",
                    }}
                />

                <div className="relative px-4 md:px-8 py-6 space-y-8">
                    {/* Continue Listening - Only for subscribed podcasts */}
                    {podcast && inProgressEpisodes.length > 0 && (
                        <ContinueListening
                            podcast={podcast}
                            inProgressEpisodes={inProgressEpisodes}
                            sortedEpisodes={sortedEpisodes}
                            isEpisodePlaying={isEpisodePlaying}
                            isPlaying={isPlaying}
                            onPlayEpisode={(episode) => handlePlayEpisode(episode, podcast)}
                            onPlayPause={(episode) =>
                                handlePlayPauseEpisode(episode, podcast)
                            }
                        />
                    )}

                    {/* Preview Mode - Show Episode Teasers */}
                    {!podcast && previewData && (
                        <PreviewEpisodes
                            previewData={previewData}
                            colors={colors}
                            isSubscribing={isSubscribing}
                            onSubscribe={() => handleSubscribe(previewData)}
                        />
                    )}

                    {/* All Episodes - Only Show When Subscribed */}
                    {podcast && (
                        <EpisodeList
                            podcast={podcast}
                            episodes={sortedEpisodes}
                            sortOrder={sortOrder}
                            onSortOrderChange={setSortOrder}
                            isEpisodePlaying={isEpisodePlaying}
                            isPlaying={isPlaying}
                            onPlayPause={(episode) =>
                                handlePlayPauseEpisode(episode, podcast)
                            }
                            onPlay={(episode) => handlePlayEpisode(episode, podcast)}
                            onMarkComplete={handleMarkEpisodeComplete}
                        />
                    )}

                    {/* Similar Podcasts */}
                    <SimilarPodcasts podcasts={similarPodcasts} />
                </div>
            </div>
        </div>
    );
}
