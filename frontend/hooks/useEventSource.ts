"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { useDownloadProgress } from "@/lib/download-progress-context";
import { searchResultStore } from "@/lib/search-result-store";
import { api, getApiBaseUrl } from "@/lib/api";

/**
 * Returns the base URL for SSE connections.
 * Uses getApiBaseUrl() directly -- in proxy/all-in-one mode this returns ""
 * (relative path), which hits the dedicated SSE proxy route (app/api/events/route.ts)
 * that properly streams events without buffering.
 */
function getSSEBaseUrl(): string {
    if (typeof window === "undefined") return "";
    return getApiBaseUrl();
}

export function useEventSource() {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const { updateProgress, clearProgress } = useDownloadProgress();
    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const reconnectAttemptsRef = useRef(0);

    useEffect(() => {
        if (!isAuthenticated) return;

        let mounted = true;

        const connect = () => {
            if (!mounted) return;

            const token = api.getToken();
            if (!token) return;

            const es = new EventSource(`${getSSEBaseUrl()}/api/events?token=${token}`);
            eventSourceRef.current = es;

            es.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);

                    switch (data.type) {
                        case "notification":
                        case "notification:cleared":
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            if (data.notificationType === "playlist_ready" || data.notificationType === "import_complete") {
                                queryClient.invalidateQueries({ queryKey: ["playlists"] });
                            }
                            break;
                        case "download:progress":
                            updateProgress(data.jobId, {
                                bytesReceived: data.bytesReceived,
                                totalBytes: data.totalBytes,
                                filename: data.filename,
                            });
                            break;
                        case "download:queued":
                            updateProgress(data.jobId, {
                                queuePosition: data.position,
                                username: data.username,
                                filename: data.filename,
                            });
                            break;
                        case "download:complete":
                            clearProgress(data.jobId);
                            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
                            queryClient.invalidateQueries({ queryKey: ["download-history"] });
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            if (data.albumId) {
                                queryClient.invalidateQueries({ queryKey: ["album", data.albumId] });
                            }
                            break;
                        case "download:failed":
                            clearProgress(data.jobId);
                            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
                            queryClient.invalidateQueries({ queryKey: ["download-history"] });
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            break;
                        case "search:result":
                            if (data.searchId && data.results) {
                                searchResultStore.push(data.searchId, data.results);
                            }
                            break;
                        case "search:complete":
                            if (data.searchId) {
                                searchResultStore.complete(data.searchId);
                            }
                            break;
                        case "scan:progress":
                            queryClient.setQueryData(
                                ["scan-status", data.jobId],
                                { status: "active", progress: data.progress, jobId: data.jobId }
                            );
                            break;
                        case "scan:complete":
                            queryClient.setQueryData(
                                ["scan-status", data.jobId],
                                { status: data.error ? "failed" : "completed", progress: 100, jobId: data.jobId, result: data.result, error: data.error }
                            );
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            queryClient.invalidateQueries({ queryKey: ["enrichment-progress"] });
                            queryClient.invalidateQueries({ queryKey: ["library", "recently-added"] });
                            break;
                        case "enrichment:progress":
                            queryClient.invalidateQueries({ queryKey: ["enrichment-progress"] });
                            break;
                        case "import:progress":
                            queryClient.setQueryData(
                                ["import-status", data.jobId],
                                data
                            );
                            if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
                                queryClient.invalidateQueries({ queryKey: ["notifications"] });
                                queryClient.invalidateQueries({ queryKey: ["playlists"] });
                            }
                            break;
                        case "discover:progress":
                            queryClient.setQueryData(
                                ["discover-batch-status"],
                                { active: true, status: data.status, batchId: data.batchId, progress: data.progress, completed: data.completed, failed: data.failed, total: data.total }
                            );
                            break;
                        case "discover:complete":
                            queryClient.setQueryData(
                                ["discover-batch-status"],
                                { active: false, status: null, batchId: data.batchId }
                            );
                            queryClient.invalidateQueries({ queryKey: ["discover-playlist"] });
                            break;
                        case "preview:progress":
                            queryClient.setQueryData(
                                ["preview-status", data.jobId],
                                { status: "running", phase: data.phase, message: data.message, jobId: data.jobId }
                            );
                            break;
                        case "preview:complete":
                            queryClient.setQueryData(
                                ["preview-status", data.jobId],
                                { status: data.error ? "failed" : "completed", preview: data.preview, error: data.error, jobId: data.jobId }
                            );
                            break;
                        case "connected":
                            reconnectAttemptsRef.current = 0;
                            // Refresh notifications and downloads on connect/reconnect
                            // to pick up any events missed while disconnected
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
                            queryClient.invalidateQueries({ queryKey: ["download-history"] });
                            // Sync batch status after reconnect to clear stale cache
                            api.getDiscoverBatchStatus()
                                .then(status => {
                                    queryClient.setQueryData(["discover-batch-status"], status);
                                })
                                .catch(() => {
                                    // On error, assume no active batch
                                    queryClient.setQueryData(["discover-batch-status"], { active: false, status: null, batchId: null });
                                });
                            break;
                    }
                } catch {
                    // Ignore parse errors (heartbeat comments, etc.)
                }
            };

            es.onerror = () => {
                es.close();
                eventSourceRef.current = null;
                if (mounted) {
                    const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
                    reconnectAttemptsRef.current++;
                    reconnectTimeoutRef.current = setTimeout(connect, delay);
                }
            };
        };

        connect();

        return () => {
            mounted = false;
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
            }
        };
    }, [isAuthenticated, queryClient, updateProgress, clearProgress]);
}
