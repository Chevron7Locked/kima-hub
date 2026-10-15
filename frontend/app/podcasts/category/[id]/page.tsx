"use client";

import { useParams } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageMessage } from "@/components/ui/PageMessage";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { Button } from "@/components/ui/Button";
import { CategoryChips } from "@/features/podcast/components/CategoryChips";
import { PodcastCard } from "@/features/podcast/components/PodcastShelf";
import { queryKeys, usePodcastCategoriesQuery } from "@/hooks/useQueries";

const PAGE = 48;
/** Apple's charts stop at 200 shows. */
const CHART_MAX = 200;

/** One category's chart (or the overall chart at /podcasts/category/top), with its sub-categories as tabs. */
export default function PodcastCategoryPage() {
    const { id } = useParams<{ id: string }>();
    const { isAuthenticated } = useAuth();
    const categoryId = id === "top" ? null : Number(id);
    const valid = categoryId === null || Number.isInteger(categoryId);

    const { data: categories = [], isLoading: loadingCategories } = usePodcastCategoriesQuery(isAuthenticated);
    const chart = useInfiniteQuery({
        queryKey: queryKeys.podcastChartPages(categoryId),
        queryFn: ({ pageParam }) => api.getPodcastChart(categoryId, PAGE, pageParam),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => {
            const loaded = pages.reduce((n, p) => n + p.length, 0);
            return last.length === PAGE && loaded < CHART_MAX ? loaded : undefined;
        },
        enabled: isAuthenticated && valid,
        staleTime: 60 * 60 * 1000,
    });

    const category = categories.find((c) => c.id === categoryId);
    if (!valid || (categoryId !== null && !loadingCategories && !category)) {
        return <PageMessage title="no such category" action={{ label: "podcasts", href: "/podcasts" }} />;
    }
    if (chart.isLoading || loadingCategories) return <LoadingScreen />;
    if (chart.isError) {
        return <PageMessage title="couldn't reach apple podcasts" description="try again in a minute" action={{ label: "podcasts", href: "/podcasts" }} />;
    }

    // The tabs are the category's family: its own sub-categories, or its siblings when it is one.
    const parentId = category?.parentId ?? category?.id ?? null;
    const parent = categories.find((c) => c.id === parentId);
    const family = parentId === null ? [] : categories.filter((c) => c.parentId === parentId);
    const shows = chart.data?.pages.flat() ?? [];

    return (
        <div className="min-h-screen">
            <PageHeader
                title={category?.name ?? "top shows"}
                description={category ? `the top ${category.name} shows on apple podcasts` : "the top shows on apple podcasts"}
            >
                {parent && family.length > 0 && (
                    <CategoryChips
                        className="mt-5"
                        categories={[{ id: parent.id, name: `all ${parent.name}` }, ...family]}
                        active={category?.id}
                    />
                )}
            </PageHeader>

            <div className="page-shell relative pb-32 pt-2 animate-rise">
                {shows.length === 0 ? (
                    <p className="py-16 text-center text-sm text-[var(--text-muted)]">apple has no chart for this category right now</p>
                ) : (
                    <div className="grid-media">
                        {shows.map((p, index) => (
                            <PodcastCard key={p.itunesId} podcast={p} index={index % PAGE} ranked />
                        ))}
                    </div>
                )}
                {chart.hasNextPage && (
                    <div className="mt-10 flex justify-center">
                        <Button variant="secondary" onClick={() => chart.fetchNextPage()} isLoading={chart.isFetchingNextPage}>
                            show more
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
