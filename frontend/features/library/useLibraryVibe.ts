"use client";

/**
 * The library's mood picture: each mood's share of the analysed tracks for
 * the masthead band, and the mood each album and artist shares with its
 * tracks for the card dots. The server counts them (GET /vibe/mood-summary, a
 * few KB) so the page never downloads the whole vibe map. While the map is
 * still being laid out the band shows as a quiet track and no card is marked.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/hooks/useQueries";
import type { MoodShare } from "@/features/vibe/mapUtils";

const NO_SHARES: MoodShare[] = [];
const EMPTY_MAP = new Map<string, string>();

export function useLibraryVibe() {
    const { data } = useQuery({
        queryKey: queryKeys.libraryMoodSummary(),
        queryFn: () => api.getMoodSummary(),
        staleTime: 1000 * 60 * 10,
        gcTime: 1000 * 60 * 60,
        retry: 1,
        refetchInterval: (query) => (query.state.data && "computing" in query.state.data ? 4000 : false),
    });
    const summary = data && !("computing" in data) ? data : undefined;

    const shares = summary?.shares ?? NO_SHARES;
    const albumMood = useMemo(() => (summary ? new Map(Object.entries(summary.albums)) : EMPTY_MAP), [summary]);
    const artistMood = useMemo(() => (summary ? new Map(Object.entries(summary.artists)) : EMPTY_MAP), [summary]);

    return { shares, albumMood, artistMood };
}
