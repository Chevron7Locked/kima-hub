"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Mic2, Plus, RefreshCw, Rss, X } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/cn";
import { subscribeQueryEvent } from "@/lib/query-events";
import { scrollMainToTop } from "@/lib/scroll";
import { coverArtUrl } from "@/lib/cover-art";
import { usePodcastsQuery, queryKeys } from "@/hooks/useQueries";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { Pagination } from "@/components/ui/Pagination";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { MediaCard } from "@/components/cards/MediaCard";
import { PodcastSearch } from "@/features/podcast/components/PodcastSearch";
import { PodcastShelf } from "@/features/podcast/components/PodcastShelf";
import { ListeningShelf } from "@/features/podcast/components/ListeningShelf";
import { NewEpisodes } from "@/features/podcast/components/NewEpisodes";
import { CategoryChips } from "@/features/podcast/components/CategoryChips";

const LISTENING_KEY = ["podcasts", "listening"] as const;
type SortOption = "title" | "author" | "recent";

export default function PodcastsPage() {
    const { isAuthenticated } = useAuth();
    const router = useRouter();
    const queryClient = useQueryClient();

    const { data: podcasts = [], isLoading } = usePodcastsQuery();
    const { data: listening } = useQuery({
        queryKey: LISTENING_KEY,
        queryFn: () => api.getPodcastListening(),
        enabled: isAuthenticated,
        staleTime: 30 * 1000,
    });
    const { data: forYou = [] } = useQuery({
        queryKey: ["podcasts", "for-you"],
        queryFn: () => api.getPodcastsForYou(),
        enabled: isAuthenticated,
        staleTime: 10 * 60 * 1000,
    });
    const { data: categories = [] } = useQuery({
        queryKey: ["podcasts", "categories"],
        queryFn: () => api.getPodcastCategories(),
        enabled: isAuthenticated,
        staleTime: 60 * 60 * 1000,
    });
    const { data: topShows = [] } = useQuery({
        queryKey: ["podcasts", "chart", "all"],
        queryFn: () => api.getPodcastChart(null, 24),
        enabled: isAuthenticated,
        staleTime: 60 * 60 * 1000,
    });

    // Progress saved while listening moves episodes between "new" and "continue listening".
    useEffect(
        () => subscribeQueryEvent("podcast-progress-updated", () => queryClient.invalidateQueries({ queryKey: LISTENING_KEY })),
        [queryClient],
    );

    const [showRssInput, setShowRssInput] = useState(false);
    const [rssUrl, setRssUrl] = useState("");
    const [isSubscribingRss, setIsSubscribingRss] = useState(false);
    const [rssError, setRssError] = useState<string | null>(null);
    const [isRefreshingAll, setIsRefreshingAll] = useState(false);
    const [sortBy, setSortBy] = useState<SortOption>("title");
    const [itemsPerPage, setItemsPerPage] = useState(50);
    const [currentPage, setCurrentPage] = useState(1);

    const handleRefreshAll = async () => {
        setIsRefreshingAll(true);
        try {
            await api.refreshAllPodcasts();
            queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
            queryClient.invalidateQueries({ queryKey: LISTENING_KEY });
        } catch (error) {
            notify.error("Couldn't refresh your podcasts", { message: error instanceof Error ? error.message : undefined });
        } finally {
            setIsRefreshingAll(false);
        }
    };

    const handleRssSubscribe = async () => {
        const url = rssUrl.trim();
        if (!url) return;
        try {
            new URL(url);
        } catch {
            setRssError("that isn't a valid address");
            return;
        }
        setIsSubscribingRss(true);
        setRssError(null);
        try {
            const result = await api.subscribePodcast(url);
            if (result.success && result.podcast?.id) {
                queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
                router.push(`/podcasts/${result.podcast.id}`);
            }
            setRssUrl("");
            setShowRssInput(false);
        } catch (error: unknown) {
            setRssError(error instanceof Error ? error.message : "couldn't follow this feed");
        } finally {
            setIsSubscribingRss(false);
        }
    };

    const sortedPodcasts = useMemo(() => {
        const sorted = [...podcasts];
        if (sortBy === "title") sorted.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        if (sortBy === "author") sorted.sort((a, b) => (a.author || "").localeCompare(b.author || ""));
        if (sortBy === "recent") sorted.sort((a, b) => (b.episodeCount || 0) - (a.episodeCount || 0));
        return sorted;
    }, [podcasts, sortBy]);
    const totalPages = Math.ceil(sortedPodcasts.length / itemsPerPage);
    const pagedPodcasts = sortedPodcasts.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    const showPage = (page: number) => {
        setCurrentPage(page);
        scrollMainToTop();
    };

    if (isLoading) return <LoadingScreen />;

    const topLevel = categories.filter((c) => c.parentId === null);
    const inProgress = listening?.inProgress ?? [];
    const newEpisodes = listening?.newEpisodes ?? [];

    return (
        <div className="min-h-screen">
            <PageHeader
                title="podcasts"
                description={podcasts.length > 0 ? `${podcasts.length} followed` : "find shows by category, sample their first episode, follow the ones you like"}
                actions={
                    <>
                        <PodcastSearch />
                        {!showRssInput && (
                            <Button variant="secondary" onClick={() => setShowRssInput(true)}>
                                <Rss className="size-4" />
                                add rss feed
                            </Button>
                        )}
                    </>
                }
            >
                {showRssInput && (
                    <div className="mt-4 max-w-xl">
                        <div className="flex items-start gap-2">
                            <input
                                type="url"
                                value={rssUrl}
                                onChange={(e) => {
                                    setRssUrl(e.target.value);
                                    setRssError(null);
                                }}
                                onKeyDown={(e) => e.key === "Enter" && handleRssSubscribe()}
                                placeholder="https://example.com/feed.xml"
                                aria-label="rss feed address"
                                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder:text-[var(--text-muted)] focus:border-brand focus:outline-none"
                                autoFocus
                            />
                            <Button variant="primary" onClick={handleRssSubscribe} disabled={!rssUrl.trim()} isLoading={isSubscribingRss}>
                                {!isSubscribingRss && <Plus className="size-4" />}
                                follow
                            </Button>
                            <button
                                onClick={() => {
                                    setShowRssInput(false);
                                    setRssUrl("");
                                    setRssError(null);
                                }}
                                aria-label="cancel"
                                className="rounded-lg p-2.5 text-[var(--text-muted)] transition-colors hover:bg-white/5 hover:text-white"
                            >
                                <X className="size-4" />
                            </button>
                        </div>
                        {rssError && <p className="mt-1 text-xs text-danger-light">{rssError}</p>}
                    </div>
                )}
            </PageHeader>

            <div className="page-shell section-stack relative pb-32 pt-2 animate-rise">
                {inProgress.length > 0 && (
                    <section>
                        <SectionHeader type="podcast" title="continue listening" />
                        <ListeningShelf rows={inProgress} />
                    </section>
                )}

                {newEpisodes.length > 0 && (
                    <section>
                        <SectionHeader type="podcast" title="new from your shows" />
                        <NewEpisodes rows={newEpisodes.slice(0, 10)} />
                    </section>
                )}

                {podcasts.length > 0 && (
                    <section>
                        <SectionHeader
                            type="podcast"
                            title="your shows"
                            count={podcasts.length}
                            action={
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={handleRefreshAll}
                                        disabled={isRefreshingAll}
                                        className="flex items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:border-white/10 hover:bg-white/5 hover:text-white disabled:opacity-50"
                                        title="check every show for new episodes"
                                    >
                                        <RefreshCw className={cn("size-3.5", isRefreshingAll && "animate-spin")} />
                                        <span className="hidden md:inline">{isRefreshingAll ? "checking" : "check for new episodes"}</span>
                                    </button>
                                    <select
                                        value={sortBy}
                                        onChange={(e) => {
                                            setSortBy(e.target.value as SortOption);
                                            setCurrentPage(1);
                                        }}
                                        aria-label="sort your shows"
                                        className="cursor-pointer rounded-lg border-2 border-white/10 bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-white focus:border-brand/50 focus:outline-none [&>option]:bg-[var(--bg-primary)]"
                                    >
                                        <option value="title">title</option>
                                        <option value="author">author</option>
                                        <option value="recent">episodes</option>
                                    </select>
                                    {podcasts.length > 25 && (
                                        <select
                                            value={itemsPerPage}
                                            onChange={(e) => {
                                                setItemsPerPage(Number(e.target.value));
                                                setCurrentPage(1);
                                            }}
                                            aria-label="shows per page"
                                            className="cursor-pointer rounded-lg border-2 border-white/10 bg-[var(--bg-primary)] px-3 py-1.5 text-xs tabular-nums text-white focus:border-brand/50 focus:outline-none [&>option]:bg-[var(--bg-primary)]"
                                        >
                                            <option value={25}>25</option>
                                            <option value={50}>50</option>
                                            <option value={100}>100</option>
                                            <option value={250}>250</option>
                                        </select>
                                    )}
                                </div>
                            }
                        />
                        <div className="grid-media" data-tv-section="your-shows">
                            {pagedPodcasts.map((p, index) => (
                                <MediaCard
                                    key={p.id}
                                    href={`/podcasts/${p.id}`}
                                    title={p.title}
                                    subtitle={p.author}
                                    imageUrl={coverArtUrl(p.coverUrl)}
                                    fallbackIcon={Mic2}
                                    type="podcast"
                                    index={index}
                                />
                            ))}
                        </div>
                        <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={showPage} label="your shows" className="mt-8" />
                    </section>
                )}

                {forYou.map((row) => (
                    <section key={row.category.id}>
                        <SectionHeader type="podcast" title={`for you · ${row.category.name}`} showAllHref={`/podcasts/category/${row.category.id}`} />
                        <p className="-mt-2 mb-3 text-xs text-[var(--text-muted)]">because you follow {row.because.join(" and ")}</p>
                        <PodcastShelf podcasts={row.podcasts} />
                    </section>
                ))}

                {topLevel.length > 0 && (
                    <section>
                        <SectionHeader type="podcast" title="browse" />
                        <CategoryChips categories={topLevel} />
                    </section>
                )}

                {topShows.length > 0 && (
                    <section>
                        <SectionHeader type="podcast" title="top shows" showAllHref="/podcasts/category/top" />
                        <PodcastShelf podcasts={topShows} ranked />
                    </section>
                )}
            </div>
        </div>
    );
}
