import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { MapTrack, VibeMode, PathResult } from "./types";

const PATH_STORAGE_KEY = "vibe-path-result";

function loadPersistedPath(): { path: PathResult; highlightedIds: Set<string> } | null {
    try {
        const raw = sessionStorage.getItem(PATH_STORAGE_KEY);
        if (!raw) return null;
        const path = JSON.parse(raw) as PathResult;
        const ids = new Set<string>();
        ids.add(path.startTrack.id);
        ids.add(path.endTrack.id);
        for (const t of path.path) ids.add(t.id);
        return { path, highlightedIds: ids };
    } catch {
        return null;
    }
}

export function useVibeMap() {
    const persisted = useMemo(() => loadPersistedPath(), []);
    const [mode, setMode] = useState<VibeMode>(persisted ? "path-result" : "idle");
    const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
    const [highlightedIds, setHighlightedIds] = useState<Set<string>>(persisted?.highlightedIds ?? new Set());
    const [pathResult, setPathResult] = useState<PathResult | null>(persisted?.path ?? null);
    const [pathStartId, setPathStartId] = useState<string | null>(null);

    const { data: mapData, isLoading, error, refetch } = useQuery({
        queryKey: ["vibe-map"],
        queryFn: () => api.getVibeMap(),
        staleTime: 1000 * 60 * 60,
        gcTime: 1000 * 60 * 60 * 24,
        retry: 1,
    });

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

    const setPathAndPersist = useCallback((result: PathResult | null) => {
        setPathResult(result);
        if (result) {
            try { sessionStorage.setItem(PATH_STORAGE_KEY, JSON.stringify(result)); } catch {}
        } else {
            sessionStorage.removeItem(PATH_STORAGE_KEY);
        }
    }, []);

    const startPathPicking = useCallback((fromTrackId: string) => {
        setMode("path-picking");
        setPathStartId(fromTrackId);
        setHighlightedIds(new Set([fromTrackId]));
    }, []);

    const completePathPicking = useCallback(async (endTrackId: string, overrideStartId?: string) => {
        const startId = overrideStartId || pathStartId;
        if (!startId) return null;
        setMode("path-result");
        try {
            const result = await api.getVibePath(startId, endTrackId);
            setPathAndPersist(result);
            const ids = new Set<string>();
            ids.add(result.startTrack.id);
            ids.add(result.endTrack.id);
            for (const t of result.path) ids.add(t.id);
            setHighlightedIds(ids);
            return result;
        } catch {
            setMode("idle");
            setHighlightedIds(new Set());
            setPathAndPersist(null);
            return null;
        }
    }, [pathStartId, setPathAndPersist]);

    const resetMode = useCallback(() => {
        setMode("idle");
        setSelectedTrackId(null);
        setHighlightedIds(new Set());
        setPathAndPersist(null);
        setPathStartId(null);
    }, [setPathAndPersist]);

    return {
        mapData,
        isLoading,
        error,
        refetch,
        trackMap,
        mode,
        selectedTrackId,
        highlightedIds,
        pathResult,
        selectTrack,
        showSimilar,
        startPathPicking,
        completePathPicking,
        resetMode,
        setMode,
        setHighlightedIds,
    };
}
