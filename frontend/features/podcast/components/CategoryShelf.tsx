"use client";

import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { usePodcastChartQuery } from "@/hooks/useQueries";
import { PodcastShelf } from "./PodcastShelf";
import type { CategoryRef } from "../types";

const ROW = 12;

/**
 * True once the element is within `margin` of the visible part of the page. The page scrolls inside
 * #main-content, not the window, so that is the observer's root: a margin on the window would be clipped away.
 */
function useNearScreen<T extends HTMLElement>(margin: string) {
    const ref = useRef<T | null>(null);
    const [near, setNear] = useState(false);
    // No IntersectionObserver (an old browser, a test renderer): load at once. False on the server so hydration
    // matches.
    const noObserver = typeof window !== "undefined" && typeof IntersectionObserver === "undefined";
    useEffect(() => {
        const node = ref.current;
        if (!node || near || noObserver) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setNear(true);
                    observer.disconnect();
                }
            },
            { root: node.closest<HTMLElement>("#main-content"), rootMargin: `${margin} 0px ${margin} 0px` },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [near, noObserver, margin]);
    return { ref, near: near || noObserver };
}

/**
 * One category's top shows as a row, linking to its whole chart. The chart is asked for only once the row is
 * near the screen: each chart Kima has not cached costs one request to Apple, and Apple's limit is shared.
 */
export function CategoryShelf({ category, enabled }: { category: CategoryRef; enabled: boolean }) {
    const { ref, near } = useNearScreen<HTMLElement>("600px");
    // Queued for Apple behind anything a person is waiting on (a show page, the top shows).
    const { data: shows, isError, refetch, isFetching } = usePodcastChartQuery(category.id, ROW, enabled && near, true);

    // A category whose chart Apple sends empty has nothing to show.
    if (shows && shows.length === 0) return null;
    return (
        // A TV remote moves only between sections holding cards, so a row joins them once its shows are in.
        <section ref={ref} className="min-h-[260px]" data-tv-section={shows ? `category-${category.id}` : undefined}>
            <SectionHeader type="podcast" title={category.name} showAllHref={`/podcasts/category/${category.id}`} />
            {isError && !shows ? (
                <p className="text-sm text-[var(--text-muted)]">
                    couldn&apos;t reach apple podcasts.{" "}
                    <button type="button" className="text-brand hover:underline disabled:opacity-50" disabled={isFetching} onClick={() => refetch()}>
                        try again
                    </button>
                </p>
            ) : (
                shows && <PodcastShelf podcasts={shows} />
            )}
        </section>
    );
}
