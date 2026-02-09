"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { useDownloadProgress } from "@/lib/download-progress-context";
import { searchResultStore } from "@/lib/search-result-store";
import { api } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3006/api";

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

            const es = new EventSource(`${API_BASE}/events?token=${token}`);
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
                        case "connected":
                            reconnectAttemptsRef.current = 0;
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
