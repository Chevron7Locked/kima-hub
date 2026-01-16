"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import {
    ArrowLeft,
    Check,
    X,
    Download,
    Loader2,
    ExternalLink,
    ChevronDown,
    ChevronUp,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

// Types for Spotify Import
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
        notFound: number;
    };
}

interface PreviewJob {
    id: string;
    status: "pending" | "processing" | "completed" | "failed";
    error: string | null;
    result: ImportPreview | null;
}

interface ImportJob {
    id: string;
    status:
        | "pending"
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

type Step = "input" | "preview" | "importing" | "complete";

function SpotifyImportPageContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const hasAutoFetched = useRef(false);

    // State
    const [step, setStep] = useState<Step>("input");
    const [url, setUrl] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [previewJob, setPreviewJob] = useState<PreviewJob | null>(null);
    const [selectedAlbums, setSelectedAlbums] = useState<Set<string>>(
        new Set()
    );
    const [playlistName, setPlaylistName] = useState("");
    const [importJob, setImportJob] = useState<ImportJob | null>(null);
    const [refreshStatusMessage, setRefreshStatusMessage] = useState<
        string | null
    >(null);
    const [expandedSection, setExpandedSection] = useState<
        "matched" | "download" | "notfound" | null
    >("matched");

    // Auto-fetch preview if URL is provided in query params
    useEffect(() => {
        const urlParam = searchParams.get("url");
        if (urlParam && !hasAutoFetched.current) {
            hasAutoFetched.current = true;
            setUrl(urlParam);
            // Auto-trigger preview fetch
            (async () => {
                setIsLoading(true);
                try {
                    const result = await api.post<{
                        jobId: string;
                        status: string;
                    }>("/spotify/preview", {
                        url: urlParam,
                    });

                    setPreview(null);
                    setPlaylistName("");
                    setSelectedAlbums(new Set());

                    setPreviewJob({
                        id: result.jobId,
                        status: result.status as PreviewJob["status"],
                        error: null,
                        result: null,
                    });
                } catch (err) {
                    const message =
                        err instanceof Error
                            ? err.message
                            : "Failed to fetch playlist";
                    toast.error(message);
                    setIsLoading(false);
                }
            })();
        }
    }, [searchParams, toast]);

    // Poll for preview job status
    useEffect(() => {
        if (!previewJob || previewJob.status === "completed") {
            return;
        }

        if (previewJob.status === "failed") {
            const message = previewJob.error || "Failed to fetch playlist";
            toast.error(message);
            setIsLoading(false);
            setPreviewJob(null);
            return;
        }

        const interval = setInterval(async () => {
            try {
                const job = await api.get<PreviewJob>(
                    `/spotify/preview/${previewJob.id}/status`
                );
                setPreviewJob(job);

                if (job.status === "completed" && job.result) {
                    setPreview(job.result);
                    setPlaylistName(job.result.playlist.name);

                    // Auto-select all albums (Soulseek can search for any track, even without MBID)
                    const downloadableAlbumIds =
                        job.result.albumsToDownload.map(
                            (a) => a.albumMbid || a.spotifyAlbumId
                        );
                    setSelectedAlbums(new Set(downloadableAlbumIds));

                    setStep("preview");
                    setIsLoading(false);
                    setPreviewJob(null);
                } else if (job.status === "failed") {
                    const message =
                        job.error || "Failed to fetch playlist";
                    toast.error(message);
                    setIsLoading(false);
                    setPreviewJob(null);
                }
            } catch (err) {
                console.error("Failed to poll preview job status:", err);
            }
        }, 2000);

        return () => clearInterval(interval);
    }, [previewJob, toast]);

    // Poll for import job status
    useEffect(() => {
        if (
            !importJob ||
            importJob.status === "completed" ||
            importJob.status === "failed" ||
            importJob.status === "cancelled"
        ) {
            return;
        }

        const interval = setInterval(async () => {
            try {
                const job = await api.get<ImportJob>(
                    `/spotify/import/${importJob.id}/status`
                );
                setImportJob(job);

                if (job.status === "completed") {
                    setStep("complete");
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                    window.dispatchEvent(new CustomEvent("playlist-created"));
                } else if (job.status === "cancelled") {
                    setStep("complete");
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                    window.dispatchEvent(new CustomEvent("playlist-created"));
                } else if (job.status === "failed") {
                    setStep("complete");
                    window.dispatchEvent(
                        new CustomEvent("notifications-changed")
                    );
                }
            } catch (err) {
                console.error("Failed to poll job status:", err);
            }
        }, 2000);

        return () => clearInterval(interval);
    }, [importJob, toast]);

    // Handle URL paste/change
    const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setUrl(e.target.value);
    };

    // Fetch preview
    const handleFetchPreview = async () => {
        if (!url.trim()) {
            toast.error("Please enter a playlist URL");
            return;
        }

        setIsLoading(true);
        try {
            const result = await api.post<{ jobId: string; status: string }>(
                "/spotify/preview",
                { url }
            );

            setPreview(null);
            setPlaylistName("");
            setSelectedAlbums(new Set());

            setPreviewJob({
                id: result.jobId,
                status: result.status as PreviewJob["status"],
                error: null,
                result: null,
            });
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to fetch playlist";
            toast.error(message);
            setIsLoading(false);
        } finally {
            // Loading state will be cleared when preview job completes
        }
    };

    // Start import
    const handleStartImport = async () => {
        if (!preview) return;

        setIsLoading(true);
        setRefreshStatusMessage(null);
        try {
            const response = await api.post<{ jobId: string; status: string }>(
                "/spotify/import",
                {
                    spotifyPlaylistId: preview.playlist.id,
                    url,
                    playlistName: playlistName || preview.playlist.name,
                    albumMbidsToDownload: Array.from(selectedAlbums),
                }
            );

            setImportJob({
                id: response.jobId,
                status: "pending",
                progress: 0,
                albumsTotal: selectedAlbums.size,
                albumsCompleted: 0,
                tracksMatched: preview.summary.inLibrary,
                tracksTotal: preview.summary.total,
                tracksDownloadable: preview.summary.downloadable,
                createdPlaylistId: null,
                error: null,
            });
            setStep("importing");
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to start import";
            toast.error(message);
        } finally {
            setIsLoading(false);
        }
    };

    // Toggle album selection
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

    // Select/deselect all albums
    const toggleAllAlbums = () => {
        if (!preview) return;

        // All albums are downloadable via Soulseek (even without MBID)
        const allAlbumIds = preview.albumsToDownload.map(
            (a) => a.albumMbid || a.spotifyAlbumId
        );

        if (selectedAlbums.size === allAlbumIds.length) {
            setSelectedAlbums(new Set());
        } else {
            setSelectedAlbums(new Set(allAlbumIds));
        }
    };

    // Cancel import
    const [isCancelling, setIsCancelling] = useState(false);
    const handleCancelImport = async () => {
        if (!importJob) return;

        setIsCancelling(true);
        try {
            const result = await api.post<{
                message: string;
                playlistId: string | null;
                tracksMatched: number;
            }>(`/spotify/import/${importJob.id}/cancel`, {});

            setImportJob((prev) =>
                prev
                    ? {
                          ...prev,
                          status: "cancelled",
                          createdPlaylistId: null,
                          tracksMatched: 0,
                      }
                    : prev
            );
            setStep("complete");

            // Only dispatch notifications-changed, not playlist-created since no playlist was made
            window.dispatchEvent(new CustomEvent("notifications-changed"));
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to cancel import";
            toast.error(message);
        } finally {
            setIsCancelling(false);
        }
    };

    // Format duration
    const formatDuration = (ms: number) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    };

    return (
        <div className="min-h-screen relative">
            {/* Quick gradient fade - yellow to purple like home page */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-linear-to-b from-[#ecb200]/15 via-purple-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#ecb200]/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            <div className="relative max-w-3xl mx-auto px-6 py-6">
                {/* Header */}
                <div className="flex items-center gap-4 mb-6">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white/5 rounded-full transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5 text-gray-400" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            Import Playlist
                        </h1>
                        <p className="text-sm text-gray-400">
                            Import from Spotify or Deezer and download missing
                            albums
                        </p>
                    </div>
                </div>

                {/* Browse Link */}
                <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                    <p className="text-sm text-gray-300">
                        Looking for playlists to import?{" "}
                        <a
                            href="/browse/playlists"
                            className="text-[#ecb200] hover:underline font-medium"
                        >
                            Browse Deezer playlists & radio stations →
                        </a>
                    </p>
                </div>

                {/* Step: Input */}
                {step === "input" && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist URL
                            </label>
                            <input
                                type="text"
                                value={url}
                                onChange={handleUrlChange}
                                placeholder="https://www.deezer.com/playlist/... or https://open.spotify.com/playlist/..."
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#ecb200]/50 focus:border-[#ecb200] transition-colors"
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleFetchPreview()
                                }
                            />
                            <p className="text-xs text-gray-500 mt-2">
                                Paste a public{" "}
                                <span className="text-[#AD47FF]">Deezer</span>{" "}
                                or{" "}
                                <span className="text-[#1DB954]">Spotify</span>{" "}
                                playlist URL
                            </p>
                        </div>
                        <button
                            onClick={handleFetchPreview}
                            disabled={isLoading || !url.trim()}
                            className="w-full py-3 rounded-full font-medium bg-[#ecb200] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                        >
                            {isLoading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Loading...
                                </>
                            ) : (
                                "Continue"
                            )}
                        </button>
                    </div>
                )}

                {/* Step: Preview */}
                {step === "preview" && preview && (
                    <div className="space-y-4">
                        {/* Playlist Info */}
                        <div className="flex items-start gap-4 p-4 bg-white/5 rounded-lg">
                            {preview.playlist.imageUrl ? (
                                <img
                                    src={preview.playlist.imageUrl}
                                    alt={preview.playlist.name}
                                    className="w-20 h-20 rounded-md object-cover"
                                />
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
                                <p className="text-sm text-gray-400">
                                    {preview.playlist.owner} ·{" "}
                                    {preview.playlist.trackCount} songs
                                </p>
                                {preview.playlist.description && (
                                    <p className="text-sm text-gray-500 mt-1 line-clamp-1">
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
                                className="text-gray-400 hover:text-[#1DB954] transition-colors"
                            >
                                <ExternalLink className="w-4 h-4" />
                            </a>
                        </div>

                        {/* Summary Stats */}
                        <div className="grid grid-cols-4 gap-3">
                            <div className="text-center py-3 bg-white/5 rounded-lg">
                                <div className="text-xl font-bold text-white">
                                    {preview.summary.total}
                                </div>
                                <div className="text-xs text-gray-500">
                                    Total
                                </div>
                            </div>
                            <div className="text-center py-3 bg-green-500/10 rounded-lg">
                                <div className="text-xl font-bold text-green-400">
                                    {preview.summary.inLibrary}
                                </div>
                                <div className="text-xs text-gray-500">
                                    In Library
                                </div>
                            </div>
                            <div className="text-center py-3 bg-[#1DB954]/10 rounded-lg">
                                <div className="text-xl font-bold text-[#1DB954]">
                                    {
                                        preview.albumsToDownload.filter(
                                            (a) => a.albumMbid
                                        ).length
                                    }
                                </div>
                                <div className="text-xs text-gray-500">
                                    To Download
                                </div>
                            </div>
                            {preview.summary.notFound > 0 ? (
                                <div className="text-center py-3 bg-red-500/10 rounded-lg">
                                    <div className="text-xl font-bold text-red-400">
                                        {preview.summary.notFound}
                                    </div>
                                    <div className="text-xs text-gray-500">
                                        Not Found
                                    </div>
                                </div>
                            ) : (
                                <div className="text-center py-3 bg-green-500/10 rounded-lg">
                                    <div className="text-xl font-bold text-green-400">
                                        ✓
                                    </div>
                                    <div className="text-xs text-gray-500">
                                        All Matched
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Tracks already in library */}
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
                                        <Check className="w-4 h-4 text-green-400" />
                                        <span className="text-sm font-medium text-white">
                                            {preview.summary.inLibrary} songs in
                                            your library
                                        </span>
                                    </div>
                                    {expandedSection === "matched" ? (
                                        <ChevronUp className="w-4 h-4 text-gray-500" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-500" />
                                    )}
                                </button>
                                {expandedSection === "matched" && (
                                    <div className="border-t border-white/5 max-h-48 overflow-y-auto">
                                        {preview.matchedTracks
                                            .filter((m) => m.localTrack)
                                            .map((match, i) => (
                                                <div
                                                    key={
                                                        match.spotifyTrack
                                                            .spotifyId
                                                    }
                                                    className="flex items-center gap-3 px-4 py-2 hover:bg-white/5"
                                                >
                                                    <span className="text-xs text-gray-600 w-5 text-right">
                                                        {i + 1}
                                                    </span>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm text-white truncate">
                                                            {match.localTrack
                                                                ?.title ||
                                                                match
                                                                    .spotifyTrack
                                                                    .title}
                                                        </div>
                                                        <div className="text-xs text-gray-500 truncate">
                                                            {match.localTrack
                                                                ?.artistName ||
                                                                match
                                                                    .spotifyTrack
                                                                    .artist}
                                                        </div>
                                                    </div>
                                                    <span className="text-xs text-gray-600">
                                                        {formatDuration(
                                                            match.spotifyTrack
                                                                .durationMs
                                                        )}
                                                    </span>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Albums to download */}
                        {preview.albumsToDownload.filter((a) => a.albumMbid)
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
                                        <Download className="w-4 h-4 text-[#1DB954]" />
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
                                        <ChevronUp className="w-4 h-4 text-gray-500" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-500" />
                                    )}
                                </button>
                                {expandedSection === "download" && (
                                    <div className="border-t border-white/5">
                                        <div className="flex items-center justify-between px-4 py-2 bg-black/20">
                                            <button
                                                onClick={toggleAllAlbums}
                                                className="text-xs text-[#1DB954] hover:underline"
                                            >
                                                {selectedAlbums.size ===
                                                preview.albumsToDownload.length
                                                    ? "Deselect All"
                                                    : "Select All"}
                                            </button>
                                            <span className="text-xs text-gray-500">
                                                {selectedAlbums.size} selected
                                            </span>
                                        </div>
                                        <div className="max-h-48 overflow-y-auto">
                                            {preview.albumsToDownload.map(
                                                (album, index) => {
                                                    const albumKey =
                                                        album.albumMbid ||
                                                        album.spotifyAlbumId;
                                                    return (
                                                        <label
                                                            key={
                                                                albumKey ||
                                                                `album-${index}`
                                                            }
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
                                                                className="w-4 h-4 rounded border-white/20 bg-transparent text-[#1DB954] focus:ring-[#1DB954] focus:ring-offset-0"
                                                            />
                                                            {album.coverUrl && (
                                                                <img
                                                                    src={
                                                                        album.coverUrl
                                                                    }
                                                                    alt={
                                                                        album.albumName
                                                                    }
                                                                    className="w-10 h-10 rounded object-cover"
                                                                />
                                                            )}
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-sm text-white truncate">
                                                                    {
                                                                        album.albumName
                                                                    }
                                                                </div>
                                                                <div className="text-xs text-gray-500 truncate">
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

                        {/* Tracks not found */}
                        {preview.summary.notFound > 0 && (
                            <div className="bg-white/5 rounded-lg overflow-hidden">
                                <button
                                    onClick={() =>
                                        setExpandedSection(
                                            expandedSection === "notfound"
                                                ? null
                                                : "notfound"
                                        )
                                    }
                                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
                                >
                                    <div className="flex items-center gap-2">
                                        <X className="w-4 h-4 text-red-400" />
                                        <span className="text-sm font-medium text-white">
                                            {preview.summary.notFound} songs not
                                            found
                                        </span>
                                    </div>
                                    {expandedSection === "notfound" ? (
                                        <ChevronUp className="w-4 h-4 text-gray-500" />
                                    ) : (
                                        <ChevronDown className="w-4 h-4 text-gray-500" />
                                    )}
                                </button>
                                {expandedSection === "notfound" && (
                                    <div className="border-t border-white/5 max-h-48 overflow-y-auto">
                                        {preview.albumsToDownload
                                            .filter(
                                                (a) =>
                                                    !a.albumMbid &&
                                                    a.albumName !==
                                                        "Unknown Album"
                                            )
                                            .flatMap(
                                                (album) => album.tracksNeeded
                                            )
                                            .map((track) => (
                                                <div
                                                    key={track.spotifyId}
                                                    className="flex items-center gap-3 px-4 py-2 hover:bg-white/5"
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm text-gray-400 truncate">
                                                            {track.title}
                                                        </div>
                                                        <div className="text-xs text-gray-600 truncate">
                                                            {track.artist} ·{" "}
                                                            {track.album}
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Playlist name input */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">
                                Playlist Name
                            </label>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(e) =>
                                    setPlaylistName(e.target.value)
                                }
                                placeholder="Enter playlist name"
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#1DB954]/50 focus:border-[#1DB954] transition-colors"
                            />
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-3 pt-2">
                            <button
                                onClick={() => {
                                    setStep("input");
                                    setPreview(null);
                                }}
                                className="px-6 py-3 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Back
                            </button>
                            <button
                                onClick={handleStartImport}
                                disabled={
                                    isLoading ||
                                    (preview.summary.inLibrary === 0 &&
                                        selectedAlbums.size === 0)
                                }
                                className="flex-1 py-3 rounded-full font-medium bg-[#1DB954] text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Starting...
                                    </>
                                ) : preview.summary.inLibrary > 0 &&
                                  selectedAlbums.size > 0 ? (
                                    `Import ${preview.summary.inLibrary} songs + Download ${selectedAlbums.size} albums`
                                ) : preview.summary.inLibrary > 0 ? (
                                    `Import ${preview.summary.inLibrary} songs`
                                ) : selectedAlbums.size > 0 ? (
                                    `Download ${selectedAlbums.size} albums`
                                ) : (
                                    "Select albums to download"
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {/* Step: Importing */}
                {step === "importing" && importJob && (
                    <div className="text-center py-12">
                        <Loader2 className="w-10 h-10 text-[#1DB954] animate-spin mx-auto mb-4" />
                        <h2 className="text-lg font-bold text-white mb-1">
                            {importJob.status === "downloading"
                                ? "Queueing Album Downloads"
                                : importJob.status === "scanning"
                                ? "Scanning Library"
                                : importJob.status === "creating_playlist" ||
                                  importJob.status === "matching_tracks"
                                ? "Creating Playlist"
                                : importJob.status === "pending"
                                ? "Waiting for Downloads"
                                : "Starting Import"}
                        </h2>
                        <p className="text-sm text-gray-400 mb-6">
                            {importJob.status === "downloading" && (
                                <>
                                    Queued {importJob.albumsCompleted} of{" "}
                                    {importJob.albumsTotal} albums
                                </>
                            )}
                            {importJob.status === "pending" && (
                                <>
                                    Waiting for{" "}
                                    {importJob.albumsTotal -
                                        importJob.albumsCompleted}{" "}
                                    downloads to complete
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
                                className="bg-[#1DB954] h-1.5 rounded-full transition-all duration-500"
                                style={{ width: `${importJob.progress}%` }}
                            />
                        </div>
                        <p className="text-xs text-gray-500 mt-3">
                            {importJob.progress}% complete • downloads continue
                            in the background
                        </p>
                        {/* Cancel button */}
                        <button
                            onClick={handleCancelImport}
                            disabled={isCancelling}
                            className="mt-6 px-5 py-2 rounded-full text-sm font-medium text-gray-400 hover:text-white hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50"
                        >
                            {isCancelling ? (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin inline mr-2" />
                                    Cancelling...
                                </>
                            ) : (
                                "Cancel Import"
                            )}
                        </button>
                        <p className="text-xs text-gray-600 mt-2">
                            Playlist will be created with tracks downloaded so
                            far
                        </p>
                    </div>
                )}

                {/* Step: Complete */}
                {step === "complete" && importJob && (
                    <div className="text-center py-12">
                        <div
                            className={
                                "w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 " +
                                (importJob.status === "failed"
                                    ? "bg-red-500"
                                    : importJob.status === "cancelled"
                                    ? "bg-amber-500"
                                    : "bg-[#1DB954]")
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
                            <p className="text-sm text-gray-400">
                                {importJob.error ||
                                    "Something went wrong while importing."}
                            </p>
                        ) : importJob.status === "cancelled" ? (
                            <p className="text-sm text-gray-400">
                                Import was cancelled. No playlist was created.
                            </p>
                        ) : (
                            <>
                                <p className="text-sm text-gray-400">
                                    {importJob.tracksMatched > 0
                                        ? `Added ${importJob.tracksMatched} songs to your playlist`
                                        : "Playlist created (songs still downloading)"}
                                </p>
                                {importJob.tracksDownloadable > 0 &&
                                    importJob.tracksMatched < importJob.tracksTotal && (
                                        <p className="text-sm text-amber-400 mt-2">
                                            {importJob.tracksDownloadable} songs still
                                            downloading
                                        </p>
                                    )}
                            </>
                        )}
                        <div className="flex items-center justify-center gap-3 mt-6">
                            <button
                                onClick={() => {
                                    setStep("input");
                                    setUrl("");
                                    setPreview(null);
                                    setImportJob(null);
                                    setRefreshStatusMessage(null);
                                }}
                                className="px-5 py-2.5 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
                            >
                                Import Another
                            </button>
                            {importJob.tracksDownloadable > 0 &&
                                importJob.tracksMatched <
                                    importJob.tracksTotal && (
                                    <button
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
                                                        `Added ${result.added} new song(s).`
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
                                        className="px-5 py-2.5 rounded-full text-sm font-medium bg-#0a0a0a text-white hover:bg-white/20 disabled:opacity-50 transition-colors"
                                    >
                                        {isLoading
                                            ? "Refreshing..."
                                            : "Refresh"}
                                    </button>
                                )}
                            {refreshStatusMessage && (
                                <p className="text-xs text-gray-500 mt-3">
                                    {refreshStatusMessage}
                                </p>
                            )}
                            {importJob.createdPlaylistId && (
                                <button
                                    onClick={() =>
                                        router.push(
                                            `/playlist/${importJob.createdPlaylistId}`
                                        )
                                    }
                                    className="px-5 py-2.5 rounded-full text-sm font-medium bg-[#1DB954] text-black hover:brightness-110 transition-all"
                                >
                                    View Playlist
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function SpotifyImportPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-screen flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-[#ecb200] animate-spin" />
                </div>
            }
        >
            <SpotifyImportPageContent />
        </Suspense>
    );
}
