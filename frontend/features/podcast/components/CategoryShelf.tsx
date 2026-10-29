"use client";

import { useInView } from "@/hooks/useInView";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { usePodcastChartQuery } from "@/hooks/useQueries";
import { PodcastShelf, PodcastShelfPlaceholder } from "./PodcastShelf";
import type { CategoryRef } from "../types";

const ROW = 12;

/**
 * One category's top shows as a row, linking to its whole chart. The chart is asked for only once the row is
 * near the screen: each chart Kima has not cached costs one request to Apple, and Apple's limit is shared.
 */
export function CategoryShelf({ category, enabled }: { category: CategoryRef; enabled: boolean }) {
    const { ref, shown: near } = useInView<HTMLElement>({ threshold: 0, rootMargin: "600px 0px 600px 0px", withinMain: true });
    // Queued for Apple behind anything a person is waiting on (a show page, the top shows).
    const { data: shows, isError, refetch, isFetching } = usePodcastChartQuery(category.id, ROW, enabled && near, true);

    // A category whose chart Apple sends empty has nothing to show.
    if (shows && shows.length === 0) return null;
    return (
        // A TV remote moves only between sections holding cards, so a row joins them once its shows are in.
        <section
            ref={ref}
            aria-busy={!shows && !isError ? true : undefined}
            data-tv-section={shows ? `category-${category.id}` : undefined}
        >
            <SectionHeader type="podcast" title={category.name} showAllHref={`/podcasts/category/${category.id}`} />
            {isError && !shows ? (
                <p className="text-sm text-[var(--text-muted)]">
                    couldn&apos;t reach apple podcasts.{" "}
                    <button type="button" className="text-brand hover:underline disabled:opacity-50" disabled={isFetching} onClick={() => refetch()}>
                        try again
                    </button>
                </p>
            ) : shows ? (
                <PodcastShelf podcasts={shows} />
            ) : (
                // Apple is asked one chart every 3 s, so a row can wait a while: it holds its height meanwhile.
                <PodcastShelfPlaceholder />
            )}
        </section>
    );
}
