"use client";

import DOMPurify from "dompurify";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useImageColor } from "@/hooks/useImageColor";

import { usePodcastData } from "@/features/podcast/hooks/usePodcastData";
import { usePodcastActions } from "@/features/podcast/hooks/usePodcastActions";

import { PodcastHero } from "@/features/podcast/components/PodcastHero";
import { PodcastActionBar } from "@/features/podcast/components/PodcastActionBar";
import { ContinueListening } from "@/features/podcast/components/ContinueListening";
import { EpisodeList } from "@/features/podcast/components/EpisodeList";
import { PreviewEpisodes } from "@/features/podcast/components/PreviewEpisodes";
import { SimilarPodcasts } from "@/features/podcast/components/SimilarPodcasts";

export default function PodcastDetailPage() {
    const {
        podcastId,
        podcast,
        previewData,
        displayData,
        isLoading,
        heroImage,
        colorExtractionImage,
        similarPodcasts,
        sortOrder,
        setSortOrder,
        inProgressEpisodes,
        sortedEpisodes,
    } = usePodcastData();

    const { colors } = useImageColor(colorExtractionImage);

    const {
        isSubscribing,
        isRefreshing,
        showDeleteConfirm,
        setShowDeleteConfirm,
        handleSubscribe,
        handleRemovePodcast,
        handleRefresh,
        handlePlayEpisode,
        handlePlayPauseEpisode,
        handleMarkEpisodeComplete,
        isEpisodePlaying,
        isPlaying,
        pause,
    } = usePodcastActions(podcastId, sortedEpisodes);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!podcast && !previewData) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <p className="text-xs font-mono text-gray-500 uppercase tracking-wider">Podcast not found</p>
            </div>
        );
    }

    if (!displayData) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    const isSubscribed = !!podcast;
    const episodeCount = podcast
        ? podcast.episodes.length
        : previewData?.episodeCount || 0;

    const handlePlayLatest = () => {
        if (sortedEpisodes.length > 0 && podcast) {
            // Play the most recent unfinished episode, or the latest episode
            const unfinished = sortedEpisodes.find(
                (ep) => !ep.progress?.isFinished
            );
            handlePlayEpisode(unfinished || sortedEpisodes[0], podcast);
        }
    };

    // Check if any episode from this podcast is currently playing
    const isPlayingPodcast = sortedEpisodes.some((ep) => isEpisodePlaying(ep.id)) && isPlaying;

    return (
        <div className="min-h-screen flex flex-col bg-gradient-to-b from-[#0a0a0a] to-black">
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
                    onPlayLatest={isSubscribed ? handlePlayLatest : undefined}
                    isPlayingPodcast={isPlayingPodcast}
                    onPause={pause}
                    onRefresh={handleRefresh}
                    isRefreshing={isRefreshing}
                />
            </PodcastHero>

            {/* Main Content */}
            <div className="relative flex-1">
                {/* Color gradient continuation */}
                <div
                    className="absolute inset-x-0 top-0 pointer-events-none"
                    style={{
                        height: "25vh",
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}10 0%, ${colors.vibrant}05 40%, transparent 100%)`
                            : "transparent",
                    }}
                />

                <div className="relative max-w-[1800px] mx-auto px-4 md:px-8 py-8 space-y-10">
                    {/* Continue Listening */}
                    {podcast && inProgressEpisodes.length > 0 && (
                        <div>
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
                        </div>
                    )}

                    {/* Preview Mode */}
                    {!podcast && previewData && (
                        <div>
                            <PreviewEpisodes
                                previewData={previewData}
                                colors={colors}
                                isSubscribing={isSubscribing}
                                onSubscribe={() => handleSubscribe(previewData)}
                            />
                        </div>
                    )}

                    {/* All Episodes */}
                    {podcast && (
                        <div>
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
                        </div>
                    )}

                    {/* About - for subscribed podcasts */}
                    {podcast?.description && (
                        <div>
                            <section>
                                <div className="flex items-center gap-3 mb-4">
                                    <span className="w-1 h-6 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
                                    <h2 className="text-xl font-black tracking-tighter uppercase">About</h2>
                                    <span className="flex-1 border-t border-white/10" />
                                </div>
                                <div className="relative overflow-hidden rounded-lg border border-white/10 bg-[#0a0a0a] p-5">
                                    <div
                                        className="prose prose-invert prose-sm max-w-none text-white/50 [&_a]:text-[#3b82f6] [&_a]:no-underline [&_a:hover]:underline text-sm leading-relaxed"
                                        dangerouslySetInnerHTML={{
                                            __html: DOMPurify.sanitize(podcast.description || ""),
                                        }}
                                    />
                                </div>
                            </section>
                        </div>
                    )}

                    {/* Similar Podcasts */}
                    {similarPodcasts.length > 0 && (
                        <div>
                            <SimilarPodcasts podcasts={similarPodcasts} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
