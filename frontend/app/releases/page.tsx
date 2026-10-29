"use client";

import { usePublicConfig } from "@/hooks/useQueries";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Clock, Download, Disc, ArrowRight, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { MediaCard } from "@/components/cards/MediaCard";
import { plural } from "@/lib/format";
import { PageMessage } from "@/components/ui/PageMessage";
import { EmptyState } from "@/components/ui/EmptyState";
import { buttonClass } from "@/components/ui/Button";

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    status: 'upcoming' | 'released' | 'available';
    inLibrary: boolean;
    canDownload: boolean;
}

interface ReleaseRadarData {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
    monitoredArtistCount: number;
}

export default function ReleasesPage() {
    const [downloadingId, setDownloadingId] = useState<string | number | null>(null);
    const { canAcquire } = usePublicConfig();
    const { data, isLoading, isFetching, error: loadError, refetch } = useQuery({
        queryKey: ["release-radar"],
        queryFn: () => api.get<ReleaseRadarData>("/releases/radar?daysBack=30&daysAhead=90"),
        // Read again on every visit: a release can land in the library between two.
        staleTime: 0,
    });
    // "Try again" after a failure shows the spinner while it asks.
    const loading = isLoading || (isFetching && !!loadError);
    const error = loadError ? loadError.message || "couldn't load releases" : null;

    const handleDownload = async (albumMbid: string, releaseId: string | number) => {
        try {
            setDownloadingId(releaseId);
            await api.post(`/releases/download/${albumMbid}`);
            await refetch();
        } catch (err) {
            notify.error("Couldn't start the download", { message: err instanceof Error ? err.message : undefined });
        } finally {
            setDownloadingId(null);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return "Today";
        if (diffDays === 1) return "Tomorrow";
        if (diffDays > 0 && diffDays <= 7) return `In ${diffDays} days`;
        if (diffDays < 0 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;

        return date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error) {
        return (
            <PageMessage
                title="Couldn't load releases"
                description={error}
                action={{ label: "Try again", onClick: () => void refetch() }}
            />
        );
    }

    return (
        <div className="min-h-screen pb-32">
            <PageHeader
                eyebrow="Release radar"
                title="New and upcoming"
                description={
                    data?.monitoredArtistCount
                        ? [
                              plural(data.monitoredArtistCount, "monitored artist"),
                              `${data.upcoming.length} upcoming`,
                              `${data.recent.length} recent`,
                          ].join(" · ")
                        : undefined
                }
            />

            <div className="page-shell space-y-10 animate-rise">
                {data?.upcoming && data.upcoming.length > 0 && (
                    <ReleaseSection
                        icon={<Clock className="w-5 h-5 text-brand" />}
                        title="Coming Soon"
                        releases={data.upcoming}
                        formatDate={formatDate}
                        onDownload={canAcquire ? handleDownload : undefined}
                        downloadingId={downloadingId}
                    />
                )}

                {data?.recent && data.recent.length > 0 && (
                    <ReleaseSection
                        icon={<Disc className="w-5 h-5 text-success" />}
                        title="Just Dropped"
                        releases={data.recent}
                        formatDate={formatDate}
                        onDownload={canAcquire ? handleDownload : undefined}
                        downloadingId={downloadingId}
                    />
                )}

                {(!data?.upcoming?.length && !data?.recent?.length) && (
                    <EmptyState
                        icon={<Calendar className="w-16 h-16" />}
                        title="No releases found"
                        description="Add artists to Lidarr and enable monitoring to see their upcoming and recent releases here."
                    >
                        <Link href="/settings" className={buttonClass("primary")}>
                            Configure Lidarr
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    </EmptyState>
                )}
            </div>
        </div>
    );
}

function ReleaseSection({
    icon,
    title,
    releases,
    formatDate,
    onDownload,
    downloadingId,
}: {
    icon: ReactNode;
    title: string;
    releases: ReleaseItem[];
    formatDate: (date: string) => string;
    onDownload?: (albumMbid: string, releaseId: string | number) => void;
    downloadingId: string | number | null;
}) {
    return (
        <section>
            <div className="flex items-center gap-3 mb-6">
                {icon}
                <h2 className="text-xl font-semibold text-white">{title}</h2>
                <span className="text-[var(--text-muted)] text-sm">({releases.length})</span>
            </div>

            <div className="grid-media">
                {releases.map((release) => (
                    <ReleaseCard
                        key={`${release.albumMbid}-${release.id}`}
                        release={release}
                        formatDate={formatDate}
                        onDownload={onDownload}
                        isDownloading={downloadingId === release.id}
                    />
                ))}
            </div>
        </section>
    );
}

function ReleaseCard({
    release,
    formatDate,
    onDownload,
    isDownloading,
}: {
    release: ReleaseItem;
    formatDate: (date: string) => string;
    onDownload?: (albumMbid: string, releaseId: string | number) => void;
    isDownloading: boolean;
}) {
    const isUpcoming = release.status === "upcoming";
    const hasIt = release.inLibrary;

    return (
        <MediaCard
            title={release.title}
            subtitle={release.artistName}
            imageUrl={release.coverUrl ? api.getCoverArtUrl(release.coverUrl, 500) : null}
            fallbackIcon={Disc}
            type="album"
            badge={
                <span
                    className={cn(
                        "block px-2 py-1 rounded text-xs font-medium",
                        isUpcoming ? "bg-brand text-black" : hasIt ? "bg-success/90 text-black" : "bg-white/20 text-white",
                    )}
                >
                    {isUpcoming ? formatDate(release.releaseDate) : hasIt ? "In Library" : "Available"}
                </span>
            }
            corner={hasIt && <CheckCircle2 className="w-5 h-5 text-success" aria-label="in library" />}
            action={
                onDownload && release.canDownload && !hasIt
                    ? {
                          icon: Download,
                          label: "download",
                          onClick: () => onDownload(release.albumMbid, release.id),
                          busy: isDownloading,
                      }
                    : undefined
            }
        />
    );
}
