import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { MapTrack, VibeMode } from "./types";

/**
 * The vibe map, shared by the vibe page and the library's mood picture. The first layout of a large library is
 * computed in the background: the server answers "computing" (`computing` true, no `mapData`) and it is asked again
 * every 4 s until it is ready.
 */
export function useVibeMapQuery() {
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ["vibe-map"],
        queryFn: () => api.getVibeMap(),
        staleTime: 1000 * 60 * 60,
        gcTime: 1000 * 60 * 60 * 24,
        retry: 1,
        refetchInterval: (query) => (query.state.data && "computing" in query.state.data ? 4000 : false),
    });
    const computing = !!data && "computing" in data;
    const mapData = data && !("computing" in data) ? data : undefined;
    return { mapData, computing, isLoading, error, refetch };
}

export function useVibeMap() {
    const [mode, setMode] = useState<VibeMode>("idle");
    const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
    const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
    const { mapData, computing, isLoading, error, refetch } = useVibeMapQuery();

    const tracks = mapData?.tracks;
    const trackMap = useMemo(() => {
        if (!tracks) return new Map<string, MapTrack>();
        const map = new Map<string, MapTrack>();
        for (const track of tracks) {
            map.set(track.id, track);
        }
        return map;
    }, [tracks]);

    const selectTrack = useCallback((trackId: string | null) => {
        setSelectedTrackId(trackId);
        if (!trackId) {
            if (mode === "similar" || mode === "search") {
                setMode("idle");
                setHighlightedIds(new Set());
            }
        }
    }, [mode]);

    const resetMode = useCallback(() => {
        setMode("idle");
        setSelectedTrackId(null);
        setHighlightedIds(new Set());
    }, []);

    return {
        mapData,
        isLoading,
        computing,
        error,
        refetch,
        trackMap,
        mode,
        selectedTrackId,
        highlightedIds,
        selectTrack,
        resetMode,
        setMode,
        setHighlightedIds,
    };
}
