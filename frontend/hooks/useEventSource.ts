"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { searchResultStore } from "@/lib/search-result-store";
import { api, getApiBaseUrl } from "@/lib/api";
import { playlistEditsInFlight } from "@/hooks/useQueries";

/**
 * Every cache an event below keeps fresh. Events sent while the stream is down are not replayed, so a reconnect
 * refreshes them all. Job-status caches (scan, import, preview) are not here: their pages poll while a job runs.
 */
const STREAM_FED_QUERIES: QueryKey[] = [
    ["notifications"],
    ["active-downloads"],
    ["download-history"],
    ["album"],
    ["enrichment-progress"],
    ["library", "recently-added"],
    ["user-imports"],
    ["playlists"],
    ["playlist"],
];

export function useEventSource() {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const reconnectAttemptsRef = useRef(0);

    useEffect(() => {
        if (!isAuthenticated) return;

        let mounted = true;

        // Waits 1 s, then twice as long after each failure in a row, up to 30 s.
        const reconnectLater = () => {
            const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 30000);
            reconnectAttemptsRef.current++;
            reconnectTimeoutRef.current = setTimeout(() => { connect().catch(() => {}); }, delay);
        };

        const connect = async () => {
            if (!mounted) return;

            const ticket = await api.getSSETicket();
            if (!mounted) return;
            if (!ticket) {
                reconnectLater();
                return;
            }

            // In proxy mode the base is "", so events go through the streaming route in app/api/events.
            const es = new EventSource(`${getApiBaseUrl()}/api/events?ticket=${ticket}`);
            eventSourceRef.current = es;

            es.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);

                    switch (data.type) {
                        case "notification":
                        case "notification:cleared":
                        case "notification:read":
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            if (data.notificationType === "playlist_ready" || data.notificationType === "import_complete") {
                                queryClient.invalidateQueries({ queryKey: ["playlists"] });
                            }
                            break;
                        case "download:complete":
                            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
                            queryClient.invalidateQueries({ queryKey: ["download-history"] });
                            queryClient.invalidateQueries({ queryKey: ["notifications"] });
                            if (data.albumId) {
                                queryClient.invalidateQueries({ queryKey: ["album", data.albumId] });
                            }
                            break;
                        case "download:failed":
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
                            queryClient.invalidateQueries({ queryKey: ["user-imports"] });
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
                        case "playlist:updated":
                            if (data.playlistId) {
                                queryClient.invalidateQueries({ queryKey: ["playlists"] });
                                if (data.deleted) {
                                    // Gone: drop it where no page is using it, never ask the server for it again, and tell
                                    // a page still showing it (the same signal a delete on this device sends).
                                    queryClient.removeQueries({ queryKey: ["playlist", data.playlistId], type: "inactive" });
                                    window.dispatchEvent(new CustomEvent("playlist-deleted", { detail: { playlistId: data.playlistId } }));
                                } else if (playlistEditsInFlight(queryClient, data.playlistId) === 0) {
                                    // With this device's own edits on their way, the last of them asks instead.
                                    queryClient.invalidateQueries({ queryKey: ["playlist", data.playlistId] });
                                }
                            }
                            break;
                        case "connected":
                            // Only on a reconnect: the first connect follows pages that just fetched.
                            if (reconnectAttemptsRef.current > 0) {
                                for (const queryKey of STREAM_FED_QUERIES) {
                                    queryClient.invalidateQueries({
                                        queryKey,
                                        // A playlist with this device's own edits on their way: the last of them fetches it.
                                        predicate: (query) =>
                                            !(query.queryKey[0] === "playlist" &&
                                                playlistEditsInFlight(queryClient, String(query.queryKey[1])) > 0),
                                    });
                                }
                            }
                            reconnectAttemptsRef.current = 0;
                            // A Discover batch may have finished while the stream was down.
                            api.getDiscoverBatchStatus()
                                .then(status => {
                                    queryClient.setQueryData(["discover-batch-status"], status);
                                })
                                .catch(() => {
                                    queryClient.setQueryData(["discover-batch-status"], { active: false, status: null, batchId: null });
                                });
                            break;
                    }
                } catch {
                    // A message that is not JSON, or a handler that threw, must not close the stream.
                }
            };

            es.onerror = () => {
                es.close();
                eventSourceRef.current = null;
                if (mounted) reconnectLater();
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
    }, [isAuthenticated, queryClient]);
}
