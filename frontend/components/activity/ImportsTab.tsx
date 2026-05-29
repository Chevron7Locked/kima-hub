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
import { cn } from "@/utils/cn";
import { GradientSpinner } from "../ui/GradientSpinner";
import { useAuth } from "@/lib/auth-context";

interface ImportJob {
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

function statusLabel(status: string): string {
    switch (status) {
        case "pending":
            return "PENDING";
        case "fetching":
            return "FETCHING";
        case "downloading":
            return "DOWNLOADING";
        case "scanning":
            return "SCANNING";
        case "creating_playlist":
            return "CREATING";
        case "matching_tracks":
            return "MATCHING";
        case "completed":
            return "DONE";
        case "failed":
            return "FAILED";
        case "cancelled":
            return "CANCELLED";
        default:
            return status.toUpperCase();
    }
}

function statusColor(status: string): string {
    if (ACTIVE_STATUSES.includes(status)) return "text-blue-400";
    if (status === "completed") return "text-[#22c55e]";
    if (status === "failed") return "text-red-400";
    if (status === "cancelled") return "text-[#eab308]";
    return "text-gray-600";
}

function formatAge(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(dateStr).toLocaleDateString();
}

export function ImportsTab() {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();
    const [cancelling, setCancelling] = useState<Set<string>>(new Set());

    const { data: imports = [], isLoading } = useQuery<ImportJob[]>({
        queryKey: ["user-imports"],
        queryFn: () => api.get<ImportJob[]>("/spotify/imports"),
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
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (imports.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <ListMusic className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No imports yet</p>
                <p className="text-xs text-white/30 mt-1">
                    Playlist imports will appear here
                </p>
            </div>
        );
    }

    const activeImports = imports.filter((j) =>
        ACTIVE_STATUSES.includes(j.status),
    );
    const pastImports = imports.filter(
        (j) => !ACTIVE_STATUSES.includes(j.status),
    );

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            {activeImports.length > 0 && (
                <div className="flex items-center justify-between px-3 py-2 border-b-2 border-white/10">
                    <div className="flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                        <span className="text-[10px] font-mono font-bold text-gray-600 uppercase tracking-wider">
                            {String(activeImports.length).padStart(2, "0")}{" "}
                            ACTIVE
                        </span>
                    </div>
                </div>
            )}

            {/* Import list */}
            <div className="flex-1 overflow-y-auto">
                {activeImports.map((job, index) => (
                    <ImportJobCard
                        key={job.id}
                        job={job}
                        index={index}
                        cancelling={cancelling.has(job.id)}
                        onCancel={handleCancel}
                    />
                ))}

                {pastImports.length > 0 && activeImports.length > 0 && (
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
                        <span className="text-[10px] font-mono font-bold text-gray-700 uppercase tracking-wider">
                            Previous
                        </span>
                        <span className="flex-1 border-t border-white/5" />
                    </div>
                )}

                {pastImports.map((job, index) => (
                    <ImportJobCard
                        key={job.id}
                        job={job}
                        index={activeImports.length + index}
                        cancelling={false}
                        onCancel={handleCancel}
                    />
                ))}
            </div>
        </div>
    );
}

function ImportJobCard({
    job,
    index,
    cancelling,
    onCancel,
}: {
    job: ImportJob;
    index: number;
    cancelling: boolean;
    onCancel: (id: string) => void;
}) {
    const isActive = ACTIVE_STATUSES.includes(job.status);
    const borderColor = isActive
        ? "border-blue-400"
        : job.status === "completed"
          ? "border-[#22c55e]"
          : job.status === "failed"
            ? "border-red-400"
            : "border-white/5";

    return (
        <div
            className={cn(
                "px-3 py-3 border-b border-white/5 border-l-2 bg-[var(--bg-secondary)] hover:bg-white/5 transition-colors group",
                borderColor,
            )}
        >
            <div className="flex items-start gap-3">
                {/* Index */}
                <div className="flex-shrink-0 w-6 mt-0.5">
                    <span className="text-[10px] font-mono font-bold text-gray-700">
                        {String(index + 1).padStart(2, "0")}
                    </span>
                </div>

                {/* Status icon */}
                <div className="mt-0.5 shrink-0">
                    {isActive ? (
                        cancelling ? (
                            <Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
                        ) : (
                            <GradientSpinner size="sm" />
                        )
                    ) : job.status === "completed" ? (
                        <CheckCircle2 className="w-4 h-4 text-[#22c55e]" />
                    ) : (
                        <AlertCircle className="w-4 h-4 text-red-400" />
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <p className="text-xs font-black tracking-tight text-white truncate uppercase mb-1">
                        {job.playlistName}
                    </p>

                    {/* Status line */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <span
                            className={cn(
                                "text-[9px] font-mono font-bold uppercase tracking-wider",
                                statusColor(job.status),
                            )}
                        >
                            {statusLabel(job.status)}
                        </span>

                        {isActive && job.albumsTotal > 0 && (
                            <>
                                <span className="text-[9px] font-mono text-gray-700">
                                    --
                                </span>
                                <span className="text-[9px] font-mono text-gray-600 uppercase tracking-wider">
                                    {job.albumsCompleted}/{job.albumsTotal}{" "}
                                    albums
                                </span>
                            </>
                        )}

                        {job.tracksMatched > 0 && (
                            <>
                                <span className="text-[9px] font-mono text-gray-700">
                                    --
                                </span>
                                <span className="text-[9px] font-mono text-gray-600 uppercase tracking-wider">
                                    {job.tracksMatched} tracks matched
                                </span>
                            </>
                        )}

                        <span className="text-[9px] font-mono text-gray-700">
                            --
                        </span>
                        <span className="text-[9px] font-mono text-gray-700 uppercase tracking-wider">
                            {formatAge(job.createdAt)}
                        </span>
                    </div>

                    {/* Progress bar for active imports */}
                    {isActive && job.albumsTotal > 0 && (
                        <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-blue-400 rounded-full transition-all duration-300"
                                style={{
                                    width: `${Math.round((job.albumsCompleted / job.albumsTotal) * 100)}%`,
                                }}
                            />
                        </div>
                    )}

                    {/* Error message */}
                    {job.status === "failed" && job.error && (
                        <p className="text-[9px] font-mono text-red-400/70 mt-1 truncate">
                            {job.error}
                        </p>
                    )}

                    {/* Completed: link to playlist */}
                    {job.status === "completed" && job.createdPlaylistId && (
                        <Link
                            href={`/playlist/${job.createdPlaylistId}`}
                            className="inline-flex items-center gap-1 mt-1.5 text-[9px] font-mono font-bold text-[#22c55e] hover:text-[#4ade80] uppercase tracking-wider transition-colors"
                        >
                            <ExternalLink className="w-3 h-3" />
                            View Playlist
                        </Link>
                    )}
                </div>

                {/* Cancel button for active imports */}
                {isActive && (
                    <button
                        onClick={() => onCancel(job.id)}
                        disabled={cancelling}
                        className="p-1 hover:bg-white/10 transition-colors shrink-0"
                        title="Cancel import"
                    >
                        <X className="w-3 h-3 text-gray-700 hover:text-red-400" />
                    </button>
                )}
            </div>
        </div>
    );
}
