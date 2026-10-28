"use client";

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { GradientSpinner } from "../ui/GradientSpinner";
import { cn } from "@/lib/cn";
import { useDownloadHistory, type DownloadHistoryItem } from "@/hooks/useNotifications";
import { DownloadRow, RowAction } from "./DownloadRow";
import { usePublicConfig } from "@/hooks/useQueries";

export function HistoryTab() {
    const queryClient = useQueryClient();
    const { history, isLoading: loading } = useDownloadHistory();
    const { canAcquire } = usePublicConfig();
    const [retrying, setRetrying] = useState<Set<string>>(new Set());
    const [retryFailed, setRetryFailed] = useState<Record<string, string>>({});

    const setHistory = (update: (prev: DownloadHistoryItem[]) => DownloadHistoryItem[]) =>
        queryClient.setQueryData<DownloadHistoryItem[]>(["download-history"], (prev = []) => update(prev));

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
            setHistory(() => []);
        } catch (error) {
            console.error("Failed to clear all history:", error);
        }
    };

    const handleRetry = async (id: string) => {
        setRetrying((prev) => new Set(prev).add(id));
        setRetryFailed(({ [id]: _, ...rest }) => rest);
        try {
            const result = await api.retryFailedDownload(id);
            if (!result.success) throw new Error("The retry did not start");
            setHistory((prev) => prev.filter((h) => h.id !== id));
            queryClient.invalidateQueries({ queryKey: ["active-downloads"] });
        } catch (error) {
            const reason = error instanceof Error ? error.message : "The retry did not start";
            setRetryFailed((prev) => ({ ...prev, [id]: `Retry failed: ${reason}` }));
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
                <GradientSpinner size="sm" />
            </div>
        );
    }

    if (history.length === 0) {
        return <p className="px-3 py-4 text-xs text-[var(--text-muted)]">no finished downloads yet</p>;
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-end px-4 py-2.5 border-b border-white/10">
                <button
                    type="button"
                    onClick={handleClearAll}
                    className="rounded-full px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-white/10 hover:text-white"
                >
                    clear all
                </button>
            </div>

            <div className="flex-1 overflow-y-auto">
                {failed.length > 0 && (
                    <Section label="failed" count={failed.length}>
                        {failed.map((item) => (
                            <DownloadRow
                                key={item.id}
                                item={item}
                                tone="failed"
                                notice={retryFailed[item.id]}
                                actions={
                                    <>
                                        {canAcquire && (
                                            <RowAction
                                                label={`retry ${item.subject}`}
                                                onClick={() => handleRetry(item.id)}
                                                disabled={retrying.has(item.id)}
                                            >
                                                <RotateCcw className={cn("size-4", retrying.has(item.id) && "animate-spin")} />
                                            </RowAction>
                                        )}
                                        <RowAction label={`remove ${item.subject} from history`} onClick={() => handleClear(item.id)} danger>
                                            <Trash2 className="size-4" />
                                        </RowAction>
                                    </>
                                }
                            />
                        ))}
                    </Section>
                )}
                {completed.length > 0 && (
                    <Section label="completed" count={completed.length}>
                        {completed.map((item) => (
                            <DownloadRow
                                key={item.id}
                                item={item}
                                tone="completed"
                                actions={
                                    <RowAction label={`remove ${item.subject} from history`} onClick={() => handleClear(item.id)} danger>
                                        <Trash2 className="size-4" />
                                    </RowAction>
                                }
                            />
                        ))}
                    </Section>
                )}
            </div>
        </div>
    );
}

function Section({ label, count, children }: { label: string; count: number; children: ReactNode }) {
    return (
        <section className="pb-2">
            <h3 className="sticky top-0 z-10 flex items-baseline gap-2 bg-[var(--bg-secondary)]/95 px-4 py-2 backdrop-blur-sm">
                <span className="text-[0.6875rem] tracking-[0.12em] text-[var(--text-muted)]">{label}</span>
                <span className="text-[0.6875rem] tabular-nums text-[var(--text-muted)] opacity-60">{count}</span>
            </h3>
            <ul className="space-y-0.5 px-2">{children}</ul>
        </section>
    );
}
