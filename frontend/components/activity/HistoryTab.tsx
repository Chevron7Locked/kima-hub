"use client";

import { useState, useEffect } from "react";
import { CheckCircle, XCircle, Trash2, RotateCcw, History, Disc, Music } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";

interface DownloadHistory {
    id: string;
    subject: string;
    type: string;
    status: string;
    error?: string;
    createdAt: string;
    completedAt?: string;
}

export function HistoryTab() {
    const [history, setHistory] = useState<DownloadHistory[]>([]);
    const [loading, setLoading] = useState(true);
    const [retrying, setRetrying] = useState<Set<string>>(new Set());

    const fetchHistory = async () => {
        try {
            const data = await api.getDownloadHistory();
            setHistory(data);
        } catch (error) {
            console.error("Failed to fetch download history:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchHistory();

        // Refresh on window focus
        const handleFocus = () => fetchHistory();
        window.addEventListener("focus", handleFocus);
        return () => window.removeEventListener("focus", handleFocus);
    }, []);

    const handleClear = async (id: string) => {
        try {
            await api.clearDownloadFromHistory(id);
            setHistory((prev) => prev.filter((h) => h.id !== id));
        } catch (error) {
            console.error("Failed to clear download:", error);
        }
    };

    const handleClearAll = async () => {
        try {
            await api.clearAllDownloadHistory();
            setHistory([]);
        } catch (error) {
            console.error("Failed to clear all history:", error);
        }
    };

    const handleRetry = async (id: string) => {
        try {
            setRetrying((prev) => new Set(prev).add(id));
            const result = await api.retryFailedDownload(id);
            if (result.success) {
                // Remove from history (it's now in active)
                setHistory((prev) => prev.filter((h) => h.id !== id));
            }
        } catch (error) {
            console.error("Failed to retry download:", error);
        } finally {
            setRetrying((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const completed = history.filter((h) => h.status === "completed");
    const failed = history.filter((h) => h.status === "failed" || h.status === "exhausted");

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (history.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <History className="w-8 h-8 text-[var(--text-muted)] mb-3" />
                <p className="text-sm text-[var(--text-muted)]">No download history</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">Completed downloads will appear here</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header - monospace terminal style */}
            <div className="flex items-center justify-between px-3 py-2 border-b-2 border-white/10">
                <div className="flex items-center gap-3">
                    {completed.length > 0 && (
                        <span className="flex items-center gap-1.5 text-xs tabular-nums font-semibold text-green-400">
                            <CheckCircle className="w-3 h-3" />
                            {String(completed.length).padStart(2, "0")}
                        </span>
                    )}
                    {failed.length > 0 && (
                        <span className="flex items-center gap-1.5 text-xs tabular-nums font-semibold text-red-400">
                            <XCircle className="w-3 h-3" />
                            {String(failed.length).padStart(2, "0")}
                        </span>
                    )}
                </div>
                <button
                    onClick={handleClearAll}
                    className="text-micro font-semibold text-[var(--text-muted)] hover:text-white transition-colors"
                >
                    CLEAR
                </button>
            </div>

            {/* History list */}
            <div className="flex-1 overflow-y-auto">
                {/* Failed section first */}
                {failed.length > 0 && (
                    <div>
                        <div className="px-3 py-2 border-b-2 border-red-400/20 bg-red-400/5">
                            <span className="text-xs tabular-nums font-semibold text-red-400">
                                FAILED ({String(failed.length).padStart(2, "0")})
                            </span>
                        </div>
                        {failed.map((item, index) => (
                            <HistoryItem
                                key={item.id}
                                item={item}
                                index={index}
                                onClear={handleClear}
                                onRetry={handleRetry}
                                isRetrying={retrying.has(item.id)}
                            />
                        ))}
                    </div>
                )}

                {/* Completed section */}
                {completed.length > 0 && (
                    <div>
                        <div className="px-3 py-2 border-b-2 border-green-400/20 bg-green-400/5">
                            <span className="text-xs tabular-nums font-semibold text-green-400">
                                COMPLETED ({String(completed.length).padStart(2, "0")})
                            </span>
                        </div>
                        {completed.map((item, index) => (
                            <HistoryItem
                                key={item.id}
                                item={item}
                                index={index}
                                onClear={handleClear}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function HistoryItem({
    item,
    index,
    onClear,
    onRetry,
    isRetrying,
}: {
    item: DownloadHistory;
    index: number;
    onClear: (id: string) => void;
    onRetry?: (id: string) => void;
    isRetrying?: boolean;
}) {
    const isCompleted = item.status === "completed";
    const isFailed = item.status === "failed" || item.status === "exhausted";

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        if (diff < 60000) return "Just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return date.toLocaleDateString();
    };

    return (
        <div className={cn(
            "px-3 py-3 border-b border-white/5 transition-colors group border-l-2",
            isCompleted && "border-green-400/30 hover:bg-green-400/5",
            isFailed && "border-red-400/30 hover:bg-red-400/5"
        )}>
            <div className="flex items-start gap-3">
                {/* Index number */}
                <div className="flex-shrink-0 w-6 mt-0.5">
                    <span className="text-micro tabular-nums font-semibold text-[var(--text-muted)]">
                        {String(index + 1).padStart(2, "0")}
                    </span>
                </div>

                {/* Status icon */}
                <div className="mt-0.5 flex-shrink-0">
                    {isCompleted ? (
                        <CheckCircle className="w-4 h-4 text-green-400" />
                    ) : (
                        <XCircle className="w-4 h-4 text-red-400" />
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold tracking-tight text-white truncate mb-1">
                        {item.subject}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs tabular-nums text-[var(--text-muted)] flex items-center gap-1">
                            {item.type === "album" ? (
                                <Disc className="w-2.5 h-2.5" />
                            ) : (
                                <Music className="w-2.5 h-2.5" />
                            )}
                            {item.type}
                        </span>
                        <span className="text-micro text-[var(--text-muted)]">•</span>
                        <span className="text-xs tabular-nums text-[var(--text-muted)]">
                            {formatTime(item.completedAt || item.createdAt)}
                        </span>
                    </div>
                    {item.error && (
                        <p className="text-micro tabular-nums text-red-400/70 mt-1 line-clamp-2">
                            {item.error}
                        </p>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                    {isFailed && onRetry && (
                        <button
                            onClick={() => onRetry(item.id)}
                            disabled={isRetrying}
                            className={cn(
                                "p-1 hover:bg-white/10 transition-colors",
                                isRetrying && "opacity-50 cursor-not-allowed"
                            )}
                            title="Retry download"
                        >
                            <RotateCcw className={cn(
                                "w-3 h-3 text-[var(--text-muted)] hover:text-[#eab308]",
                                isRetrying && "animate-spin"
                            )} />
                        </button>
                    )}
                    <button
                        onClick={() => onClear(item.id)}
                        className="p-1 hover:bg-white/10 transition-colors"
                        title="Remove from history"
                    >
                        <Trash2 className="w-3 h-3 text-[var(--text-muted)] hover:text-red-400" />
                    </button>
                </div>
            </div>
        </div>
    );
}
