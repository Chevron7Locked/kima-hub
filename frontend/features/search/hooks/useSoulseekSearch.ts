import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { searchResultStore } from "@/lib/search-result-store";
import type { SoulseekResult } from "../types";
import { openActivityPanel } from "@/hooks/useActivityPanel";

interface UseSoulseekSearchProps {
    query: string;
}

interface UseSoulseekSearchReturn {
    soulseekResults: SoulseekResult[];
    isSoulseekSearching: boolean;
    isSoulseekPolling: boolean;
    soulseekEnabled: boolean;
    downloadingFiles: Set<string>;
    handleDownload: (result: SoulseekResult) => Promise<void>;
    handleBulkDownload: (results: SoulseekResult[]) => Promise<void>;
    uniqueUserCount: number;
}

export function useSoulseekSearch({
    query,
}: UseSoulseekSearchProps): UseSoulseekSearchReturn {
    const queryClient = useQueryClient();
    const [soulseekResults, setSoulseekResults] = useState<SoulseekResult[]>([]);
    const [isSoulseekSearching, setIsSoulseekSearching] = useState(false);
    const [soulseekEnabled, setSoulseekEnabled] = useState(false);
    const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
    const [isComplete, setIsComplete] = useState(false);
    const [hasActiveSearch, setHasActiveSearch] = useState(false);

    const searchIdRef = useRef<string | null>(null);

    useEffect(() => {
        const checkSoulseekStatus = async () => {
            try {
                const status = await api.getSlskdStatus();
                setSoulseekEnabled(Boolean(status.enabled));
            } catch (error) {
                console.error("Failed to check Soulseek status:", error);
                setSoulseekEnabled(false);
            }
        };

        checkSoulseekStatus();
    }, []);

    // Soulseek search with SSE streaming
    useEffect(() => {
        if (!query.trim() || !soulseekEnabled) return;

        let cancelled = false;
        const cleanupRef = { current: () => {} };

        const timer = setTimeout(async () => {
            if (cancelled) return;

            if (searchIdRef.current) {
                searchResultStore.clear(searchIdRef.current);
            }

            setIsSoulseekSearching(true);
            setIsComplete(false);
            setHasActiveSearch(false);
            setSoulseekResults([]);

            try {
                const { searchId } = await api.searchSoulseek(query);
                if (cancelled) return;

                searchIdRef.current = searchId;
                setIsSoulseekSearching(false);
                setHasActiveSearch(true);

                const syncFromStore = () => {
                    if (cancelled) return;
                    const session = searchResultStore.getSession(searchId);
                    if (session) {
                        setSoulseekResults([...session.results]);
                        if (session.complete) {
                            setIsComplete(true);
                        }
                    }
                };

                const unsubscribe = searchResultStore.subscribe(searchId, syncFromStore);

                // Immediately check for results that arrived during the POST roundtrip
                syncFromStore();

                cleanupRef.current = () => {
                    unsubscribe();
                    searchResultStore.clear(searchId);
                };
            } catch (error) {
                if (cancelled) return;
                console.error("Soulseek search error:", error);
                if (error instanceof Error && error.message?.includes("not enabled")) {
                    setSoulseekEnabled(false);
                }
                setIsSoulseekSearching(false);
            }
        }, 800);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            cleanupRef.current();
            if (searchIdRef.current) {
                searchResultStore.clear(searchIdRef.current);
                searchIdRef.current = null;
            }
            setHasActiveSearch(false);
            setSoulseekResults([]);
        };
    }, [query, soulseekEnabled]);

    // The "complete" event can be lost, so the search is marked complete after a
    // ceiling. Only the spinner stops; late results still arrive.
    useEffect(() => {
        if (!hasActiveSearch || isComplete) return;
        const timeout = setTimeout(() => setIsComplete(true), 45000);
        return () => clearTimeout(timeout);
    }, [hasActiveSearch, isComplete]);

    const handleDownload = useCallback(async (result: SoulseekResult) => {
        const downloadKey = `${result.username}:${result.path}`;
        try {
            setDownloadingFiles((prev) => new Set([...prev, downloadKey]));

            await api.downloadFromSoulseek(
                result.username,
                result.path,
                result.filename,
                result.size,
                result.parsedArtist,
                result.parsedAlbum,
                result.parsedTitle,
            );

            if (typeof window !== "undefined") {
                openActivityPanel("active");
                queryClient.invalidateQueries({ queryKey: ["notifications"] });
            }

            setTimeout(() => {
                setDownloadingFiles((prev) => {
                    const newSet = new Set(prev);
                    newSet.delete(downloadKey);
                    return newSet;
                });
            }, 5000);
        } catch (error) {
            console.error("Download error:", error);
            notify.error("Failed to start download", { message: error instanceof Error ? error.message : undefined });
            setDownloadingFiles((prev) => {
                const newSet = new Set(prev);
                newSet.delete(downloadKey);
                return newSet;
            });
        }
    }, [queryClient]);

    const handleBulkDownload = useCallback(async (results: SoulseekResult[]) => {
        // Four concurrent kickoffs. handleDownload handles its own errors, so
        // one failure does not stop the rest.
        const POOL_SIZE = 4;
        let next = 0;
        const worker = async () => {
            while (next < results.length) {
                const result = results[next++];
                await handleDownload(result);
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(POOL_SIZE, results.length) },
                () => worker(),
            ),
        );
    }, [handleDownload]);

    const uniqueUserCount = useMemo(
        () => new Set(soulseekResults.map((r) => r.username)).size,
        [soulseekResults],
    );

    return {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling: !isComplete && !isSoulseekSearching && hasActiveSearch && !!query.trim() && soulseekEnabled,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
        handleBulkDownload,
        uniqueUserCount,
    };
}
