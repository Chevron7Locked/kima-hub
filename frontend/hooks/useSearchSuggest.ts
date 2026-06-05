/**
 * Phase H: typeahead/suggest hook for the global search box.
 *
 * Debounces the raw input (~200ms) and fetches a small, ranked set of artist +
 * album suggestions from GET /api/search/suggest. Backed by React Query so
 * repeated queries are cached and in-flight requests are aborted on change.
 * Returns empty for queries shorter than 2 chars (matches the backend guard).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface SuggestArtist {
    id: string;
    name: string;
    heroUrl: string | null;
}

export interface SuggestAlbum {
    id: string;
    title: string;
    artistName: string;
    coverUrl: string | null;
}

export interface SuggestResults {
    artists: SuggestArtist[];
    albums: SuggestAlbum[];
}

export function useSearchSuggest(query: string, debounceMs: number = 200) {
    const [debounced, setDebounced] = useState("");

    useEffect(() => {
        const trimmed = query.trim();
        const handle = setTimeout(() => setDebounced(trimmed), debounceMs);
        return () => clearTimeout(handle);
    }, [query, debounceMs]);

    const enabled = debounced.length >= 2;

    const { data, isFetching } = useQuery<SuggestResults>({
        queryKey: ["search-suggest", debounced],
        queryFn: ({ signal }) => api.getSearchSuggest(debounced, signal),
        enabled,
        staleTime: 60 * 1000, // mirrors the backend 60s cache
    });

    return {
        suggestions: enabled ? data ?? { artists: [], albums: [] } : { artists: [], albums: [] },
        isFetching: enabled && isFetching,
    };
}
