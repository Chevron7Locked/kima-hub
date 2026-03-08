import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { MapTrack, VibeMode, PathResult } from "./types";

export function useVibeMap() {
    const [mode, setMode] = useState<VibeMode>("idle");
    const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
    const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
    const [pathResult, setPathResult] = useState<PathResult | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [pathStartId, setPathStartId] = useState<string | null>(null);

    const { data: mapData, isLoading, error } = useQuery({
        queryKey: ["vibe-map"],
        queryFn: () => api.getVibeMap(),
        staleTime: 1000 * 60 * 60,
        gcTime: 1000 * 60 * 60 * 24,
    });

    const trackMap = useMemo(() => {
        if (!mapData?.tracks) return new Map<string, MapTrack>();
        const map = new Map<string, MapTrack>();
        for (const track of mapData.tracks) {
            map.set(track.id, track);
        }
        return map;
    }, [mapData?.tracks]);

    const selectTrack = useCallback((trackId: string | null) => {
        setSelectedTrackId(trackId);
        if (!trackId) {
            if (mode === "similar" || mode === "search") {
                setMode("idle");
                setHighlightedIds(new Set());
            }
        }
    }, [mode]);

    const showSimilar = useCallback(async (trackId: string) => {
        setMode("similar");
        setSelectedTrackId(trackId);
        try {
            const result = await api.getVibeSimilarTracks(trackId, 50);
            const ids = new Set(result.tracks.map((t: { id: string }) => t.id));
            ids.add(trackId);
            setHighlightedIds(ids);
            return result.tracks;
        } catch {
            setMode("idle");
            setHighlightedIds(new Set());
            return [];
        }
    }, []);

    const searchVibe = useCallback(async (query: string) => {
        setSearchQuery(query);
        setMode("search");
        try {
            const result = await api.vibeSearch(query, 50);
            const ids = new Set(result.tracks.map((t: { id: string }) => t.id));
            setHighlightedIds(ids);
            return result.tracks;
        } catch {
            setMode("idle");
            setHighlightedIds(new Set());
            return [];
        }
    }, []);

    const startPathPicking = useCallback((fromTrackId: string) => {
        setMode("path-picking");
        setPathStartId(fromTrackId);
        setHighlightedIds(new Set([fromTrackId]));
    }, []);

    const completePathPicking = useCallback(async (endTrackId: string) => {
        if (!pathStartId) return null;
        setMode("path-result");
        try {
            const result = await api.getVibePath(pathStartId, endTrackId);
            setPathResult(result);
            const ids = new Set<string>();
            ids.add(result.startTrack.id);
            ids.add(result.endTrack.id);
            for (const t of result.path) ids.add(t.id);
            setHighlightedIds(ids);
            return result;
        } catch {
            setMode("idle");
            setHighlightedIds(new Set());
            setPathResult(null);
            return null;
        }
    }, [pathStartId]);

    const resetMode = useCallback(() => {
        setMode("idle");
        setSelectedTrackId(null);
        setHighlightedIds(new Set());
        setPathResult(null);
        setSearchQuery("");
        setPathStartId(null);
    }, []);

    return {
        mapData,
        isLoading,
        error,
        trackMap,
        mode,
        selectedTrackId,
        highlightedIds,
        pathResult,
        searchQuery,
        pathStartId,
        selectTrack,
        showSimilar,
        searchVibe,
        startPathPicking,
        completePathPicking,
        resetMode,
        setMode,
        setHighlightedIds,
    };
}
