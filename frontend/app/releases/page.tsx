"use client";

import { useState, useEffect } from "react";
import { Calendar, Clock, Download, Music2, Disc, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import Link from "next/link";
import Image from "next/image";

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: 'lidarr' | 'similar';
    status: 'upcoming' | 'released' | 'available';
    inLibrary: boolean;
    canDownload: boolean;
}

interface ReleaseRadarData {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

export default function ReleasesPage() {
    const [data, setData] = useState<ReleaseRadarData | null>(null);
    const [loading, setLoading] = useState(true);
    const [downloadingId, setDownloadingId] = useState<string | number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const fetchReleases = async () => {
        try {
            setLoading(true);
            const res = await fetch("/api/releases/radar?daysBack=30&daysAhead=90");
            if (!res.ok) throw new Error("Failed to fetch releases");
            const json = await res.json();
            setData(json);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to fetch releases");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchReleases();
    }, []);

    const handleDownload = async (albumMbid: string, releaseId: string | number) => {
        try {
            setDownloadingId(releaseId);
            const res = await fetch(`/api/releases/download/${albumMbid}`, {
                method: "POST",
            });
            if (res.ok) {
                // Refresh to show updated status
                await fetchReleases();
            }
        } catch (err) {
            console.error("Download failed:", err);
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
            <div className="flex flex-col items-center justify-center min-h-screen text-white/60">
                <Music2 className="w-12 h-12 mb-4 opacity-40" />
                <p>Failed to load releases</p>
                <p className="text-sm">{error}</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen pb-32">
            {/* Hero Section */}
            <div className="relative h-64 md:h-80 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500/20 via-orange-600/10 to-transparent" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#0A0A0A] via-transparent to-transparent" />
                
                <div className="relative h-full flex flex-col justify-end p-6 md:p-8">
                    <div className="flex items-center gap-3 mb-2">
                        <Calendar className="w-6 h-6 text-amber-400" />
                        <span className="text-amber-400 text-sm font-medium uppercase tracking-wider">
                            Release Radar
                        </span>
                    </div>
                    <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
                        New & Upcoming
                    </h1>
                    <p className="text-white/60 text-sm md:text-base max-w-xl">
                        {data?.monitoredArtistCount || 0} monitored artists • 
                        {data?.upcoming.length || 0} upcoming • 
                        {data?.recent.length || 0} recent releases
                    </p>
                </div>
            </div>

            <div className="px-4 md:px-8 space-y-10">
                {/* Upcoming Releases */}
                {data?.upcoming && data.upcoming.length > 0 && (
                    <section>
                        <div className="flex items-center gap-3 mb-6">
                            <Clock className="w-5 h-5 text-amber-400" />
                            <h2 className="text-xl font-semibold text-white">Coming Soon</h2>
                            <span className="text-white/40 text-sm">({data.upcoming.length})</span>
                        </div>
                        
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                            {data.upcoming.map((release) => (
                                <ReleaseCard
                                    key={`${release.albumMbid}-${release.id}`}
                                    release={release}
                                    formatDate={formatDate}
                                    onDownload={handleDownload}
                                    isDownloading={downloadingId === release.id}
                                />
                            ))}
                        </div>
                    </section>
                )}

                {/* Recently Released */}
                {data?.recent && data.recent.length > 0 && (
                    <section>
                        <div className="flex items-center gap-3 mb-6">
                            <Disc className="w-5 h-5 text-emerald-400" />
                            <h2 className="text-xl font-semibold text-white">Just Dropped</h2>
                            <span className="text-white/40 text-sm">({data.recent.length})</span>
                        </div>
                        
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                            {data.recent.map((release) => (
                                <ReleaseCard
                                    key={`${release.albumMbid}-${release.id}`}
                                    release={release}
                                    formatDate={formatDate}
                                    onDownload={handleDownload}
                                    isDownloading={downloadingId === release.id}
                                />
                            ))}
                        </div>
                    </section>
                )}

                {/* Empty State */}
                {(!data?.upcoming?.length && !data?.recent?.length) && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <Calendar className="w-16 h-16 text-white/20 mb-6" />
                        <h3 className="text-xl font-medium text-white mb-2">No releases found</h3>
                        <p className="text-white/50 max-w-md mb-6">
                            Add artists to Lidarr and enable monitoring to see their upcoming and recent releases here.
                        </p>
                        <Link
                            href="/settings"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 transition-colors"
                        >
                            Configure Lidarr
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    </div>
                )}
            </div>
        </div>
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
    onDownload: (albumMbid: string, releaseId: string | number) => void;
    isDownloading: boolean;
}) {
    const isUpcoming = release.status === 'upcoming';
    const hasIt = release.inLibrary;

    return (
        <div className="group relative">
            {/* Cover Art */}
            <div className="aspect-square rounded-lg overflow-hidden bg-white/5 mb-3 relative">
                {release.coverUrl ? (
                    <Image
                        src={release.coverUrl}
                        alt={release.title}
                        fill
                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
                        className="object-cover group-hover:scale-105 transition-transform duration-150"
                        unoptimized
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <Disc className="w-12 h-12 text-white/20" />
                    </div>
                )}

                {/* Status Badge */}
                <div className={cn(
                    "absolute top-2 left-2 px-2 py-1 rounded text-xs font-medium",
                    isUpcoming ? "bg-amber-500/90 text-black" : 
                    hasIt ? "bg-emerald-500/90 text-black" : "bg-white/20 text-white"
                )}>
                    {isUpcoming ? formatDate(release.releaseDate) : 
                     hasIt ? "In Library" : "Available"}
                </div>

                {/* Download Button Overlay */}
                {release.canDownload && !hasIt && (
                    <button
                        onClick={() => onDownload(release.albumMbid, release.id)}
                        disabled={isDownloading}
                        className={cn(
                            "absolute inset-0 flex items-center justify-center",
                            "bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity",
                            isDownloading && "opacity-100"
                        )}
                    >
                        {isDownloading ? (
                            <Loader2 className="w-8 h-8 text-white animate-spin" />
                        ) : (
                            <Download className="w-8 h-8 text-white" />
                        )}
                    </button>
                )}

                {/* In Library Indicator */}
                {hasIt && (
                    <div className="absolute bottom-2 right-2">
                        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    </div>
                )}
            </div>

            {/* Info */}
            <div className="space-y-1">
                <h3 className="text-sm font-medium text-white truncate" title={release.title}>
                    {release.title}
                </h3>
                <p className="text-xs text-white/50 truncate" title={release.artistName}>
                    {release.artistName}
                </p>
                {isUpcoming && (
                    <p className="text-xs text-amber-400/80">
                        {new Date(release.releaseDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                        })}
                    </p>
                )}
            </div>
        </div>
    );
}



