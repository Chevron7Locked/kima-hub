"use client";

import { usePublicConfig } from "@/hooks/useQueries";
import { NumberedRow } from "@/components/ui/NumberedRow";
import { ACQUIRE_LOCKED } from "@/lib/acquire";
import { useState, useEffect, useRef, Suspense, type CSSProperties } from "react";
import { formatTime, plural } from "@/lib/format";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
    ArrowLeft,
    Check,
    X,
    Download,
    ExternalLink,
    ChevronDown,
    ChevronUp,
    Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/Button";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { CachedImage } from "@/components/ui/CachedImage";

interface SpotifyTrack {
    spotifyId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    isrc: string | null;
    durationMs: number;
    trackNumber: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

interface MatchedTrack {
    spotifyTrack: SpotifyTrack;
    localTrack: {
        id: string;
        title: string;
        albumId: string;
        albumTitle: string;
        artistName: string;
    } | null;
    matchType: "exact" | "fuzzy" | "none";
    matchConfidence: number;
}

interface AlbumToDownload {
    spotifyAlbumId: string;
    albumName: string;
    artistName: string;
    artistMbid: string | null;
    albumMbid: string | null;
    coverUrl: string | null;
    trackCount: number;
    tracksNeeded: SpotifyTrack[];
}

interface ImportPreview {
    playlist: {
        id: string;
        name: string;
        description: string | null;
        owner: string;
        imageUrl: string | null;
        trackCount: number;
    };
    matchedTracks: MatchedTrack[];
    albumsToDownload: AlbumToDownload[];
    summary: {
        total: number;
        inLibrary: number;
        downloadable: number;
    };
}

interface ImportJob {
    id: string;
    status:
        | "pending"
        | "fetching"
        | "downloading"
        | "scanning"
        | "creating_playlist"
        | "matching_tracks"
        | "completed"
        | "failed"
        | "cancelled";
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number;
    createdPlaylistId: string | null;
    error: string | null;
}

type Step = "input" | "previewing" | "preview" | "importing" | "complete";

const TERMINAL_IMPORT_STATUSES = ["completed", "failed", "cancelled"];

const pendingImportJob = (id: string, totals: Partial<ImportJob> = {}): ImportJob => ({
    id,
    status: "pending",
    progress: 0,
    albumsTotal: 0,
    albumsCompleted: 0,
    tracksMatched: 0,
    tracksTotal: 0,
    tracksDownloadable: 0,
    createdPlaylistId: null,
    error: null,
    ...totals,
});

function ImportPlaylistPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const hasAutoFetched = useRef(false);

    const [step, setStep] = useState<Step>("input");
    const [url, setUrl] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [previewJobId, setPreviewJobId] = useState<string | null>(null);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const { canAcquire, settled: permissionKnown } = usePublicConfig();
    const [selectedAlbums, setSelectedAlbums] = useState<Set<string>>(
        new Set()
    );
    // Someone who may not start downloads imports only what the library has.
    const albumCount = canAcquire ? selectedAlbums.size : 0;
    const [playlistName, setPlaylistName] = useState("");
    const [importJob, setImportJob] = useState<ImportJob | null>(null);
    const [refreshStatusMessage, setRefreshStatusMessage] = useState<
        string | null
    >(null);
    const [expandedSection, setExpandedSection] = useState<
        "matched" | "download" | null
    >("matched");

    // Pre-fill URL from query params and reconnect to active import if one exists
    useEffect(() => {
        const urlParam = searchParams.get("url");
        if (urlParam && !hasAutoFetched.current) {
            hasAutoFetched.current = true;
            setUrl(urlParam);

            // Check if there's already an active import for this URL
            let normalizedPath: string;
            try {
                normalizedPath = new URL(urlParam).host + new URL(urlParam).pathname.replace(/\/+$/, "");
            } catch {
                normalizedPath = urlParam;
            }

            (async () => {
                try {
                    const jobs = await api.get<Array<{
                        id: string; status: string; sourceUrl: string | null;
                        playlistName: string; progress: number; albumsTotal: number;
                        albumsCompleted: number; tracksMatched: number; tracksTotal: number;
                        tracksDownloadable: number; createdPlaylistId: string | null; error: string | null;
                    }>>("/spotify/imports");
                    const activeStatuses = ["pending", "fetching", "downloading", "scanning", "creating_playlist", "matching_tracks"];
                    const activeJob = jobs.find(
                        (j) => activeStatuses.includes(j.status) && j.sourceUrl === normalizedPath,
                    );
                    if (activeJob) {
                        setImportJob({
                            id: activeJob.id,
                            status: activeJob.status as ImportJob["status"],
                            progress: activeJob.progress,
                            albumsTotal: activeJob.albumsTotal,
                            albumsCompleted: activeJob.albumsCompleted,
                            tracksMatched: activeJob.tracksMatched,
                            tracksTotal: activeJob.tracksTotal,
                            tracksDownloadable: activeJob.tracksDownloadable,
                            createdPlaylistId: activeJob.createdPlaylistId,
                            error: activeJob.error,
                        });
                        setPlaylistName(activeJob.playlistName);
                        setStep("importing");
                    }
                } catch {
                    // If fetch fails, just show the input form with pre-filled URL
                }
            })();
        }
    }, [searchParams]);

    // Preview status — SSE is primary delivery, HTTP poll is fallback for reconnects.
    // If SSE already populated the cache, the poll sees the terminal status and stops.
    type PreviewStatus = { status: string; preview?: ImportPreview; error?: string; phase?: string; message?: string };
    const { data: ssePreviewStatus } = useQuery<PreviewStatus | null>({
        queryKey: ["preview-status", previewJobId],
        queryFn: async () => {
            // Return cache immediately if SSE already delivered a terminal result
            const cached = queryClient.getQueryData<PreviewStatus>(["preview-status", previewJobId]);
            if (cached && cached.status !== "running") return cached;
            // Otherwise poll the backend (handles SSE reconnect gap)
            return api.get<PreviewStatus>(`/spotify/preview/${previewJobId}`);
        },
        enabled: !!previewJobId && step === "previewing",
        // Poll every 3s while pending/running; stop once terminal
        refetchInterval: (query) => {
            const d = query.state.data;
            if (!d || d.status === "pending" || d.status === "running") return 3000;
            return false;
        },
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });

    // React to SSE-driven preview completion (adjusted during render when the status changes)
    const [lastPreviewStatus, setLastPreviewStatus] = useState(ssePreviewStatus);
    const [failedPreview, setFailedPreview] = useState<PreviewStatus | null>(null);
    if (ssePreviewStatus !== lastPreviewStatus) {
        setLastPreviewStatus(ssePreviewStatus);
        if (ssePreviewStatus && step === "previewing") {
            if (ssePreviewStatus.status === "completed" && ssePreviewStatus.preview) {
                const result = ssePreviewStatus.preview;
                setPreview(result);
                setPlaylistName(result.playlist.name);
                const downloadableAlbumIds = result.albumsToDownload.map((_a, i) => String(i));
                setSelectedAlbums(new Set(downloadableAlbumIds));
                setStep("preview");
            } else if (ssePreviewStatus.status === "failed") {
                setFailedPreview(ssePreviewStatus);
                setStep("input");
                setPreviewJobId(null);
            }
        }
    }

    useEffect(() => {
        if (failedPreview) {
            notify.error("Failed to generate preview", { message: failedPreview.error ?? undefined });
        }
    }, [failedPreview]);

    // Import status: SSE populates cache, HTTP polls as fallback (mirrors preview-status pattern)
    const { data: sseImportStatus } = useQuery<(ImportJob & { jobId?: string }) | null>({
        queryKey: ["import-status", importJob?.id],
        queryFn: async () => {
            const cached = queryClient.getQueryData<ImportJob & { jobId?: string }>(["import-status", importJob?.id]);
            if (cached && TERMINAL_IMPORT_STATUSES.includes(cached.status)) return cached;
            if (!importJob?.id) return null;
            return api.get<ImportJob & { jobId?: string }>(`/spotify/import/${importJob.id}/status`);
        },
        enabled: !!importJob && !TERMINAL_IMPORT_STATUSES.includes(importJob.status),
        refetchInterval: (query) => {
            const d = query.state.data;
            if (d && TERMINAL_IMPORT_STATUSES.includes(d.status)) return false;
            return 3000;
        },
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });

    // React to SSE-driven import status changes (adjusted during render when the status changes)
    const [lastImportStatus, setLastImportStatus] = useState(sseImportStatus);
    if (sseImportStatus !== lastImportStatus) {
        setLastImportStatus(sseImportStatus);
        if (sseImportStatus && importJob) {
            const updated: ImportJob = {
                ...importJob,
                status: sseImportStatus.status,
                progress: sseImportStatus.progress ?? importJob.progress,
                albumsTotal: sseImportStatus.albumsTotal ?? importJob.albumsTotal,
                albumsCompleted: sseImportStatus.albumsCompleted ?? importJob.albumsCompleted,
                tracksMatched: sseImportStatus.tracksMatched ?? importJob.tracksMatched,
                createdPlaylistId: sseImportStatus.createdPlaylistId ?? importJob.createdPlaylistId,
                error: sseImportStatus.error ?? importJob.error,
            };
            setImportJob(updated);

            if (TERMINAL_IMPORT_STATUSES.includes(updated.status)) {
                setStep("complete");
            }
        }
    }

    // The preview answers with a job id; the finished preview arrives over the event stream.
    const handleFetchPreview = async () => {
        if (!url.trim()) return;

        setIsLoading(true);
        try {
            const { jobId } = await api.post<{ jobId: string }>(
                "/spotify/preview/start",
                { url }
            );
            setPreviewJobId(jobId);
            setStep("previewing");
        } catch (err) {
            notify.error("Failed to start preview", {
                message: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleQuickImport = async () => {
        if (!url.trim()) return;

        setIsLoading(true);
        try {
            const { jobId } = await api.post<{ jobId: string }>(
                "/spotify/import/quick",
                { url }
            );

            setImportJob(pendingImportJob(jobId));
            setStep("importing");
        } catch (err) {
            notify.error("Failed to start import", {
                message: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleStartImport = async () => {
        if (!preview) return;

        setIsLoading(true);
        setRefreshStatusMessage(null);
        try {
            // Convert index-based selection keys back to album identifiers
            // Deduplicate MBIDs since the backend merges groups with the same MBID
            const selectedMbids = new Set(
                Array.from(selectedAlbums).map((idx) => {
                    const album = preview.albumsToDownload[Number(idx)];
                    return album?.albumMbid || album?.spotifyAlbumId || idx;
                })
            );
            const response = await api.post<{ jobId: string; status: string }>(
                "/spotify/import",
                {
                    spotifyPlaylistId: preview.playlist.id,
                    url,
                    playlistName: playlistName || preview.playlist.name,
                    // Someone who may not start downloads imports what matches the library and downloads nothing.
                    albumMbidsToDownload: canAcquire ? Array.from(selectedMbids) : [],
                    previewJobId: previewJobId ?? undefined,
                }
            );

            setImportJob(pendingImportJob(response.jobId, {
                albumsTotal: albumCount,
                tracksMatched: preview.summary.inLibrary,
                tracksTotal: preview.summary.total,
                tracksDownloadable: preview.summary.downloadable,
            }));
            setStep("importing");
        } catch (err) {
            notify.error("Failed to start import", {
                message: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setIsLoading(false);
        }
    };

    const toggleAlbum = (albumMbid: string) => {
        setSelectedAlbums((prev) => {
            const next = new Set(prev);
            if (next.has(albumMbid)) {
                next.delete(albumMbid);
            } else {
                next.add(albumMbid);
            }
            return next;
        });
    };

    const toggleAllAlbums = () => {
        if (!preview) return;

        const allAlbumIds = preview.albumsToDownload.map((_a, i) =>
            String(i)
        );

        if (selectedAlbums.size === allAlbumIds.length) {
            setSelectedAlbums(new Set());
        } else {
            setSelectedAlbums(new Set(allAlbumIds));
        }
    };

    const [isCancelling, setIsCancelling] = useState(false);
    const handleCancelImport = async () => {
        if (!importJob) return;

        setIsCancelling(true);
        try {
            const cancelResult = await api.post<{
                message: string;
                playlistId: string | null;
                tracksMatched: number;
            }>(`/spotify/import/${importJob.id}/cancel`, {});

            setImportJob((prev) =>
                prev
                    ? {
                          ...prev,
                          status: "cancelled",
                          createdPlaylistId: cancelResult.playlistId ?? null,
                          tracksMatched: cancelResult.tracksMatched ?? 0,
                      }
                    : prev
            );
            setStep("complete");

            queryClient.invalidateQueries({ queryKey: ["notifications"] });
        } catch (err) {
            notify.error("Failed to cancel import", {
                message: err instanceof Error ? err.message : undefined,
            });
        } finally {
            setIsCancelling(false);
        }
    };

    return (
        <div className="min-h-screen">
            <div className="max-w-3xl mx-auto px-6 pt-6 page-end">
                <div className="flex items-center gap-4 mb-6">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white/5 rounded-full transition-colors"
                        aria-label="Back"
                    >
                        <ArrowLeft className="w-5 h-5 text-[var(--text-secondary)]" />
                    </button>
                    <div>
                        <h1 className="t-page-title">
                            Import Playlist
                        </h1>
                        <p className="text-sm text-[var(--text-secondary)]">
                            Import from Spotify or Deezer
                        </p>
                    </div>
                </div>

                {step === "input" && (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                        <p className="text-sm text-[var(--text-primary)]">
                            Looking for playlists to import?{" "}
                            <Link
                                href="/browse/playlists"
                                className="text-brand hover:underline font-medium"
                            >
                                Browse Deezer playlists & radio stations →
                            </Link>
                        </p>
                    </div>
                )}

                {step === "input" && (
                    <div className="space-y-4">
                        <div>
                            <label htmlFor="playlist-url" className="block text-sm font-medium text-[var(--text-primary)] mb-2">
                                Playlist URL
                            </label>
                            <input
                                id="playlist-url"
                                type="text"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://www.deezer.com/playlist/... or https://open.spotify.com/playlist/..."
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]/50 focus:border-[var(--color-brand)] transition-colors"
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleFetchPreview()
                                }
                            />
                            <p className="text-xs text-[var(--text-muted)] mt-2">
                                Paste a public{" "}
                                <span className="text-[var(--text-secondary)]">Deezer</span>{" "}
                                or{" "}
                                <span className="text-[var(--text-secondary)]">Spotify</span>{" "}
                                playlist URL
                            </p>
                        </div>
                        <div className="flex gap-3">
                            <Button
                                variant="secondary"
                                onClick={handleFetchPreview}
                                disabled={!url.trim()}
                                isLoading={isLoading}
                                className="flex-1"
                            >
                                {isLoading ? "Loading..." : "Preview First"}
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleQuickImport}
                                disabled={!url.trim()}
                                isLoading={isLoading}
                                className="flex-1"
                            >
                                {isLoading ? "Loading..." : (
                                    <>
                                        <Zap className="w-4 h-4" />
                                        Import Now
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                )}

                {step === "previewing" && (
                    <div className="text-center py-12">
                        <GradientSpinner size="lg" className="mx-auto mb-4" />
                        <h2 className="text-lg font-bold text-white mb-1">Analysing Playlist</h2>
                        <p className="text-[var(--text-secondary)] text-sm">
                            {ssePreviewStatus?.message || "Matching tracks to your library..."}
                        </p>
                    </div>
                )}

                {step === "preview" && preview && (
                    <div className="space-y-4">
                        <div className="flex items-start gap-4 p-4 bg-white/5 rounded-lg">
                            {preview.playlist.imageUrl ? (
                                <div className="relative w-20 h-20">
                                    <CachedImage
                                        src={preview.playlist.imageUrl}
                                        alt={preview.playlist.name}
                                        fill
                                        sizes="80px"
                                        className="rounded-md object-cover"
                                    />
                                </div>
                            ) : (
                                <div className="w-20 h-20 rounded-md bg-white/10 flex items-center justify-center">
                                    <Image
                                        src="/assets/images/SpotIcon.png"
                                        alt="Spotify"
                                        width={32}
                                        height={32}
                                    />
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <h2 className="text-lg font-bold text-white truncate">
                                    {preview.playlist.name}
                                </h2>
                                <p className="text-sm text-[var(--text-secondary)]">
                                    {preview.playlist.owner} ·{" "}
                                    {preview.playlist.trackCount} songs
                                </p>
                                {preview.playlist.description && (
                                    <p className="text-sm text-[var(--text-muted)] mt-1 line-clamp-1">
                                        {preview.playlist.description}
                                    </p>
                                )}
                            </div>
                            <a
                                href={
                                    url ||
                                    `https://open.spotify.com/playlist/${preview.playlist.id}`
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--text-secondary)] hover:text-spotify transition-colors"
                            >
                                <ExternalLink className="w-4 h-4" />
                            </a>
                        </div>

                        <div className="grid grid-cols-4 gap-3">
                            <div className="animate-rise text-center py-3 bg-white/5 rounded-lg" style={{ "--i": 0 } as CSSProperties}>
                                <div className="text-xl font-bold text-white">
                                    {preview.summary.total}
                                </div>
                                <div className="text-xs text-[var(--text-muted)]">
                                    Total
                                </div>
                            </div>
                            <div className="animate-rise text-center py-3 bg-success/10 rounded-lg" style={{ "--i": 1 } as CSSProperties}>
                                <div className="text-xl font-bold text-success">
                                    {preview.summary.inLibrary}
                                </div>
                                <div className="text-xs text-[var(--text-muted)]">
                                    In Library
                                </div>
                            </div>
                            <div className="animate-rise text-center py-3 bg-success/10 rounded-lg" style={{ "--i": 2 } as CSSProperties}>
                                <div className="text-xl font-bold text-spotify">
                                    {preview.summary.downloadable}
                                </div>
                                <div className="text-xs text-[var(--text-muted)]">
                                    {canAcquire ? "To Download" : "Not in Library"}
                                </div>
                            </div>
                            <div className="animate-rise text-center py-3 bg-success/10 rounded-lg" style={{ "--i": 3 } as CSSProperties}>
                                <div className="text-xl font-bold text-success">
                                    ✓
                                </div>
                                <div className="text-xs text-[var(--text-muted)]">
                                    All Matched
                                </div>
                            </div>
                        </div>

                        {preview.summary.inLibrary > 0 && (
                            <div className="bg-white/5 rounded-lg overflow-hidden">
                                <button
                                    onClick={() =>
                                        setExpandedSection(
                                            expandedSection === "matched"
                                                ? null
                                                : "matched"
                                        )
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <Check className="w-4 h-4 text-success" />
                                        <span className="text-sm font-medium text-white">
                                            {preview.summary.inLibrary} songs in
                                            your library
                                        </span>
                                    </div>
                                    {expandedSection === "matched" ? (
                                        <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
                                    )}
                                </button>
                                {expandedSection === "matched" && (
                                    <div className="border-t border-white/5 max-h-48 overflow-y-auto">
                                        {preview.matchedTracks
                                            .filter((m) => m.localTrack)
                                            .map((match, i) => (
                                                <NumberedRow
                                                    key={match.spotifyTrack.spotifyId}
                                                    n={i + 1}
                                                    title={match.localTrack?.title || match.spotifyTrack.title}
                                                    subtitle={match.localTrack?.artistName || match.spotifyTrack.artist}
                                                    trailing={formatTime(Math.round(match.spotifyTrack.durationMs / 1000))}
                                                />
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {!canAcquire && preview.summary.downloadable > 0 && (
                            <p className="text-sm text-[var(--text-muted)]">
                                Songs not in your library are left out: {ACQUIRE_LOCKED}.
                            </p>
                        )}

                        {canAcquire && preview.albumsToDownload.filter((a) => a.albumMbid)
                            .length > 0 && (
                            <div className="bg-white/5 rounded-lg overflow-hidden">
                                <button
                                    onClick={() =>
                                        setExpandedSection(
                                            expandedSection === "download"
                                                ? null
                                                : "download"
                                        )
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <Download className="w-4 h-4 text-spotify" />
                                        <span className="text-sm font-medium text-white">
                                            {
                                                preview.albumsToDownload.filter(
                                                    (a) =>
                                                        a.albumMbid ||
                                                        a.albumName ===
                                                            "Unknown Album"
                                                ).length
                                            }{" "}
                                            albums to download
                                        </span>
                                    </div>
                                    {expandedSection === "download" ? (
                                        <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
                                    )}
                                </button>
                                {expandedSection === "download" && (
                                    <div className="border-t border-white/5">
                                        <div className="flex items-center justify-between px-4 py-2 bg-black/20">
                                            <button
                                                onClick={toggleAllAlbums}
                                                className="text-xs text-spotify hover:underline"
                                            >
                                                {selectedAlbums.size ===
                                                preview.albumsToDownload.length
                                                    ? "Deselect All"
                                                    : "Select All"}
                                            </button>
                                            <span className="text-xs text-[var(--text-muted)]">
                                                {selectedAlbums.size} selected
                                            </span>
                                        </div>
                                        <div className="max-h-48 overflow-y-auto">
                                            {preview.albumsToDownload.map(
                                                (album, index) => {
                                                    const albumKey =
                                                        String(index);
                                                    return (
                                                        <label
                                                            key={albumKey}
                                                            className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 cursor-pointer border-b border-white/5 last:border-0"
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedAlbums.has(
                                                                    albumKey
                                                                )}
                                                                onChange={() =>
                                                                    toggleAlbum(
                                                                        albumKey
                                                                    )
                                                                }
                                                                className="w-4 h-4 rounded border-white/20 bg-transparent text-spotify focus:ring-spotify focus:ring-offset-0"
                                                            />
                                                            {album.coverUrl && (
                                                                <div className="relative w-10 h-10">
                                                                    <CachedImage
                                                                        src={album.coverUrl}
                                                                        alt={album.albumName}
                                                                        fill
                                                                        sizes="40px"
                                                                        className="rounded object-cover"
                                                                    />
                                                                </div>
                                                            )}
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-sm text-white truncate">
                                                                    {
                                                                        album.albumName
                                                                    }
                                                                </div>
                                                                <div className="text-xs text-[var(--text-muted)] truncate">
                                                                    {
                                                                        album.artistName
                                                                    }{" "}
                                                                    ·{" "}
                                                                    {
                                                                        album.trackCount
                                                                    }{" "}
                                                                    songs
                                                                </div>
                                                            </div>
                                                        </label>
                                                    );
                                                }
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        <div>
                            <label htmlFor="playlist-name" className="block text-sm font-medium text-[var(--text-primary)] mb-2">
                                Playlist Name
                            </label>
                            <input
                                id="playlist-name"
                                type="text"
                                value={playlistName}
                                onChange={(e) =>
                                    setPlaylistName(e.target.value)
                                }
                                placeholder="Enter playlist name"
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-spotify/50 focus:border-spotify transition-colors"
                            />
                        </div>

                        <div className="flex items-center gap-3 pt-2">
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setStep("input");
                                    setPreview(null);
                                }}
                            >
                                Back
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleStartImport}
                                disabled={!permissionKnown || (preview.summary.inLibrary === 0 && albumCount === 0)}
                                isLoading={isLoading}
                                className="flex-1 bg-success hover:bg-success hover:brightness-110"
                            >
                                {isLoading ? (
                                    "Starting..."
                                ) : preview.summary.inLibrary > 0 && albumCount > 0 ? (
                                    `Import ${preview.summary.inLibrary} songs + Download ${albumCount} albums`
                                ) : preview.summary.inLibrary > 0 ? (
                                    `Import ${preview.summary.inLibrary} songs`
                                ) : albumCount > 0 ? (
                                    `Download ${albumCount} albums`
                                ) : canAcquire ? (
                                    "Select albums to download"
                                ) : (
                                    "None of these songs are in your library"
                                )}
                            </Button>
                        </div>
                    </div>
                )}

                {step === "importing" && importJob && (
                    <div className="animate-rise text-center py-12">
                        <GradientSpinner size="lg" className="mx-auto mb-4" />
                        <h2 className="text-lg font-bold text-white mb-1">
                            {importJob.status === "fetching"
                                ? "Fetching Playlist"
                                : importJob.status === "downloading"
                                ? "Queueing Album Downloads"
                                : importJob.status === "scanning"
                                ? "Scanning Library"
                                : importJob.status === "creating_playlist" ||
                                  importJob.status === "matching_tracks"
                                ? "Creating Playlist"
                                : "Starting Import"}
                        </h2>
                        <p className="text-sm text-[var(--text-secondary)] mb-6">
                            {importJob.status === "fetching" && (
                                <>Fetching tracks and matching to your library...</>
                            )}
                            {importJob.status === "downloading" && (
                                <>
                                    Queued {importJob.albumsCompleted} of{" "}
                                    {importJob.albumsTotal} albums
                                </>
                            )}
                            {importJob.status === "pending" && (
                                <>
                                    {importJob.albumsTotal > 0
                                        ? `Waiting for ${importJob.albumsTotal - importJob.albumsCompleted} downloads to complete`
                                        : "Preparing import..."}
                                </>
                            )}
                            {importJob.status === "scanning" && (
                                <>Importing downloaded files into library</>
                            )}
                            {(importJob.status === "creating_playlist" ||
                                importJob.status === "matching_tracks") && (
                                <>Adding {importJob.tracksMatched} songs</>
                            )}
                        </p>
                        <div className="w-full max-w-xs mx-auto bg-white/10 rounded-full h-1.5">
                            <div
                                className="bg-success h-1.5 rounded-full transition-all duration-200"
                                style={{ width: `${importJob.progress}%` }}
                            />
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-3">
                            {importJob.progress}% complete • downloads continue
                            in the background
                        </p>
                        <Button
                            variant="secondary"
                            onClick={handleCancelImport}
                            isLoading={isCancelling}
                            className="mt-6"
                        >
                            {isCancelling ? "Cancelling..." : "Cancel Import"}
                        </Button>
                        <p className="text-xs text-[var(--text-muted)] mt-2">
                            Playlist will be created with tracks downloaded so
                            far
                        </p>
                    </div>
                )}

                {step === "complete" && importJob && (
                    <div className="animate-rise text-center py-12">
                        <div
                            className={
                                "w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 " +
                                (importJob.status === "failed"
                                    ? "bg-danger"
                                    : importJob.status === "cancelled"
                                    ? "bg-warning"
                                    : "bg-success")
                            }
                        >
                            {importJob.status === "failed" || importJob.status === "cancelled" ? (
                                <X className="w-7 h-7 text-white" />
                            ) : (
                                <Check className="w-7 h-7 text-black" />
                            )}
                        </div>

                        <h2 className="text-lg font-bold text-white mb-1">
                            {importJob.status === "failed"
                                ? "Import Failed"
                                : importJob.status === "cancelled"
                                ? "Import Cancelled"
                                : "Import Complete"}
                        </h2>

                        {importJob.status === "failed" ? (
                            <p className="text-sm text-[var(--text-secondary)]">
                                {importJob.error ||
                                    "Something went wrong while importing."}
                            </p>
                        ) : importJob.status === "cancelled" ? (
                            <p className="text-sm text-[var(--text-secondary)]">
                                {importJob.createdPlaylistId
                                    ? `Import cancelled. A playlist was created with ${plural(importJob.tracksMatched, "matched track")}.`
                                    : "Import cancelled. No tracks had been matched yet."}
                            </p>
                        ) : (
                            <>
                                <p className="text-sm text-[var(--text-secondary)]">
                                    {importJob.tracksMatched > 0
                                        ? `Added ${importJob.tracksMatched} songs to your playlist`
                                        : "Playlist created (songs still downloading)"}
                                </p>
                                {importJob.tracksDownloadable > 0 &&
                                    importJob.tracksMatched < importJob.tracksTotal && (
                                        <p className="text-sm text-warning mt-2">
                                            {importJob.tracksDownloadable} songs still
                                            downloading
                                        </p>
                                    )}
                            </>
                        )}
                        <div className="flex items-center justify-center gap-3 mt-6">
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setStep("input");
                                    setUrl("");
                                    setPreview(null);
                                    setImportJob(null);
                                    setRefreshStatusMessage(null);
                                }}
                            >
                                Import Another
                            </Button>
                            {importJob.tracksDownloadable > 0 &&
                                importJob.tracksMatched <
                                    importJob.tracksTotal && (
                                    <Button
                                        variant="secondary"
                                        onClick={async () => {
                                            try {
                                                setIsLoading(true);
                                                setRefreshStatusMessage(null);
                                                const result = await api.post<{
                                                    added: number;
                                                    total: number;
                                                }>(
                                                    `/spotify/import/${importJob.id}/refresh`,
                                                    {}
                                                );
                                                if (result.added > 0) {
                                                    setRefreshStatusMessage(
                                                        `Added ${plural(result.added, "new song")}.`
                                                    );
                                                    setImportJob((prev) =>
                                                        prev
                                                            ? {
                                                                  ...prev,
                                                                  tracksMatched:
                                                                      result.total,
                                                              }
                                                            : prev
                                                    );
                                                } else {
                                                    setRefreshStatusMessage(
                                                        "Albums still downloading. Try again later."
                                                    );
                                                }
                                            } catch {
                                                setRefreshStatusMessage(
                                                    "Failed to refresh."
                                                );
                                            } finally {
                                                setIsLoading(false);
                                            }
                                        }}
                                        disabled={isLoading}
                                    >
                                        {isLoading
                                            ? "Refreshing..."
                                            : "Refresh"}
                                    </Button>
                                )}
                            {refreshStatusMessage && (
                                <p className="text-xs text-[var(--text-muted)] mt-3">
                                    {refreshStatusMessage}
                                </p>
                            )}
                            {importJob.createdPlaylistId && (
                                <Button
                                    variant="primary"
                                    onClick={() =>
                                        router.push(
                                            `/playlist/${importJob.createdPlaylistId}`
                                        )
                                    }
                                    className="bg-success hover:bg-success hover:brightness-110"
                                >
                                    View Playlist
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ImportPlaylistPage() {
    return (
        <Suspense
            fallback={
                <LoadingScreen />
            }
        >
            <ImportPlaylistPageContent />
        </Suspense>
    );
}
