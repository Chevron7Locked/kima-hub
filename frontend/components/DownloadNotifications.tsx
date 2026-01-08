"use client";

import { useState, useRef, useEffect } from "react";
import {
    X,
    CheckCircle,
    XCircle,
    Download,
    Trash2,
    GripVertical,
} from "lucide-react";
import { DownloadJob } from "@/hooks/useDownloadStatus";
import { GradientSpinner } from "./ui/GradientSpinner";
import { cn } from "@/utils/cn";
import { useDownloadContext } from "@/lib/download-context";
import { api } from "@/lib/api";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

export function DownloadNotifications() {
    const { downloadStatus } = useDownloadContext();
    const [isOpen, setIsOpen] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const containerRef = useRef<HTMLDivElement>(null);
    const [isClearing, setIsClearing] = useState(false);
    const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Handle drag start - only from header
    const handleMouseDown = (e: React.MouseEvent) => {
        // Don't drag when clicking buttons or links
        const target = e.target as HTMLElement;
        if (target.closest("button") || target.closest("a")) return;

        // Prevent default to avoid text selection during drag
        e.preventDefault();

        setIsDragging(true);
        setDragStart({
            x: e.clientX - position.x,
            y: e.clientY - position.y,
        });
    };

    // Handle drag move
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;

            const newX = e.clientX - dragStart.x;
            const newY = e.clientY - dragStart.y;

            // Get window and element dimensions
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            const elementWidth = containerRef.current?.offsetWidth || 384;
            const elementHeight = containerRef.current?.offsetHeight || 400;

            // Starting position in viewport (bottom-24 = 96px from bottom, right-4 = 16px from right)
            const startRight = 16; // right-4 in Tailwind
            const startBottom = 96; // bottom-24 in Tailwind

            // Calculate bounds that allow dragging across entire viewport
            // Keep at least 80px of the header visible
            const minX = -(windowWidth - startRight - 80); // Can drag far left
            const maxX = windowWidth - startRight - 80; // Can drag far right
            const minY = -(windowHeight - startBottom - 80); // Can drag to top
            const maxY = windowHeight - startBottom - 80; // Can drag to bottom

            const constrainedX = Math.max(minX, Math.min(newX, maxX));
            const constrainedY = Math.max(minY, Math.min(newY, maxY));

            setPosition({ x: constrainedX, y: constrainedY });
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
        }

        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
        };
    }, [isDragging, dragStart, position]);

    // Auto-open when there are active downloads or failures
    const shouldShow =
        downloadStatus.hasActiveDownloads ||
        downloadStatus.failedDownloads.length > 0 ||
        downloadStatus.recentDownloads.length > 0;

    useEffect(() => {
        if (shouldShow) {
            setIsOpen(true);
            setDismissed(false);
        } else {
            setIsOpen(false);
        }
    }, [shouldShow]);

    const shouldRender = (shouldShow && !dismissed) || isOpen;
    if (!shouldRender) return null;

    // Function to manually close modal (even if there are downloads)
    const handleClose = () => {
        setIsOpen(false);
        setDismissed(true);
    };

    // Function to clear completed/failed downloads
    const handleClearCompleted = async () => {
        try {
            const jobIds = [
                ...downloadStatus.recentDownloads.map((j) => j.id),
                ...downloadStatus.failedDownloads.map((j) => j.id),
            ];

            if (jobIds.length === 0) {
                setDismissed(true);
                setIsOpen(false);
                return;
            }

            setIsClearing(true);
            await Promise.all(
                jobIds.map((id) =>
                    api
                        .deleteDownload(id)
                        .catch((error) =>
                            console.error(`Failed to delete job ${id}`, error)
                        )
                )
            );
            setIsClearing(false);
            setDismissed(true);
            setIsOpen(false);
        } catch (error) {
            setIsClearing(false);
            console.error("Failed to clear downloads:", error);
        }
    };

    const allJobs = [
        ...downloadStatus.activeDownloads,
        ...downloadStatus.recentDownloads,
    ]
        .filter((job) => !deletedIds.has(job.id)) // Filter out optimistically deleted jobs
        .sort(
            (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
        );

    // Mobile: Compact floating pill at top
    if (isMobileOrTablet) {
        return (
            <div
                ref={containerRef}
                className="fixed top-20 left-1/2 -translate-x-1/2 z-50 w-auto max-w-[90vw]"
            >
                <div className="bg-[#1a1a1a]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden">
                    {/* Compact Header */}
                    <div className="flex items-center justify-between px-3 py-2 gap-3">
                        <div className="flex items-center gap-2">
                            <Download className="w-4 h-4 text-white/60" />
                            <span className="text-xs font-semibold text-white">
                                Downloads
                            </span>
                            {downloadStatus.hasActiveDownloads && (
                                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/20 text-green-400 rounded-full">
                                    {downloadStatus.activeDownloads.length}{" "}
                                    active
                                </span>
                            )}
                        </div>
                        <button
                            onClick={handleClose}
                            className="text-white/40 hover:text-white transition-colors p-1"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Compact Download List - max 3 visible */}
                    <div className="max-h-40 overflow-y-auto border-t border-white/5">
                        {allJobs.length === 0 ? (
                            <div className="px-3 py-4 text-center text-white/40 text-xs">
                                No downloads
                            </div>
                        ) : (
                            <div className="divide-y divide-white/5">
                                {allJobs.slice(0, 5).map((job) => (
                                    <DownloadJobItemCompact
                                        key={job.id}
                                        job={job}
                                        onDelete={(id) =>
                                            setDeletedIds((prev) =>
                                                new Set(prev).add(id)
                                            )
                                        }
                                    />
                                ))}
                                {allJobs.length > 5 && (
                                    <div className="px-3 py-2 text-center text-white/40 text-xs">
                                        +{allJobs.length - 5} more
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Footer - Clear button */}
                    {(downloadStatus.recentDownloads.length > 0 ||
                        downloadStatus.failedDownloads.length > 0) && (
                        <div className="px-3 py-2 border-t border-white/10 bg-black/40">
                            <button
                                onClick={handleClearCompleted}
                                disabled={isClearing}
                                className={cn(
                                    "w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded transition-all",
                                    isClearing
                                        ? "text-white/30 cursor-not-allowed"
                                        : "text-white/60 hover:text-white hover:bg-white/5"
                                )}
                            >
                                <Trash2 className="w-3 h-3" />
                                Clear completed
                            </button>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // Desktop: Full draggable panel
    return (
        <div
            ref={containerRef}
            className="fixed bottom-24 right-4 z-50 w-96 max-w-[calc(100vw-2rem)]"
            style={{
                transform: `translate(${position.x}px, ${position.y}px)`,
                transition: isDragging ? "none" : "transform 0.2s ease-out",
            }}
        >
            <div className="bg-[#1a1a1a] border border-white/10 rounded-lg shadow-2xl overflow-hidden">
                {/* Header */}
                <div
                    className={cn(
                        "flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/40",
                        "cursor-move select-none",
                        isDragging && "cursor-grabbing"
                    )}
                    onMouseDown={handleMouseDown}
                >
                    <div className="flex items-center gap-2">
                        <GripVertical className="w-4 h-4 text-white/40" />
                        <Download className="w-4 h-4 text-white/60" />
                        <h3 className="text-sm font-semibold text-white">
                            Downloads
                        </h3>
                        {downloadStatus.hasActiveDownloads && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-green-500/20 text-green-400 rounded-full">
                                {downloadStatus.activeDownloads.length} active
                            </span>
                        )}
                    </div>
                    <button
                        onClick={(e) => {
                            e.stopPropagation(); // Prevent drag
                            handleClose();
                        }}
                        className="text-white/40 hover:text-white transition-colors cursor-pointer"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Download List */}
                <div className="max-h-96 overflow-y-auto">
                    {allJobs.length === 0 ? (
                        <div className="px-4 py-8 text-center text-white/40 text-sm">
                            No recent downloads
                        </div>
                    ) : (
                        <div className="divide-y divide-white/5">
                            {allJobs.map((job) => (
                                <DownloadJobItem
                                    key={job.id}
                                    job={job}
                                    onDelete={(id) =>
                                        setDeletedIds((prev) =>
                                            new Set(prev).add(id)
                                        )
                                    }
                                />
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer - Clear button */}
                {(downloadStatus.recentDownloads.length > 0 ||
                    downloadStatus.failedDownloads.length > 0) && (
                    <div className="px-4 py-2 border-t border-white/10 bg-black/40">
                        <button
                            onClick={handleClearCompleted}
                            disabled={isClearing}
                            className={cn(
                                "w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded transition-all",
                                isClearing
                                    ? "text-white/30 cursor-not-allowed"
                                    : "text-white/60 hover:text-white hover:bg-white/5"
                            )}
                        >
                            <Trash2 className="w-3 h-3" />
                            {isClearing ? "Clearing..." : "Clear completed"}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function DownloadJobItem({
    job,
    onDelete,
}: {
    job: DownloadJob;
    onDelete?: (id: string) => void;
}) {
    const [isDeleting, setIsDeleting] = useState(false);

    const getStatusIcon = () => {
        switch (job.status) {
            case "completed":
                return <CheckCircle className="w-4 h-4 text-green-400" />;
            case "failed":
                return <XCircle className="w-4 h-4 text-red-400" />;
            case "processing":
            case "pending":
                return <GradientSpinner size="sm" />;
            default:
                return <Download className="w-4 h-4 text-white/40" />;
        }
    };

    const getStatusColor = () => {
        switch (job.status) {
            case "completed":
                return "text-green-400";
            case "failed":
                return "text-red-400";
            case "processing":
                return "text-blue-400";
            case "pending":
                return "text-yellow-400";
            default:
                return "text-white/40";
        }
    };

    const getSourceColor = () => {
        if (!job.metadata?.currentSource) return "text-white/60";
        switch (job.metadata.currentSource) {
            case "lidarr":
                return "text-purple-400";
            case "soulseek":
                return "text-teal-400";
            default:
                return "text-white/60";
        }
    };

    const getStatusText = () => {
        if (job.metadata?.statusText) {
            return job.metadata.statusText;
        }
        // Fallback for backward compatibility
        if (job.status === "processing" || job.status === "pending") {
            return "Processing";
        }
        return null;
    };

    const handleDelete = async () => {
        try {
            setIsDeleting(true);
            // Optimistically remove from UI
            onDelete?.(job.id);
            // Then delete from backend
            await api.deleteDownload(job.id);
        } catch (error) {
            console.error("Failed to delete download:", error);
            setIsDeleting(false);
        }
    };

    // Show delete button for completed, failed, or stuck processing jobs
    const canDelete =
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "processing";

    return (
        <div className="px-4 py-3 hover:bg-white/5 transition-colors group">
            <div className="flex items-start gap-3">
                <div className="mt-0.5">{getStatusIcon()}</div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                        {job.subject}
                    </p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span
                            className={cn(
                                "text-xs font-medium capitalize",
                                getStatusColor()
                            )}
                        >
                            {job.status}
                        </span>
                        {getStatusText() && (
                            <>
                                <span className="text-xs text-white/40">•</span>
                                <span
                                    className={cn(
                                        "text-xs font-medium",
                                        getSourceColor()
                                    )}
                                >
                                    {getStatusText()}
                                </span>
                            </>
                        )}
                        <span className="text-xs text-white/40">•</span>
                        <span className="text-xs text-white/40 capitalize">
                            {job.type}
                        </span>
                    </div>
                    {job.error && (
                        <p className="text-xs text-red-400/80 mt-1 line-clamp-2">
                            {job.error}
                        </p>
                    )}
                </div>
                {canDelete && (
                    <button
                        onClick={handleDelete}
                        disabled={isDeleting}
                        className={cn(
                            "opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-white/10 rounded",
                            isDeleting && "opacity-50 cursor-not-allowed"
                        )}
                        title="Delete"
                    >
                        <X className="w-4 h-4 text-white/60 hover:text-white" />
                    </button>
                )}
            </div>
        </div>
    );
}

// Compact version for mobile
function DownloadJobItemCompact({
    job,
    onDelete,
}: {
    job: DownloadJob;
    onDelete?: (id: string) => void;
}) {
    const getStatusIcon = () => {
        switch (job.status) {
            case "completed":
                return <CheckCircle className="w-3 h-3 text-green-400" />;
            case "failed":
                return <XCircle className="w-3 h-3 text-red-400" />;
            case "processing":
            case "pending":
                return <GradientSpinner size="sm" />;
            default:
                return <Download className="w-3 h-3 text-white/40" />;
        }
    };

    const getSourceColor = () => {
        if (!job.metadata?.currentSource) return "text-white/60";
        switch (job.metadata.currentSource) {
            case "lidarr":
                return "text-purple-400";
            case "soulseek":
                return "text-teal-400";
            default:
                return "text-white/60";
        }
    };

    const getStatusText = () => {
        if (job.metadata?.statusText) {
            return job.metadata.statusText;
        }
        // Fallback for backward compatibility
        if (job.status === "processing" || job.status === "pending") {
            return "Processing";
        }
        return null;
    };

    return (
        <div className="px-3 py-2 flex items-center gap-2">
            <div className="flex-shrink-0">{getStatusIcon()}</div>
            <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-white truncate">
                    {job.subject}
                </p>
                {getStatusText() && (
                    <p
                        className={cn(
                            "text-[10px] font-medium",
                            getSourceColor()
                        )}
                    >
                        {getStatusText()}
                    </p>
                )}
            </div>
            <span className="text-[10px] text-white/40 capitalize shrink-0">
                {job.status}
            </span>
        </div>
    );
}
