"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
    ListMusic,
    Loader2,
    X,
    CheckCircle2,
    AlertCircle,
    ExternalLink,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { GradientSpinner } from "../ui/GradientSpinner";
import { useAuth } from "@/lib/auth-context";
import { timeAgo } from "@/lib/relative-time";
import { ListHeader } from "./ListHeader";
import { ActivityIcon } from "./ActivityIcon";

export interface ImportJob {
    id: string;
    playlistName: string;
    status: string;
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number;
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: string;
}

const ACTIVE_STATUSES = [
    "pending",
    "fetching",
    "downloading",
    "scanning",
    "creating_playlist",
    "matching_tracks",
];

/** The statuses whose word changes on screen; any other shows as the server names it, with spaces for underscores. */
const STATUS_LABEL: Record<string, string> = {
    creating_playlist: "creating",
    matching_tracks: "matching",
    completed: "done",
};

export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status.replace(/_/g, " ");

/** The listener's imports, one query and cache for the imports list and the merged activity list. */
export const userImportsQuery = {
    queryKey: ["user-imports"],
    queryFn: () => api.get<ImportJob[]>("/spotify/imports"),
};

function statusColor(status: string): string {
    if (ACTIVE_STATUSES.includes(status)) return "text-brand";
    if (status === "completed") return "text-success";
    if (status === "failed") return "text-danger-light";
    if (status === "cancelled") return "text-warning";
    return "text-[var(--text-muted)]";
}

export function ImportsTab() {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const [cancelling, setCancelling] = useState<Set<string>>(new Set());

    const { data: imports = [], isLoading } = useQuery({
        ...userImportsQuery,
        enabled: isAuthenticated,
        refetchInterval: 10000,
        refetchIntervalInBackground: false,
    });

    const handleCancel = async (jobId: string) => {
        setCancelling((prev) => new Set(prev).add(jobId));
        try {
            await api.post(`/spotify/import/${jobId}/cancel`);
            queryClient.invalidateQueries({ queryKey: ["user-imports"] });
        } catch (error) {
            console.error("Failed to cancel import:", error);
        } finally {
            setCancelling((prev) => {
                const next = new Set(prev);
                next.delete(jobId);
                return next;
            });
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-8">
                <GradientSpinner size="sm" />
            </div>
        );
    }

    if (imports.length === 0) {
        return <p className="px-3 py-4 text-xs text-[var(--text-muted)]">no playlist imports yet</p>;
    }

    const activeImports = imports.filter((j) =>
        ACTIVE_STATUSES.includes(j.status),
    );
    const pastImports = imports.filter(
        (j) => !ACTIVE_STATUSES.includes(j.status),
    );

    return (
        <div className="flex flex-col h-full">
            <ListHeader>
                <span>
                    {activeImports.length > 0 ? (
                        <span className="text-brand">{activeImports.length} importing</span>
                    ) : (
                        <>
                            {pastImports.length} {pastImports.length === 1 ? "import" : "imports"}
                        </>
                    )}
                    {activeImports.length > 0 && pastImports.length > 0 && <> · {pastImports.length} earlier</>}
                </span>
            </ListHeader>

            <ul className="flex-1 overflow-y-auto pb-1">
                {activeImports.map((job) => (
                    <ImportJobCard
                        key={job.id}
                        job={job}
                        cancelling={cancelling.has(job.id)}
                        onCancel={handleCancel}
                    />
                ))}
                {pastImports.map((job) => (
                    <ImportJobCard key={job.id} job={job} cancelling={false} onCancel={handleCancel} />
                ))}
            </ul>
        </div>
    );
}

function ImportJobCard({
    job,
    cancelling,
    onCancel,
}: {
    job: ImportJob;
    cancelling: boolean;
    onCancel: (id: string) => void;
}) {
    const isActive = ACTIVE_STATUSES.includes(job.status);
    const facts = [
        statusLabel(job.status),
        isActive && job.albumsTotal > 0 ? `${job.albumsCompleted}/${job.albumsTotal} albums` : null,
        job.tracksMatched > 0 ? `${job.tracksMatched} tracks matched` : null,
    ].filter(Boolean);

    return (
        <li className="group flex items-start gap-2.5 px-3 py-2 transition-colors duration-150 hover:bg-white/[0.04] focus-within:bg-white/[0.04]">
            <ActivityIcon>
                {isActive ? (
                    cancelling ? (
                        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
                    ) : (
                        <ListMusic aria-hidden="true" className="h-3.5 w-3.5 text-brand" />
                    )
                ) : job.status === "completed" ? (
                    <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-success" />
                ) : (
                    <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 text-danger-light" />
                )}
            </ActivityIcon>

            <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-[var(--text-primary)]">
                        {job.playlistName}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{timeAgo(job.createdAt)}</span>
                </p>
                <p className={cn("truncate text-xs leading-4", isActive ? "text-[var(--text-secondary)]" : statusColor(job.status))}>
                    {facts.join(" · ")}
                </p>

                {isActive && job.albumsTotal > 0 && (
                    <div aria-hidden="true" className="mt-1.5 h-[2px] overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                            className="h-full rounded-full bg-brand transition-[width] duration-500"
                            style={{ width: `${Math.round((job.albumsCompleted / job.albumsTotal) * 100)}%` }}
                        />
                    </div>
                )}

                {job.status === "failed" && job.error && (
                    <p className="mt-0.5 truncate text-xs text-danger-light/80">{job.error}</p>
                )}

                {job.status === "completed" && job.createdPlaylistId && (
                    <Link
                        href={`/playlist/${job.createdPlaylistId}`}
                        className="mt-1 inline-flex items-center gap-1 rounded-sm text-[11px] text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                        open the playlist
                        <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
                    </Link>
                )}
            </div>

            {isActive && (
                <button
                    type="button"
                    onClick={() => onCancel(job.id)}
                    disabled={cancelling}
                    aria-label={`cancel importing ${job.playlistName}`}
                    title="cancel import"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] outline-none transition-colors hover:bg-danger/10 hover:text-danger-light focus-visible:ring-2 focus-visible:ring-brand/60 disabled:opacity-40"
                >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
            )}
        </li>
    );
}
