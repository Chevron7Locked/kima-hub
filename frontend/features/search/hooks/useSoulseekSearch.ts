import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { searchResultStore } from "@/lib/search-result-store";
import type { SoulseekResult } from "../types";

interface UseSoulseekSearchProps {
    query: string;
}

interface UseSoulseekSearchReturn {
    soulseekResults: SoulseekResult[];
    isSoulseekSearching: boolean;
    isSoulseekPolling: boolean;
    isSearchComplete: boolean;
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
        if (!query.trim() || !soulseekEnabled) {
            setSoulseekResults([]);
            return;
        }

        let cancelled = false;

        const timer = setTimeout(async () => {
            if (cancelled) return;

            // Clear previous search
            if (searchIdRef.current) {
                searchResultStore.clear(searchIdRef.current);
            }

            setIsSoulseekSearching(true);
            setIsComplete(false);
            setSoulseekResults([]);

            try {
                const { searchId } = await api.searchSoulseek(query);
                if (cancelled) return;

                searchIdRef.current = searchId;
                setIsSoulseekSearching(false);

                // Read store and update state
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

                // Subscribe to SSE-driven store updates
                const unsubscribe = searchResultStore.subscribe(searchId, syncFromStore);

                // Immediately check for results that arrived during the POST roundtrip
                syncFromStore();

                // Store unsubscribe for cleanup
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

        const cleanupRef = { current: () => {} };

        return () => {
            cancelled = true;
            clearTimeout(timer);
            cleanupRef.current();
            if (searchIdRef.current) {
                searchResultStore.clear(searchIdRef.current);
                searchIdRef.current = null;
            }
        };
    }, [query, soulseekEnabled]);

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
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", { detail: { tab: "active" } }),
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
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
            const message =
                error instanceof Error ? error.message : "Failed to start download";
            toast.error(message);
            setDownloadingFiles((prev) => {
                const newSet = new Set(prev);
                newSet.delete(downloadKey);
                return newSet;
            });
        }
    }, [queryClient]);

    const handleBulkDownload = useCallback(async (results: SoulseekResult[]) => {
        for (const result of results) {
            await handleDownload(result);
        }
    }, [handleDownload]);

    const uniqueUserCount = useMemo(
        () => new Set(soulseekResults.map((r) => r.username)).size,
        [soulseekResults],
    );

    return {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling: !isComplete && !isSoulseekSearching && !!searchIdRef.current && !!query.trim() && soulseekEnabled,
        isSearchComplete: isComplete,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
        handleBulkDownload,
        uniqueUserCount,
    };
}
