"use client";

import { useState } from "react";
import { Download, Loader2, Music, Disc, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "../ui/GradientSpinner";
import { useActiveDownloads } from "@/hooks/useNotifications";

export function ActiveDownloadsTab() {
    // Use shared React Query hook instead of duplicate polling
    const { downloads, isLoading: loading, refetch } = useActiveDownloads();
    const [cancelling, setCancelling] = useState<Set<string>>(new Set());

    const handleCancel = async (id: string) => {
        setCancelling((prev) => new Set(prev).add(id));
        try {
            await api.deleteDownload(id);
            // Refetch to get updated list
            refetch();
        } catch (error) {
            console.error("Failed to cancel download:", error);
        } finally {
            setCancelling((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const handleCancelAll = async () => {
        const ids = downloads.map((d) => d.id);
        setCancelling(new Set(ids));
        try {
            // Cancel all downloads in parallel
            await Promise.all(ids.map((id) => api.deleteDownload(id)));
            refetch();
        } catch (error) {
            console.error("Failed to cancel all downloads:", error);
            refetch();
        } finally {
            setCancelling(new Set());
        }
    };

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        if (diff < 60000) return "Just started";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
        return date.toLocaleDateString();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (downloads.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <Download className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No active downloads</p>
                <p className="text-xs text-white/30 mt-1">
                    Downloads will appear here
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header - monospace terminal style */}
            <div className="flex items-center justify-between px-3 py-2 border-b-2 border-white/10">
                <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse" />
                    <span className="text-micro font-mono font-bold text-gray-600 uppercase tracking-wider">
                        {String(downloads.length).padStart(2, "0")} ACTIVE
                    </span>
                </div>
                <button
                    onClick={handleCancelAll}
                    className="text-micro font-mono font-bold text-gray-600 hover:text-red-400 uppercase tracking-wider transition-colors"
                    title="Cancel all downloads"
                >
                    CANCEL
                </button>
            </div>

            {/* Download list - data stream style */}
            <div className="flex-1 overflow-y-auto">
                {downloads.map((download, index) => (
                    <div
                        key={download.id}
                        className="px-3 py-3 border-b border-white/5 border-l-2 border-[#22c55e] bg-[var(--bg-secondary)] hover:bg-white/5 transition-colors group"
                    >
                        <div className="flex items-start gap-3">
                            {/* Index number */}
                            <div className="flex-shrink-0 w-6 mt-0.5">
                                <span className="text-micro font-mono font-bold text-gray-700">
                                    {String(index + 1).padStart(2, "0")}
                                </span>
                            </div>

                            {/* Status spinner */}
                            <div className="mt-0.5 shrink-0">
                                {cancelling.has(download.id) ? (
                                    <Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
                                ) : (
                                    <GradientSpinner size="sm" />
                                )}
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold tracking-tight text-white truncate uppercase mb-1">
                                    {download.subject}
                                </p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span
                                        className={cn(
                                            "text-micro font-mono font-bold uppercase tracking-wider",
                                            download.status === "processing"
                                                ? "text-blue-400"
                                                : "text-[#eab308]"
                                        )}
                                    >
                                        {download.status}
                                    </span>
                                    {download.metadata?.statusText && (
                                        <>
                                            <span className="text-micro font-mono text-gray-700">
                                                •
                                            </span>
                                            <span
                                                className={cn(
                                                    "text-micro font-mono font-bold uppercase tracking-wider",
                                                    download.metadata
                                                        .currentSource ===
                                                        "lidarr"
                                                        ? "text-purple-400"
                                                        : "text-teal-400"
                                                )}
                                            >
                                                {String(download.metadata.statusText)}
                                            </span>
                                        </>
                                    )}
                                    <span className="text-micro font-mono text-gray-700">
                                        •
                                    </span>
                                    <span className="text-micro font-mono text-gray-600 uppercase tracking-wider flex items-center gap-1">
                                        {download.type === "album" ? (
                                            <Disc className="w-2.5 h-2.5" />
                                        ) : (
                                            <Music className="w-2.5 h-2.5" />
                                        )}
                                        {download.type}
                                    </span>
                                    <span className="text-micro font-mono text-gray-700">
                                        •
                                    </span>
                                    <span className="text-micro font-mono text-gray-700 uppercase tracking-wider">
                                        {formatTime(download.createdAt)}
                                    </span>
                                </div>
                            </div>

                            {/* Cancel button */}
                            <button
                                onClick={() => handleCancel(download.id)}
                                disabled={cancelling.has(download.id)}
                                className="p-1 hover:bg-white/10 transition-colors shrink-0"
                                title="Cancel download"
                            >
                                <X className="w-3 h-3 text-gray-700 hover:text-red-400" />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
