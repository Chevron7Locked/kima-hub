"use client";

import { useState, useEffect, useMemo } from "react";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioState } from "@/lib/audio-state-context";
import { api } from "@/lib/api";
import { parseLRC, type LyricLine } from "@/lib/lyrics-utils";

interface LyricsResult {
    trackId: string;
    plainLyrics: string | null;
    syncedLyrics: string | null;
    source: string | null;
}

interface LyricsSyncState {
    lines: LyricLine[];
    activeIndex: number;
    isLoading: boolean;
    hasLyrics: boolean;
    isSynced: boolean;
    plainLyrics: string | null;
    source: string | null;
}

export function useLyricsSync(): LyricsSyncState {
    const { currentTime } = useAudioPlayback();
    const { currentTrack } = useAudioState();
    const [result, setResult] = useState<LyricsResult | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const trackId = currentTrack?.id ?? null;

    // Render-time reset when track changes (follows useImageColor pattern)
    const [prevTrackId, setPrevTrackId] = useState(trackId);
    if (trackId !== prevTrackId) {
        setPrevTrackId(trackId);
        setIsLoading(!!trackId);
    }

    // Fetch lyrics when track changes
    useEffect(() => {
        if (!trackId) return;

        let cancelled = false;

        api.getTrackLyrics(trackId)
            .then((res) => {
                if (cancelled) return;
                setResult({
                    trackId,
                    plainLyrics: res.plainLyrics,
                    syncedLyrics: res.syncedLyrics,
                    source: res.source,
                });
                setIsLoading(false);
            })
            .catch(() => {
                if (cancelled) return;
                setResult({ trackId, plainLyrics: null, syncedLyrics: null, source: null });
                setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [trackId]);

    // Derive effective lyrics -- only use result if it matches current track
    const syncedLyrics = result?.trackId === trackId ? result.syncedLyrics : null;
    const plainLyrics = result?.trackId === trackId ? result.plainLyrics : null;
    const source = result?.trackId === trackId ? result.source : null;

    const lines = useMemo(
        () => (syncedLyrics ? parseLRC(syncedLyrics) : []),
        [syncedLyrics]
    );

    const isSynced = lines.length > 0;

    // Binary search for active line
    const activeIndex = useMemo(() => {
        if (!isSynced || lines.length === 0) return -1;

        const timeMs = currentTime * 1000;
        if (timeMs < lines[0].time) return -1;

        let lo = 0;
        let hi = lines.length - 1;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (lines[mid].time <= timeMs) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return hi;
    }, [lines, isSynced, currentTime]);

    const hasLyrics = isSynced || (plainLyrics !== null && plainLyrics.length > 0);

    return {
        lines,
        activeIndex,
        isLoading,
        hasLyrics,
        isSynced,
        plainLyrics,
        source,
    };
}
