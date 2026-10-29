"use client";

import DOMPurify from "dompurify";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { usePreview } from "@/hooks/usePreview";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import type { Episode } from "@/features/podcast/types";

import { usePodcastData } from "@/features/podcast/hooks/usePodcastData";
import { usePodcastActions } from "@/features/podcast/hooks/usePodcastActions";

import { PodcastHero } from "@/features/podcast/components/PodcastHero";
import { ColorWash } from "@/features/spoken/ColorWash";
import { PodcastActionBar } from "@/features/podcast/components/PodcastActionBar";
import { ContinueListening } from "@/features/podcast/components/ContinueListening";
import { EpisodeList } from "@/features/podcast/components/EpisodeList";
import { PreviewEpisodes } from "@/features/podcast/components/PreviewEpisodes";
import { PodcastShelf } from "@/features/podcast/components/PodcastShelf";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageMessage } from "@/components/ui/PageMessage";

export default function PodcastDetailPage() {
    const {
        podcastId,
        podcast,
        previewData,
        previewLoadState,
        previewError,
        displayData,
        isLoading,
        heroImage,
        colorExtractionImage,
        similarPodcasts,
        sortOrder,
        setSortOrder,
        inProgressEpisodes,
        episodes,
        episodesUpdating,
        hasMore,
        loadMore,
        loadingMore,
    } = usePodcastData();

    const { colors } = useImageColor(colorExtractionImage);
    const preview = usePreview();

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
    } = usePodcastActions(podcastId);

    if (previewLoadState === "error") {
        return (
            <PageMessage
                title="couldn't load this podcast"
                description={previewError || undefined}
                action={{ label: "podcasts", href: "/podcasts" }}
            />
        );
    }

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (!podcast && !previewData) {
        return <PageMessage title="podcast not found" action={{ label: "podcasts", href: "/podcasts" }} />;
    }

    if (!displayData) {
        return <LoadingScreen />;
    }

    const isSubscribed = !!podcast;
    const episodeCount = podcast
        ? podcast.episodeTotal ?? podcast.episodes.length
        : previewData?.episodeCount || 0;
    const categories = podcast?.categories ?? previewData?.categories;
    const snippetId = previewData?.itunesId ? `snippet:${previewData.itunesId}` : null;

    // The most recent unfinished episode, or the latest; the list shown oldest
    // first holds the oldest page, so the newest is asked for.
    const handlePlayLatest = async () => {
        if (!podcast) return;
        try {
            const newest: Episode[] =
                sortOrder === "newest" ? episodes : (await api.getPodcast(podcast.id, { order: "newest", limit: 20 })).episodes;
            const pick = newest.find((ep) => !ep.progress?.isFinished) ?? newest[0];
            if (pick) handlePlayEpisode(pick, podcast);
        } catch (error) {
            notify.error("Couldn't load the latest episode", { message: error instanceof Error ? error.message : undefined });
        }
    };

    const isPlayingPodcast = episodes.some((ep) => isEpisodePlaying(ep.id)) && isPlaying;

    return (
        <div className="min-h-screen flex flex-col bg-gradient-to-b from-[#0a0a0a] to-black">
            <PodcastHero
                title={displayData.title}
                author={displayData.author}
                description={displayData.description}
                genres={displayData.genres}
                categories={categories}
                heroImage={heroImage}
                colors={colors}
                episodeCount={episodeCount}
                inProgressCount={inProgressEpisodes.length}
            >
                <PodcastActionBar
                    isSubscribed={isSubscribed}
                    feedUrl={podcast?.feedUrl || previewData?.feedUrl}
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
                    snippet={previewData?.snippet ?? null}
                    snippetPlaying={snippetId !== null && preview.previewId === snippetId && preview.playing}
                    onToggleSnippet={
                        snippetId && previewData?.itunesId
                            ? () => preview.toggle(snippetId, api.getPodcastSnippetUrl(previewData.itunesId!), "episode")
                            : undefined
                    }
                />
            </PodcastHero>

            <div className="relative flex-1">
                <ColorWash colors={colors} />

                <div className="relative page-shell py-8 section-stack">
                    {podcast && inProgressEpisodes.length > 0 && (
                        <div>
                            <ContinueListening
                                inProgressEpisodes={inProgressEpisodes}
                                episodes={episodes}
                                isEpisodePlaying={isEpisodePlaying}
                                isPlaying={isPlaying}
                                onPlayEpisode={(episode) => handlePlayEpisode(episode, podcast)}
                                onPlayPause={(episode) => handlePlayPauseEpisode(episode, podcast)}
                            />
                        </div>
                    )}

                    {displayData.description && (
                        <section>
                            <SectionHeader title="about" type="podcast" />
                            <div
                                className="prose prose-invert prose-sm max-w-[70ch] text-sm leading-relaxed text-[var(--text-secondary)]"
                                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(displayData.description) }}
                            />
                        </section>
                    )}

                    {!podcast && previewData && <PreviewEpisodes previewData={previewData} />}

                    {podcast && (
                        <div>
                            <EpisodeList
                                episodes={episodes}
                                sortOrder={sortOrder}
                                onSortOrderChange={setSortOrder}
                                isEpisodePlaying={isEpisodePlaying}
                                isPlaying={isPlaying}
                                onPlayPause={(episode) => handlePlayPauseEpisode(episode, podcast)}
                                onMarkComplete={handleMarkEpisodeComplete}
                                fallbackCoverUrl={podcast.coverUrl}
                                total={episodeCount}
                                updating={episodesUpdating}
                                onLoadMore={hasMore ? () => loadMore() : undefined}
                                loadingMore={loadingMore}
                            />
                        </div>
                    )}

                    {similarPodcasts.length > 0 && (
                        <section>
                            <SectionHeader title="more like this" type="podcast" />
                            <PodcastShelf podcasts={similarPodcasts} />
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
}
