"use client";

import { useState, useEffect } from "react";
import { formatTime, plural } from "@/lib/format";
import { useParams, useRouter } from "next/navigation";
import {
    ArrowLeft,
    Play,
    Pause,
    Download,
    ExternalLink,
    Music2,
    Volume2,
    VolumeX,
} from "lucide-react";
import { api } from "@/lib/api";
import { usePreview } from "@/hooks/usePreview";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/cn";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { PageMessage } from "@/components/ui/PageMessage";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { CachedImage } from "@/components/ui/CachedImage";
import { DeezerIcon } from "@/features/home/components/DeezerIcon";

interface DeezerTrack {
    deezerId: string;
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    durationMs: number;
    previewUrl: string | null;
    coverUrl: string | null;
}

interface DeezerPlaylistFull {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: DeezerTrack[];
    isPublic: boolean;
    source: string;
    url: string;
}

export default function DeezerPlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const playlistId = params.id as string;

    const [playlist, setPlaylist] = useState<DeezerPlaylistFull | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const { isMuted } = useAudioState();
    const { toggleMute } = useAudioControls();
    const preview = usePreview();
    const playingTrackId = preview.previewId;
    const isPreviewPlaying = preview.playing;

    useEffect(() => {
        async function fetchPlaylist() {
            setIsLoading(true);
            setError(null);
            try {
                const data = await api.get<DeezerPlaylistFull>(
                    `/browse/playlists/${playlistId}`
                );
                setPlaylist(data);
            } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to load playlist";
                setError(message);
            } finally {
                setIsLoading(false);
            }
        }
        fetchPlaylist();
    }, [playlistId]);

    const handlePlayPreview = (track: DeezerTrack) => {
        if (!track.previewUrl) {
            notify.error("No preview available for this track");
            return;
        }
        preview.toggle(track.deezerId, api.getTrackPreviewStreamUrl(track.artist, track.title));
    };

    const handleImport = () => {
        if (!playlist) return;
        router.push(`/import/playlist?url=${encodeURIComponent(playlist.url)}`);
    };

    const totalDuration = playlist?.tracks.reduce((sum, track) => sum + track.durationMs, 0) || 0;

    const formatTotalDuration = (ms: number) => {
        const hours = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        if (hours > 0) return `${hours} hr ${mins} min`;
        return `${mins} min`;
    };

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (error || !playlist) {
        return (
            <PageMessage
                icon={<Music2 />}
                title="Playlist not found"
                description="This playlist may be private or no longer available."
                action={{ label: "Browse playlists", href: "/browse/playlists" }}
            />
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black section-stack">
            <div className="relative">
                {playlist.imageUrl && (
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="absolute inset-0 scale-110 blur-md opacity-30">
                            <CachedImage
                                src={playlist.imageUrl}
                                alt={playlist.title}
                                fill
                                className="object-cover"
                            />
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-b from-type-track/10 via-[#0a0a0a]/90 to-[#0a0a0a]" />
                    </div>
                )}

                <div className="relative page-shell pt-8 pb-6">
                    <div>
                        <button
                            onClick={() => router.push("/browse/playlists")}
                            className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors mb-6"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                            Browse
                        </button>

                        <div className="flex items-center gap-2 mb-4">
                            <DeezerIcon className="w-3.5 h-3.5 text-brand" />
                            <span className="text-xs text-[var(--text-secondary)]">
                                Deezer Playlist
                            </span>
                        </div>

                        <div className="flex items-end gap-6">
                            <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[var(--bg-primary)] rounded-lg shrink-0 overflow-hidden relative border-2 border-white/10">
                                {playlist.imageUrl ? (
                                    <CachedImage
                                        src={playlist.imageUrl}
                                        alt={playlist.title}
                                        fill
                                        sizes="(max-width: 768px) 140px, 192px"
                                        className="object-cover"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Music2 className="w-16 h-16 text-white/10" />
                                    </div>
                                )}
                            </div>

                            <div className="flex-1 min-w-0 pb-1">
                                <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2 tracking-tight">
                                    {playlist.title}
                                </h1>
                                {playlist.description && (
                                    <p className="text-sm text-[var(--text-muted)] line-clamp-2 mb-3 hidden md:block">
                                        {playlist.description}
                                    </p>
                                )}
                                <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-[var(--text-secondary)]">
                                    <span className="font-bold text-white tracking-tight text-sm">
                                        {playlist.creator}
                                    </span>
                                    <span className="text-[var(--text-muted)]">|</span>
                                    <span>{plural(playlist.trackCount, "song")}</span>
                                    {totalDuration > 0 && (
                                        <>
                                            <span className="text-[var(--text-muted)]">|</span>
                                            <span>{formatTotalDuration(totalDuration)}</span>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="relative page-shell pb-4">
                <div>
                    <div className="flex items-center gap-3">
                        <Button variant="primary" onClick={handleImport}>
                            <Download className="w-4 h-4" />
                            <span>Import Playlist</span>
                        </Button>

                        {playingTrackId && (
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={toggleMute}
                                    className="p-2 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
                                >
                                    {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                                </button>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={preview.stop}
                                >
                                    Stop Preview
                                </Button>
                            </div>
                        )}

                        <div className="flex-1" />

                        <a
                            href={playlist.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
                            title="open in deezer"
                        >
                            <ExternalLink className="w-4 h-4" />
                        </a>
                    </div>
                </div>
            </div>

            <div className="relative page-shell page-end animate-rise">
                <div>
                    {playlist.tracks.length > 0 ? (
                        <div>
                            <SectionHeader type="track" title="Tracks" count={playlist.trackCount} />

                            <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-3 py-2 text-xs text-[var(--text-muted)] border-b border-white/10 mb-1">
                                <span className="text-center">#</span>
                                <span>Title</span>
                                <span>Album</span>
                                <span className="text-right">Duration</span>
                            </div>

                            <div className="space-y-0.5">
                                {playlist.tracks.map((track, index) => {
                                    const isCurrentlyPlaying = playingTrackId === track.deezerId;
                                    const hasPreview = !!track.previewUrl;

                                    return (
                                        <div
                                            key={track.deezerId}
                                            onClick={() => hasPreview && handlePlayPreview(track)}
                                            role={hasPreview ? "button" : undefined}
                                            tabIndex={hasPreview ? 0 : undefined}
                                            aria-label={hasPreview ? `play a preview of ${track.title}` : undefined}
                                            title={hasPreview ? undefined : "no preview available"}
                                            onKeyDown={(e) => {
                                                if (hasPreview && (e.key === "Enter" || e.key === " ")) {
                                                    e.preventDefault();
                                                    handlePlayPreview(track);
                                                }
                                            }}
                                            className={cn(
                                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-3 py-2 rounded-lg transition-all group",
                                                hasPreview
                                                    ? "hover:bg-white/[0.03] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                                    : "opacity-60 cursor-not-allowed",
                                                isCurrentlyPlaying && "bg-white/5 border border-brand/30"
                                            )}
                                        >
                                            <div className="flex items-center justify-center">
                                                {hasPreview ? (
                                                    <>
                                                        <span className={cn(
                                                            "text-xs tabular-nums group-hover:hidden",
                                                            isCurrentlyPlaying ? "hidden" : "text-[var(--text-muted)]"
                                                        )}>
                                                            {isCurrentlyPlaying && isPreviewPlaying ? (
                                                                <Pause className="w-4 h-4 text-brand" />
                                                            ) : (
                                                                index + 1
                                                            )}
                                                        </span>
                                                        {isCurrentlyPlaying && isPreviewPlaying ? (
                                                            <Pause className="w-4 h-4 text-brand hidden group-hover:block" />
                                                        ) : (
                                                            <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                        )}
                                                    </>
                                                ) : (
                                                    <span className="text-xs tabular-nums text-[var(--text-muted)]">
                                                        {index + 1}
                                                    </span>
                                                )}
                                            </div>

                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="relative w-10 h-10 bg-[var(--bg-primary)] rounded border border-white/10 shrink-0 overflow-hidden">
                                                    {track.coverUrl ? (
                                                        <CachedImage
                                                            src={track.coverUrl}
                                                            alt={track.title}
                                                            fill
                                                            sizes="40px"
                                                            className="object-cover"
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Music2 className="w-4 h-4 text-white/10" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className={cn(
                                                        "text-sm font-bold truncate tracking-tight",
                                                        isCurrentlyPlaying ? "text-brand" : "text-white"
                                                    )}>
                                                        {track.title}
                                                    </p>
                                                    <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                                                        {track.artist}
                                                    </p>
                                                </div>
                                            </div>

                                            <p className="hidden md:flex items-center text-xs tabular-nums text-[var(--text-muted)] truncate">
                                                {track.album}
                                            </p>

                                            <div className="flex items-center justify-end">
                                                <span className="text-xs tabular-nums text-[var(--text-muted)]">
                                                    {formatTime(Math.round(track.durationMs / 1000))}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        <EmptyState
                            icon={<Music2 className="w-12 h-12" />}
                            title="No tracks found"
                            description="This playlist appears to be empty"
                        />
                    )}
                </div>
            </div>

        </div>
    );
}
