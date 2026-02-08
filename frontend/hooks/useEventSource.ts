"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { useDownloadProgress } from "@/lib/download-progress-context";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3006/api";

export function useEventSource() {
    const { token, isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const { updateProgress, clearProgress } = useDownloadProgress();
    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        if (!isAuthenticated || !token) return;

        let mounted = true;

        const connect = () => {
            if (!mounted) return;

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
                            break;
                        case "download:failed":
                            clearProgress(data.jobId);
                            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
                            queryClient.invalidateQueries({ queryKey: ["download-history"] });
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            break;
                        case "connected":
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
                    reconnectTimeoutRef.current = setTimeout(connect, 5000);
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
    }, [isAuthenticated, token, queryClient, updateProgress, clearProgress]);
}
