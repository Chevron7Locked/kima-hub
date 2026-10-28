"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { useActiveDownloads } from "@/hooks/useNotifications";
import { GradientSpinner } from "../ui/GradientSpinner";
import { DownloadRow, RowAction } from "./DownloadRow";

export function ActiveDownloadsTab() {
    const { downloads, isLoading: loading, refetch } = useActiveDownloads();
    const [cancelling, setCancelling] = useState<Set<string>>(new Set());

    const handleCancel = async (id: string) => {
        setCancelling((prev) => new Set(prev).add(id));
        try {
            await api.deleteDownload(id);
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
            await Promise.all(ids.map((id) => api.deleteDownload(id)));
            refetch();
        } catch (error) {
            console.error("Failed to cancel all downloads:", error);
            refetch();
        } finally {
            setCancelling(new Set());
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <GradientSpinner size="sm" />
            </div>
        );
    }

    if (downloads.length === 0) {
        return <p className="px-3 py-4 text-xs text-[var(--text-muted)]">nothing downloading right now</p>;
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
                <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                    <span className="size-1.5 rounded-full bg-brand animate-pulse" aria-hidden />
                    <span className="tabular-nums">{downloads.length} downloading</span>
                </span>
                <button
                    type="button"
                    onClick={handleCancelAll}
                    className="rounded-full px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-white/10 hover:text-danger-light"
                >
                    cancel all
                </button>
            </div>

            <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
                {downloads.map((download) => (
                    <DownloadRow
                        key={download.id}
                        item={download}
                        tone="active"
                        actions={
                            <RowAction
                                label={`cancel ${download.subject}`}
                                onClick={() => handleCancel(download.id)}
                                disabled={cancelling.has(download.id)}
                                danger
                            >
                                {cancelling.has(download.id) ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <X className="size-4" />
                                )}
                            </RowAction>
                        }
                    />
                ))}
            </ul>
        </div>
    );
}
