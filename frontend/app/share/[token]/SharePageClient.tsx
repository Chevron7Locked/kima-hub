"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import {
    Play,
    Pause,
    SkipForward,
    SkipBack,
    Music,
    Volume2,
    VolumeX,
    Github,
} from "lucide-react";
import { formatTime, formatDuration } from "@/utils/formatTime";

interface ShareTrack {
    id: string;
    title: string;
    duration: number;
    trackNo?: number;
    discNumber?: number | null;
    discSubtitle?: string | null;
    album?: {
        title: string;
        coverUrl?: string;
        artist?: {
            name: string;
        };
    };
}

interface ShareData {
    entityType: "playlist" | "track" | "album";
    entity: {
        id: string;
        name?: string;
        title?: string;
        coverUrl?: string;
        items?: { track: ShareTrack }[];
        tracks?: ShareTrack[];
        artist?: { name: string };
        album?: { title: string; coverUrl?: string; artist?: { name: string } };
        duration?: number;
    };
    createdAt: string;
}

function getCoverUrl(shareData: ShareData): string | null {
    const entity = shareData.entity;
    if (shareData.entityType === "playlist") {
        const firstItem = entity.items?.[0];
        return firstItem?.track?.album?.coverUrl || null;
    }
    if (shareData.entityType === "album") {
        return entity.coverUrl || null;
    }
    if (shareData.entityType === "track") {
        return entity.album?.coverUrl || null;
    }
    return null;
}

function getTracksFromEntity(shareData: ShareData): ShareTrack[] {
    const entity = shareData.entity;
    if (shareData.entityType === "playlist") {
        return entity.items?.map((item) => item.track).filter(Boolean) || [];
    }
    if (shareData.entityType === "album") {
        return entity.tracks || [];
    }
    if (shareData.entityType === "track") {
        return [
            {
                id: entity.id,
                title: entity.title || entity.name || "Unknown Track",
                duration: entity.duration || 0,
                album: entity.album,
            },
        ];
    }
    return [];
}

function getEntityTitle(shareData: ShareData): string {
    return shareData.entity.name || shareData.entity.title || "Shared Content";
}

function getEntitySubtitle(shareData: ShareData): string {
    if (shareData.entityType === "playlist") {
        const count = shareData.entity.items?.length || 0;
        return `${count} track${count !== 1 ? "s" : ""}`;
    }
    if (shareData.entityType === "album") {
        return shareData.entity.artist?.name || "Unknown Artist";
    }
    if (shareData.entityType === "track") {
        return shareData.entity.album?.artist?.name || "Unknown Artist";
    }
    return "";
}

export default function SharePageClient() {
    const params = useParams();
    const token = params.token as string;

    const [data, setData] = useState<ShareData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [progress, setProgress] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(0.8);
    const [isMuted, setIsMuted] = useState(false);
    const [playbackError, setPlaybackError] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const progressBarRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        fetch(`/api/share/${token}`)
            .then(async (res) => {
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(
                        body.error || `Failed to load (${res.status})`
                    );
                }
                return res.json();
            })
            .then(setData)
            .catch((err) => setError(err.message))
            .finally(() => setLoading(false));
    }, [token]);

    useEffect(() => {
        const audio = audioRef.current;
        return () => {
            audio?.pause();
            if (audio) audio.src = "";
        };
    }, []);

    const tracks = useMemo(() => data ? getTracksFromEntity(data) : [], [data]);
    const currentTrack = tracks[currentTrackIndex];

    const getStreamUrl = useCallback(
        (trackId: string) => `/api/share/${token}/stream/${trackId}`,
        [token]
    );

    const coverArtId = data ? getCoverUrl(data) : null;

    function buildCoverArtUrl(id: string): string {
        return `/api/share/${token}/cover-art/${encodeURIComponent(id)}?size=500`;
    }

    const coverArtUrl = coverArtId ? buildCoverArtUrl(coverArtId) : null;

    const playTrack = useCallback(
        (index: number) => {
            if (!audioRef.current || !tracks[index]) return;
            setCurrentTrackIndex(index);
            setPlaybackError(null);
            audioRef.current.src = getStreamUrl(tracks[index].id);
            audioRef.current.play()
                .then(() => setIsPlaying(true))
                .catch(() => setIsPlaying(false));
        },
        [tracks, getStreamUrl]
    );

    const togglePlay = useCallback(() => {
        if (!audioRef.current || !currentTrack) return;
        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            if (!audioRef.current.src || audioRef.current.src === window.location.href) {
                audioRef.current.src = getStreamUrl(currentTrack.id);
            }
            setPlaybackError(null);
            audioRef.current.play()
                .then(() => setIsPlaying(true))
                .catch(() => setIsPlaying(false));
        }
    }, [isPlaying, currentTrack, getStreamUrl]);

    const nextTrack = useCallback(() => {
        if (currentTrackIndex < tracks.length - 1) {
            playTrack(currentTrackIndex + 1);
        } else {
            setIsPlaying(false);
        }
    }, [currentTrackIndex, tracks.length, playTrack]);

    const prevTrack = useCallback(() => {
        if (audioRef.current && audioRef.current.currentTime > 3) {
            audioRef.current.currentTime = 0;
        } else if (currentTrackIndex > 0) {
            playTrack(currentTrackIndex - 1);
        }
    }, [currentTrackIndex, playTrack]);

    const handleProgressClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (!audioRef.current || !progressBarRef.current) return;
            const rect = progressBarRef.current.getBoundingClientRect();
            const fraction = Math.max(
                0,
                Math.min(1, (e.clientX - rect.left) / rect.width)
            );
            audioRef.current.currentTime = fraction * (audioRef.current.duration || 0);
        },
        []
    );

    const toggleMute = useCallback(() => {
        if (!audioRef.current) return;
        setIsMuted((prev) => {
            audioRef.current!.muted = !prev;
            return !prev;
        });
    }, []);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.volume = volume;
        }
    }, [volume]);

    const handleAudioError = useCallback(() => {
        setIsPlaying(false);
        if (audioRef.current?.error) {
            const code = audioRef.current.error.code;
            if (code === MediaError.MEDIA_ERR_NETWORK) {
                setPlaybackError("Playback failed. The link may have expired or reached its play limit.");
            } else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
                setPlaybackError("This audio format is not supported by your browser.");
            } else {
                setPlaybackError("Playback error occurred.");
            }
        }
    }, []);

    const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

    // Loading
    if (loading) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-[#fca200]/30 border-t-[#fca200] rounded-full animate-spin" />
                    <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">
                        Loading
                    </p>
                </div>
            </div>
        );
    }

    // Error
    if (error || !data) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-4">
                <div className="text-center max-w-sm">
                    <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
                        <Music className="w-5 h-5 text-white/15" />
                    </div>
                    <p className="text-sm font-medium text-white/70 mb-1">
                        {error?.includes("expired")
                            ? "Link expired"
                            : error?.includes("limit")
                              ? "Play limit reached"
                              : "Not found"}
                    </p>
                    <p className="text-xs text-white/30">
                        {error || "This share link is no longer available."}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#0a0a0a] flex flex-col">
            <audio
                ref={audioRef}
                onTimeUpdate={() => {
                    if (audioRef.current) {
                        setProgress(audioRef.current.currentTime);
                        setDuration(audioRef.current.duration || 0);
                    }
                }}
                onEnded={nextTrack}
                onError={handleAudioError}
                preload="none"
            />

            {/* Main content */}
            <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 md:py-12">
                <div className="w-full max-w-lg">

                    {/* Cover art */}
                    <div className="relative w-full aspect-square max-w-[280px] mx-auto mb-8 rounded-xl overflow-hidden bg-white/[0.03] shadow-2xl shadow-black/60">
                        {coverArtUrl ? (
                            <Image
                                src={coverArtUrl}
                                alt=""
                                fill
                                unoptimized
                                className="object-cover"
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-16 h-16 text-white/[0.06]" />
                            </div>
                        )}
                    </div>

                    {/* Title and subtitle */}
                    <div className="text-center mb-6">
                        <h1 className="text-xl font-bold text-white tracking-tight mb-1 line-clamp-2">
                            {getEntityTitle(data)}
                        </h1>
                        <p className="text-sm text-white/40">
                            {getEntitySubtitle(data)}
                            {tracks.length > 1 && totalDuration > 0 && (
                                <span className="text-white/20"> -- {formatDuration(totalDuration)}</span>
                            )}
                        </p>
                    </div>

                    {/* Player controls */}
                    {tracks.length > 0 && (
                        <div className="mb-8">
                            {playbackError && (
                                <p className="text-xs text-red-400/70 text-center mb-3">
                                    {playbackError}
                                </p>
                            )}

                            {/* Progress */}
                            <div
                                ref={progressBarRef}
                                className="h-1 bg-white/[0.08] rounded-full cursor-pointer mb-2 group"
                                onClick={handleProgressClick}
                            >
                                <div
                                    className="h-full bg-[#fca200] rounded-full transition-[width] duration-100"
                                    style={{
                                        width: `${duration > 0 ? (progress / duration) * 100 : 0}%`,
                                    }}
                                />
                            </div>

                            <div className="flex justify-between text-[10px] font-mono text-white/20 mb-5 tabular-nums">
                                <span>{formatTime(progress)}</span>
                                <span>{formatTime(duration)}</span>
                            </div>

                            {/* Buttons */}
                            <div className="flex items-center justify-center gap-6">
                                {tracks.length > 1 && (
                                    <button
                                        onClick={prevTrack}
                                        className="text-white/30 hover:text-white/70 transition-colors"
                                    >
                                        <SkipBack className="w-5 h-5" />
                                    </button>
                                )}

                                <button
                                    onClick={togglePlay}
                                    className="w-12 h-12 rounded-full bg-white flex items-center justify-center hover:scale-105 transition-transform"
                                >
                                    {isPlaying ? (
                                        <Pause className="w-5 h-5 fill-current text-black" />
                                    ) : (
                                        <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                                    )}
                                </button>

                                {tracks.length > 1 && (
                                    <button
                                        onClick={nextTrack}
                                        disabled={currentTrackIndex >= tracks.length - 1}
                                        className="text-white/30 hover:text-white/70 transition-colors disabled:opacity-20"
                                    >
                                        <SkipForward className="w-5 h-5" />
                                    </button>
                                )}
                            </div>

                            {/* Volume */}
                            <div className="flex items-center justify-center gap-2 mt-4">
                                <button
                                    onClick={toggleMute}
                                    className="text-white/20 hover:text-white/40 transition-colors"
                                >
                                    {isMuted || volume === 0 ? (
                                        <VolumeX className="w-3.5 h-3.5" />
                                    ) : (
                                        <Volume2 className="w-3.5 h-3.5" />
                                    )}
                                </button>
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    value={isMuted ? 0 : volume}
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        setVolume(v);
                                        setIsMuted(v === 0);
                                    }}
                                    className="w-20 h-0.5 accent-white/40 cursor-pointer"
                                />
                            </div>

                            {/* Now playing indicator */}
                            {currentTrack && tracks.length > 1 && (
                                <p className="text-[10px] text-white/25 text-center mt-3 truncate">
                                    {currentTrack.title}
                                </p>
                            )}
                        </div>
                    )}

                    {/* Track list */}
                    {tracks.length > 1 && (
                        <div className="border-t border-white/[0.04] pt-4">
                            {tracks.map((track, index) => {
                                const isActive = index === currentTrackIndex;
                                const trackCoverId = track.album?.coverUrl || coverArtId;
                                const trackCoverUrl = trackCoverId
                                    ? buildCoverArtUrl(trackCoverId)
                                    : null;

                                const trackNumber = track.trackNo ?? index + 1;
                                const trackLabel =
                                    track.discNumber != null && track.discNumber > 1
                                        ? `${track.discNumber}-${String(trackNumber).padStart(2, "0")}`
                                        : String(trackNumber);

                                return (
                                    <button
                                        key={track.id}
                                        onClick={() => playTrack(index)}
                                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors group ${
                                            isActive
                                                ? "bg-white/[0.04]"
                                                : "hover:bg-white/[0.02]"
                                        }`}
                                    >
                                        <div className="w-8 text-center flex-shrink-0">
                                            {isActive && isPlaying ? (
                                                <div className="flex items-center justify-center gap-[2px] h-3.5">
                                                    <span className="w-[2px] h-2.5 bg-[#fca200] rounded-full animate-pulse" />
                                                    <span className="w-[2px] h-3.5 bg-[#fca200] rounded-full animate-pulse [animation-delay:150ms]" />
                                                    <span className="w-[2px] h-2 bg-[#fca200] rounded-full animate-pulse [animation-delay:300ms]" />
                                                </div>
                                            ) : (
                                                <span className={`text-[11px] font-mono ${
                                                    isActive ? "text-[#fca200]" : "text-white/15"
                                                }`}>
                                                    {trackLabel}
                                                </span>
                                            )}
                                        </div>

                                        {trackCoverUrl && (
                                            <div className="relative w-8 h-8 rounded bg-white/[0.03] flex-shrink-0 overflow-hidden">
                                                <Image
                                                    src={trackCoverUrl}
                                                    alt=""
                                                    fill
                                                    unoptimized
                                                    className="object-cover"
                                                />
                                            </div>
                                        )}

                                        <div className="flex-1 min-w-0 text-left">
                                            <p className={`text-sm truncate ${
                                                isActive ? "text-[#fca200]" : "text-white/70"
                                            }`}>
                                                {track.title}
                                            </p>
                                            {track.album?.artist?.name && (
                                                <p className="text-[11px] text-white/25 truncate">
                                                    {track.album.artist.name}
                                                </p>
                                            )}
                                        </div>

                                        <span className="text-[11px] font-mono text-white/15 flex-shrink-0 tabular-nums">
                                            {track.duration ? formatTime(track.duration) : ""}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-6">
                <div className="max-w-lg mx-auto flex items-center justify-center gap-3">
                    <span className="text-[10px] font-mono text-white/10 uppercase tracking-widest">
                        Powered by Kima
                    </span>
                    <span className="text-white/[0.06]">|</span>
                    <a
                        href="https://github.com/Chevron7Locked/kima-hub"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[10px] font-mono text-white/10 hover:text-white/25 uppercase tracking-widest transition-colors"
                    >
                        <Github className="w-3 h-3" />
                        GitHub
                    </a>
                </div>
            </div>
        </div>
    );
}
