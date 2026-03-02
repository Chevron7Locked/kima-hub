"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { formatTime } from "@/utils/formatTime";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
    ArrowLeft,
    Play,
    Pause,
    Download,
    Loader2,
    ExternalLink,
    Music2,
    Volume2,
    VolumeX,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";

const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

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
    const { toast } = useToast();
    const playlistId = params.id as string;

    const [playlist, setPlaylist] = useState<DeezerPlaylistFull | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isImporting] = useState(false);
    const { volume, isMuted } = useAudioState();
    const { toggleMute } = useAudioControls();

    const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const applyCurrentPlayerVolume = useCallback((audio: HTMLAudioElement) => {
        audio.volume = isMuted ? 0 : volume;
    }, [volume, isMuted]);

    const teardownPreviewAudio = useCallback((audio: HTMLAudioElement | null) => {
        if (!audio) return;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = "";
        audio.load();
    }, []);

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

    useEffect(() => {
        if (audioRef.current) {
            applyCurrentPlayerVolume(audioRef.current);
        }
    }, [applyCurrentPlayerVolume]);

    useEffect(() => {
        return () => {
            if (audioRef.current) {
                teardownPreviewAudio(audioRef.current);
                audioRef.current = null;
            }
        };
    }, [teardownPreviewAudio]);

    const handlePlayPreview = (track: DeezerTrack) => {
        if (!track.previewUrl) {
            toast.error("No preview available for this track");
            return;
        }

        if (playingTrackId === track.deezerId) {
            if (isPreviewPlaying && audioRef.current) {
                audioRef.current.pause();
                setIsPreviewPlaying(false);
            } else if (audioRef.current) {
                applyCurrentPlayerVolume(audioRef.current);
                audioRef.current.play().catch(() => setIsPreviewPlaying(false));
                setIsPreviewPlaying(true);
            }
            return;
        }

        if (audioRef.current) {
            teardownPreviewAudio(audioRef.current);
        }

        const audio = new Audio(track.previewUrl);
        applyCurrentPlayerVolume(audio);
        audioRef.current = audio;

        audio.onended = () => {
            if (audioRef.current !== audio) return;
            setPlayingTrackId(null);
            setIsPreviewPlaying(false);
            audioRef.current = null;
        };

        audio.onerror = () => {
            if (audioRef.current !== audio) return;
            toast.error("Failed to play preview");
            setPlayingTrackId(null);
            setIsPreviewPlaying(false);
            audioRef.current = null;
        };

        audio.play().catch(() => {
            setPlayingTrackId(null);
            setIsPreviewPlaying(false);
        });
        setPlayingTrackId(track.deezerId);
        setIsPreviewPlaying(true);
    };

    const stopPreview = () => {
        if (audioRef.current) {
            teardownPreviewAudio(audioRef.current);
            audioRef.current = null;
        }
        setPlayingTrackId(null);
        setIsPreviewPlaying(false);
    };

    const handleToggleMute = () => {
        toggleMute();
        if (audioRef.current) {
            applyCurrentPlayerVolume(audioRef.current);
        }
    };

    const handleImport = () => {
        if (!playlist) return;
        router.push(`/import/spotify?url=${encodeURIComponent(playlist.url)}`);
    };

    const totalDuration = playlist?.tracks.reduce((sum, track) => sum + track.durationMs, 0) || 0;

    const formatTotalDuration = (ms: number) => {
        const hours = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        if (hours > 0) return `${hours} hr ${mins} min`;
        return `${mins} min`;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error || !playlist) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black">
                <div className="relative px-4 md:px-8 pt-8">
                    <div className="max-w-[1800px] mx-auto">
                        <button
                            onClick={() => router.push("/browse/playlists")}
                            className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white transition-colors mb-8 uppercase tracking-wider"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                            Browse
                        </button>
                        <div className="flex flex-col items-center justify-center py-20 text-center">
                            <Music2 className="w-12 h-12 text-white/10 mb-4" />
                            <h3 className="text-lg font-black text-white mb-2 tracking-tight">
                                Playlist not found
                            </h3>
                            <p className="text-xs font-mono text-white/40 mb-6 max-w-sm uppercase tracking-wider">
                                {error || "This playlist may be private or no longer available."}
                            </p>
                            <button
                                onClick={() => router.push("/browse/playlists")}
                                className="px-6 py-2.5 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] text-white text-xs font-black uppercase tracking-wider transition-all"
                            >
                                Browse playlists
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Hero Section */}
            <div className="relative">
                {/* Background */}
                {playlist.imageUrl && (
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="absolute inset-0 scale-110 blur-md opacity-30">
                            <Image
                                src={playlist.imageUrl}
                                alt={playlist.title}
                                fill
                                sizes="100vw"
                                className="object-cover"
                                unoptimized
                            />
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-b from-[#a855f7]/10 via-[#0a0a0a]/90 to-[#0a0a0a]" />
                    </div>
                )}

                <div className="relative px-4 md:px-8 pt-8 pb-6">
                    <div className="max-w-[1800px] mx-auto">
                        {/* Back navigation */}
                        <button
                            onClick={() => router.push("/browse/playlists")}
                            className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white transition-colors mb-6 uppercase tracking-wider"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                            Browse
                        </button>

                        {/* System status */}
                        <div className="flex items-center gap-2 mb-4">
                            <DeezerIcon className="w-3.5 h-3.5 text-[#a855f7]" />
                            <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                                Deezer Playlist
                            </span>
                        </div>

                        <div className="flex items-end gap-6">
                            {/* Cover Art */}
                            <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#0a0a0a] rounded-lg shadow-2xl shrink-0 overflow-hidden relative border-2 border-white/10">
                                {playlist.imageUrl ? (
                                    <Image
                                        src={playlist.imageUrl}
                                        alt={playlist.title}
                                        fill
                                        sizes="(max-width: 768px) 140px, 192px"
                                        className="object-cover"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Music2 className="w-16 h-16 text-white/10" />
                                    </div>
                                )}
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0 pb-1">
                                <h1 className="text-2xl md:text-4xl lg:text-5xl font-black text-white leading-tight line-clamp-2 mb-2 tracking-tighter">
                                    {playlist.title}
                                </h1>
                                {playlist.description && (
                                    <p className="text-sm text-white/40 line-clamp-2 mb-3 hidden md:block">
                                        {playlist.description}
                                    </p>
                                )}
                                <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-white/50 uppercase tracking-wider">
                                    <span className="font-black text-white normal-case tracking-tight text-sm">
                                        {playlist.creator}
                                    </span>
                                    <span className="text-white/20">|</span>
                                    <span>{playlist.trackCount} songs</span>
                                    {totalDuration > 0 && (
                                        <>
                                            <span className="text-white/20">|</span>
                                            <span>{formatTotalDuration(totalDuration)}</span>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Action Bar */}
                <div className="relative px-4 md:px-8 pb-4">
                    <div className="max-w-[1800px] mx-auto">
                        <div className="flex items-center gap-3">
                            {/* Download/Import Button */}
                            <button
                                onClick={handleImport}
                                disabled={isImporting}
                                className="h-10 px-5 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] transition-all flex items-center gap-2 font-black text-sm text-white uppercase tracking-wider disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]"
                            >
                                {isImporting ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <Download className="w-4 h-4" />
                                )}
                                <span>{isImporting ? "Importing" : "Import Playlist"}</span>
                            </button>

                            {/* Volume Control */}
                            {playingTrackId && (
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={handleToggleMute}
                                        className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
                                    >
                                        {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                                    </button>
                                    <button
                                        onClick={stopPreview}
                                        className="px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider bg-white/5 text-white/50 hover:bg-white/10 hover:text-white border border-white/10 transition-all"
                                    >
                                        Stop Preview
                                    </button>
                                </div>
                            )}

                            <div className="flex-1" />

                            {/* Open in Deezer */}
                            <a
                                href={playlist.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-2.5 rounded-lg text-white/40 hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
                                title="Open in Deezer"
                            >
                                <ExternalLink className="w-4 h-4" />
                            </a>
                        </div>
                    </div>
                </div>
            </div>

            {/* Track Listing */}
            <div className="relative px-4 md:px-8 pb-32">
                <div className="max-w-[1800px] mx-auto">
                    {playlist.tracks.length > 0 ? (
                        <div>
                            <div className="flex items-center gap-3 mb-6">
                                <span className="w-1 h-8 bg-gradient-to-b from-[#a855f7] to-[#c026d3] rounded-full shrink-0" />
                                <h2 className="text-2xl font-black tracking-tighter uppercase">Tracks</h2>
                                <span className="text-xs font-mono text-[#a855f7]">
                                    {playlist.trackCount}
                                </span>
                                <span className="flex-1 border-t border-white/10" />
                            </div>

                            {/* Table Header */}
                            <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-3 py-2 text-[10px] font-mono text-white/30 uppercase tracking-wider border-b border-white/10 mb-1">
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
                                            className={cn(
                                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-3 py-2 rounded-lg transition-all group",
                                                hasPreview
                                                    ? "hover:bg-white/[0.03] cursor-pointer"
                                                    : "opacity-40 cursor-not-allowed",
                                                isCurrentlyPlaying && "bg-white/5 border border-[#a855f7]/30"
                                            )}
                                        >
                                            {/* Track Number / Play */}
                                            <div className="flex items-center justify-center">
                                                {hasPreview ? (
                                                    <>
                                                        <span className={cn(
                                                            "text-xs font-mono group-hover:hidden",
                                                            isCurrentlyPlaying ? "hidden" : "text-white/30"
                                                        )}>
                                                            {isCurrentlyPlaying && isPreviewPlaying ? (
                                                                <Pause className="w-4 h-4 text-[#a855f7]" />
                                                            ) : (
                                                                index + 1
                                                            )}
                                                        </span>
                                                        {isCurrentlyPlaying && isPreviewPlaying ? (
                                                            <Pause className="w-4 h-4 text-[#a855f7] hidden group-hover:block" />
                                                        ) : (
                                                            <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                        )}
                                                    </>
                                                ) : (
                                                    <span className="text-xs font-mono text-white/20">
                                                        {index + 1}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Title + Artist */}
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="relative w-10 h-10 bg-[#0a0a0a] rounded border border-white/10 shrink-0 overflow-hidden">
                                                    {track.coverUrl ? (
                                                        <Image
                                                            src={track.coverUrl}
                                                            alt={track.title}
                                                            fill
                                                            sizes="40px"
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Music2 className="w-4 h-4 text-white/10" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className={cn(
                                                        "text-sm font-black truncate tracking-tight",
                                                        isCurrentlyPlaying ? "text-[#a855f7]" : "text-white"
                                                    )}>
                                                        {track.title}
                                                    </p>
                                                    <p className="text-[10px] font-mono text-white/40 truncate uppercase tracking-wider">
                                                        {track.artist}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Album */}
                                            <p className="hidden md:flex items-center text-xs font-mono text-white/30 truncate uppercase tracking-wider">
                                                {track.album}
                                            </p>

                                            {/* Duration */}
                                            <div className="flex items-center justify-end">
                                                <span className="text-[10px] font-mono text-white/30 uppercase tracking-wider">
                                                    {formatTime(Math.round(track.durationMs / 1000))}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <Music2 className="w-12 h-12 text-white/10 mb-4" />
                            <h3 className="text-lg font-black text-white mb-2 tracking-tight">
                                No tracks found
                            </h3>
                            <p className="text-xs font-mono text-white/40 uppercase tracking-wider">
                                This playlist appears to be empty
                            </p>
                        </div>
                    )}
                </div>
            </div>

            {/* Preview indicator */}
            {playingTrackId && (
                <div className="fixed bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 bg-[#a855f7] rounded-lg text-white text-xs font-black uppercase tracking-wider shadow-lg shadow-[#a855f7]/20 flex items-center gap-2 z-[55]">
                    <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                    Playing 30s preview
                </div>
            )}
        </div>
    );
}
