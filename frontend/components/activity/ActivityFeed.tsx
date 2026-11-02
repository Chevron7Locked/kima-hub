"use client";

import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bell, Check, Download, ListMusic, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth-context";
import { timeAgo } from "@/lib/relative-time";
import { api } from "@/lib/api";
import { useActiveDownloads, useDownloadHistory, useNotifications, type DownloadHistoryItem } from "@/hooks/useNotifications";
import type { ActivityKind } from "./ActivityBody";
import { statusLabel, userImportsQuery } from "./ImportsTab";
import { ActivityIcon } from "./ActivityIcon";
import { ListHeader } from "./ListHeader";

interface FeedRow {
    key: string;
    opens: ActivityKind;
    icon: LucideIcon;
    tone: "busy" | "new" | "good" | "bad" | "quiet";
    title: string;
    detail?: string;
    at: string;
    /** 0-100 while something is running; undefined when it is not, or its progress is unknown. */
    progress?: number;
    running?: boolean;
    unread?: boolean;
}

const FINISHED_IMPORT = new Set(["completed", "failed", "cancelled"]);

/** A failed download's row, keyed by its reason: failures that share one share one fix. */
const failureReason = (row: FeedRow) => (row.tone === "bad" && row.opens === "history" ? row.detail : undefined);

/** Failed downloads that give the same reason, as one row at the newest one's place. */
function foldFailures(rows: FeedRow[]): FeedRow[] {
    const counts = new Map<string, number>();
    for (const row of rows) {
        const reason = failureReason(row);
        if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    const placed = new Set<string>();
    return rows.flatMap((row) => {
        const reason = failureReason(row);
        const count = reason ? counts.get(reason)! : 1;
        if (count < 2) return [row];
        if (placed.has(reason!)) return [];
        placed.add(reason!);
        return [{ ...row, key: `fold-${row.key}`, title: `${count} downloads failed` }];
    });
}
const MAX_ROWS = 40;

/**
 * Everything Kima is doing and has done, as one list: downloads still running first, then alerts, imports and
 * finished downloads, newest first. A row opens its own list, where its actions are; one button clears the finished.
 */
export function ActivityFeed({ onOpen }: { onOpen: (kind: ActivityKind) => void }) {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const { notifications, isLoading: loadingAlerts, clearAll } = useNotifications();
    const { downloads } = useActiveDownloads();
    const { history } = useDownloadHistory();
    const { data: imports = [] } = useQuery({ ...userImportsQuery, enabled: isAuthenticated });

    const running: FeedRow[] = [
        ...downloads.map<FeedRow>((d) => ({
            key: `dl-${d.id}`,
            opens: "downloads",
            icon: Download,
            tone: "busy",
            title: d.subject,
            detail: typeof d.metadata?.statusText === "string" ? d.metadata.statusText : "downloading",
            at: d.createdAt,
            progress: typeof d.metadata?.progress === "number" ? (d.metadata.progress as number) : undefined,
            running: true,
        })),
        ...imports
            .filter((i) => !FINISHED_IMPORT.has(i.status))
            .map<FeedRow>((i) => ({
                key: `im-${i.id}`,
                opens: "imports",
                icon: ListMusic,
                tone: "busy",
                title: i.playlistName,
                detail: `importing · ${statusLabel(i.status)}`,
                at: i.createdAt,
                progress: i.progress,
                running: true,
            })),
    ];

    const earlier: FeedRow[] = [
        ...notifications.map<FeedRow>((n) => ({
            key: `nt-${n.id}`,
            opens: "notifications",
            icon: n.type === "error" || n.type === "download_failed" ? AlertCircle : Bell,
            tone: n.type === "error" || n.type === "download_failed" ? "bad" : n.read ? "quiet" : "new",
            title: n.title,
            detail: n.message ?? undefined,
            at: n.createdAt,
            unread: !n.read,
        })),
        ...imports
            .filter((i) => FINISHED_IMPORT.has(i.status))
            .map<FeedRow>((i) => ({
                key: `im-${i.id}`,
                opens: "imports",
                icon: ListMusic,
                tone: i.status === "completed" ? "good" : "bad",
                title: i.playlistName,
                detail: i.status === "completed" ? "imported" : `import ${i.status}`,
                at: i.createdAt,
            })),
        ...history.map<FeedRow>((h) => ({
            key: `hi-${h.id}`,
            opens: "history",
            icon: h.status === "completed" ? Check : X,
            tone: h.status === "completed" ? "good" : "bad",
            title: h.subject,
            detail: h.status === "completed" ? "downloaded" : h.error || `download ${h.status}`,
            at: h.completedAt || h.updatedAt || h.createdAt,
        })),
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    const rows = [...running, ...foldFailures(earlier)].slice(0, MAX_ROWS);
    // The clear button empties what is finished: alerts and download history. Running work and imports stay.
    const clearable = notifications.length + history.length;
    // Both halves clear at once and each comes back if its request fails, as the alerts list's own clear does; the
    // history is read again afterwards, so a refresh that raced the clear cannot leave old rows or a false empty list.
    const clearing = useRef(false);
    const clear = async () => {
        if (clearing.current) return;
        clearing.current = true;
        clearAll();
        await queryClient.cancelQueries({ queryKey: ["download-history"] });
        const previous = queryClient.getQueryData<DownloadHistoryItem[]>(["download-history"]);
        queryClient.setQueryData<DownloadHistoryItem[]>(["download-history"], []);
        try {
            await api.clearAllDownloadHistory();
        } catch (error) {
            console.error("Failed to clear the download history:", error);
            if (previous) queryClient.setQueryData(["download-history"], previous);
        } finally {
            clearing.current = false;
            void queryClient.invalidateQueries({ queryKey: ["download-history"] });
        }
    };

    if (loadingAlerts && rows.length === 0) {
        return <p className="px-3 py-4 text-xs text-[var(--text-muted)]">loading…</p>;
    }
    if (rows.length === 0) {
        return <p className="px-3 py-4 text-xs text-[var(--text-muted)]">nothing happening, and nothing new</p>;
    }

    return (
        <>
            {clearable > 0 && <ListHeader action={{ label: "clear notifications", onClick: () => void clear() }} />}
            <ul className="py-1">
                {rows.map((row) => (
                    <li key={row.key}>
                        <button
                            type="button"
                            onClick={() => onOpen(row.opens)}
                            className="group flex w-full items-start gap-2.5 px-3 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60"
                        >
                            <ActivityIcon unread={row.unread}>
                                <row.icon
                                    aria-hidden="true"
                                    className={cn(
                                        "h-3.5 w-3.5",
                                        row.tone === "busy" && "text-brand",
                                        row.tone === "good" && "text-[var(--color-success)]",
                                        row.tone === "bad" && "text-danger-light",
                                        (row.tone === "new" || row.tone === "quiet") && "text-[var(--text-muted)]",
                                    )}
                                />
                            </ActivityIcon>
                            <span className="min-w-0 flex-1">
                                <span className="flex items-baseline gap-2">
                                    <span
                                        className={cn(
                                            "min-w-0 flex-1 truncate text-[13px] leading-5",
                                            row.tone === "quiet" ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]",
                                        )}
                                    >
                                        {/* The dot is for the eye; a screen reader hears the word. */}
                                        {row.unread && <span className="sr-only">new: </span>}
                                        {row.title}
                                    </span>
                                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
                                        {row.running ? (row.progress !== undefined ? `${Math.round(row.progress)}%` : "") : timeAgo(row.at)}
                                    </span>
                                </span>
                                {row.detail && (
                                    <span className="block truncate text-xs leading-4 text-[var(--text-muted)]">{row.detail}</span>
                                )}
                                {row.running && (
                                    <span aria-hidden="true" className="mt-1.5 block h-[2px] overflow-hidden rounded-full bg-white/[0.06]">
                                        {row.progress === undefined ? (
                                            <span className="block h-full w-1/3 animate-sweep bg-brand" />
                                        ) : (
                                            <span
                                                className="block h-full bg-brand transition-[width] duration-500"
                                                style={{ width: `${Math.max(2, Math.min(100, row.progress))}%` }}
                                            />
                                        )}
                                    </span>
                                )}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </>
    );
}
