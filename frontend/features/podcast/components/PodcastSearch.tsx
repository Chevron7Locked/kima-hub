"use client";

import { useEffect, useRef, useState } from "react";
import type { EpisodeSearchResult, PodcastShowResult } from "@/lib/api";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useRouter } from "next/navigation";
import { Mic2, Search } from "lucide-react";
import { useDiscoverSearchQuery, useSearchQuery } from "@/hooks/useQueries";
import { CachedImage } from "@/components/ui/CachedImage";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { coverArtUrl } from "@/lib/cover-art";
import { formatDate } from "../utils";

const MIN_QUERY = 2;

/**
 * Search shows (Apple's catalogue, to open or follow) and episodes (the shows you follow) in one box; results open the
 * show's page. It searches once typing pauses; a search the typing has moved past is dropped.
 */
export function PodcastSearch() {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [searched, setSearched] = useState("");
    const [open, setOpen] = useState(false);
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const timer = setTimeout(() => setSearched(query.trim()), 350);
        return () => clearTimeout(timer);
    }, [query]);
    const showsFound = useDiscoverSearchQuery(searched, "podcasts", 8, true);
    const episodesFound = useSearchQuery(searched, "episodes", 6, true);
    const shows: PodcastShowResult[] = showsFound.data?.results ?? [];
    const episodes: EpisodeSearchResult[] = episodesFound.data?.episodes ?? [];

    useClickOutside([box], () => setOpen(false), open);

    const go = (href: string) => {
        setOpen(false);
        router.push(href);
    };
    const hasQuery = query.trim().length >= MIN_QUERY;
    const searching = hasQuery && (searched !== query.trim() || showsFound.isFetching || episodesFound.isFetching);
    const nothing = !searching && shows.length === 0 && episodes.length === 0;
    // The box opens with typing but shows only once there is an answer for what was typed.
    const answered = hasQuery && (shows.length > 0 || episodes.length > 0 || !searching);

    return (
        <div ref={box} className="relative w-full sm:w-96">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
                type="text"
                enterKeyHint="search"
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => hasQuery && setOpen(true)}
                onKeyDown={(e) => {
                    if (e.key !== "Escape" || !open) return;
                    e.preventDefault();
                    setOpen(false);
                }}
                placeholder="search shows and episodes"
                aria-label="search shows and episodes"
                className="w-full rounded-lg border-2 border-white/10 bg-[var(--bg-primary)] py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-[var(--text-muted)] focus:border-brand/50 focus:outline-none"
            />
            {searching && hasQuery && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    <GradientSpinner size="sm" />
                </span>
            )}
            {open && answered && (
                <div
                    role="region"
                    aria-label="search results"
                    className="absolute left-0 top-full z-(--z-dropdown) mt-2 max-h-[28rem] w-full overflow-y-auto rounded-lg border-2 border-white/10 bg-[var(--bg-secondary)]"
                >
                    {shows.length > 0 && <p className="px-3 pt-3 pb-1 text-xs font-semibold text-[var(--text-muted)]">shows</p>}
                    {shows.map((s) => {
                        const cover = coverArtUrl(s.coverUrl, 80);
                        return (
                            <button
                                key={`show-${s.id}`}
                                type="button"
                                onClick={() => go(`/podcasts/${s.id}`)}
                                className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
                            >
                                <span className="relative size-10 shrink-0 overflow-hidden rounded-md bg-[var(--bg-primary)]">
                                    {cover ? (
                                        <CachedImage src={cover} alt="" fill sizes="40px" className="object-cover" />
                                    ) : (
                                        <Mic2 className="absolute inset-0 m-auto size-4 text-[var(--text-muted)]" />
                                    )}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-semibold text-white">{s.name}</span>
                                    <span className="block truncate text-xs text-[var(--text-muted)]">
                                        {[s.artist, s.genres?.[0]].filter(Boolean).join(" · ")}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                    {episodes.length > 0 && <p className="px-3 pt-3 pb-1 text-xs font-semibold text-[var(--text-muted)]">episodes</p>}
                    {episodes.map((ep) => (
                        <button
                            key={`ep-${ep.id}`}
                            type="button"
                            onClick={() => go(`/podcasts/${ep.podcastId}`)}
                            className="block w-full px-3 py-2 text-left transition-colors hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
                        >
                            <span className="block truncate text-sm text-white">{ep.title}</span>
                            <span className="block truncate text-xs tabular-nums text-[var(--text-muted)]">
                                {[ep.podcastTitle, formatDate(ep.publishedAt)].filter(Boolean).join(" · ")}
                            </span>
                        </button>
                    ))}
                    {nothing && <p className="p-4 text-center text-xs text-[var(--text-muted)]">nothing found for “{query.trim()}”</p>}
                </div>
            )}
        </div>
    );
}
