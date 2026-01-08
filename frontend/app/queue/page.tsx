"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAudio } from "@/lib/audio-context";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import {
    Music,
    Play,
    X,
    GripVertical,
    Trash2,
    ListMusic,
    ChevronUp,
    ChevronDown,
} from "lucide-react";

export default function QueuePage() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { queue, currentTrack, currentIndex, playTracks, removeFromQueue } =
        useAudio();
    const { toast } = useToast();

    useEffect(() => {
        if (!isAuthenticated) {
            router.push("/login");
        }
    }, [isAuthenticated, router]);

    const handleClearQueue = () => {
        // Clear queue by playing an empty array
        playTracks([], 0);
        toast.success("Queue cleared");
    };

    const handleRemoveTrack = (index: number) => {
        removeFromQueue(index);
        toast.success("Removed from queue");
    };

    const handlePlayFromQueue = (index: number) => {
        playTracks(queue, index);
        toast.success("Playing from queue");
    };

    const handleMoveUp = (index: number) => {
        if (index <= currentIndex + 1) return; // Can't move past current track
        const newQueue = [...queue];
        [newQueue[index], newQueue[index - 1]] = [
            newQueue[index - 1],
            newQueue[index],
        ];
        playTracks(newQueue, currentIndex);
    };

    const handleMoveDown = (index: number) => {
        if (index >= queue.length - 1 || index <= currentIndex) return;
        const newQueue = [...queue];
        [newQueue[index], newQueue[index + 1]] = [
            newQueue[index + 1],
            newQueue[index],
        ];
        playTracks(newQueue, currentIndex);
    };

    if (!isAuthenticated) {
        return null;
    }

    // Split queue into current, next up, and previous
    const previousTracks = queue.slice(0, currentIndex);
    const nextTracks = queue.slice(currentIndex + 1);

    return (
        <div className="min-h-screen bg-[#0a0a0a]">
            <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
                {/* Header */}
                <div className="mb-8">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="flex items-center gap-3 mb-2">
                                <ListMusic className="w-8 h-8 text-purple-400" />
                                <h1 className="text-3xl md:text-4xl font-bold text-white">
                                    Queue
                                </h1>
                            </div>
                            <p className="text-gray-400">
                                {queue.length} track
                                {queue.length !== 1 ? "s" : ""} in queue
                            </p>
                        </div>
                        {queue.length > 0 && (
                            <Button
                                variant="secondary"
                                onClick={handleClearQueue}
                            >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Clear Queue
                            </Button>
                        )}
                    </div>
                </div>

                {/* Empty State */}
                {queue.length === 0 && (
                    <EmptyState
                        icon={<ListMusic />}
                        title="No tracks in queue"
                        description="Start playing music to see your queue here"
                        action={{
                            label: "Browse Library",
                            onClick: () => router.push("/library"),
                        }}
                    />
                )}

                {/* Now Playing */}
                {currentTrack && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Now Playing
                        </h2>
                        <Card>
                            <div className="flex items-center gap-4 p-4 bg-[#1a1a1a] border-l-2 border-purple-500">
                                <div className="relative flex-shrink-0">
                                    {currentTrack.album?.coverArt ? (
                                        <img
                                            src={api.getCoverArtUrl(
                                                currentTrack.album.coverArt,
                                                100
                                            )}
                                            alt={currentTrack.album.title}
                                            className="w-16 h-16 rounded-sm"
                                        />
                                    ) : (
                                        <div className="w-16 h-16 bg-[#0a0a0a] rounded-sm flex items-center justify-center">
                                            <Music className="w-6 h-6 text-gray-600" />
                                        </div>
                                    )}
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <Play className="w-6 h-6 text-purple-400 fill-purple-400 animate-pulse" />
                                    </div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-sm font-medium text-purple-400 truncate">
                                        {currentTrack.displayTitle ??
                                            currentTrack.title}
                                    </h3>
                                    <p className="text-sm text-gray-400 truncate">
                                        {currentTrack.artist?.name}
                                    </p>
                                    <p className="text-xs text-gray-500 truncate">
                                        {currentTrack.album?.title}
                                    </p>
                                </div>
                                <div className="text-sm text-gray-500">
                                    {currentTrack.duration
                                        ? `${Math.floor(
                                              currentTrack.duration / 60
                                          )}:${(currentTrack.duration % 60)
                                              .toString()
                                              .padStart(2, "0")}`
                                        : ""}
                                </div>
                            </div>
                        </Card>
                    </section>
                )}

                {/* Next Up */}
                {nextTracks.length > 0 && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Next Up ({nextTracks.length})
                        </h2>
                        <Card>
                            <div className="divide-y divide-[#1c1c1c]">
                                {nextTracks.map((track, idx) => {
                                    const queueIndex = currentIndex + 1 + idx;
                                    return (
                                        <div
                                            key={`${track.id}-${queueIndex}`}
                                            className="flex items-center gap-4 p-4 hover:bg-[#1a1a1a] transition-colors group"
                                        >
                                            {/* Drag Handle */}
                                            <button
                                                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-white cursor-grab active:cursor-grabbing"
                                                title="Drag to reorder"
                                            >
                                                <GripVertical className="w-5 h-5" />
                                            </button>

                                            {/* Album Art */}
                                            <div className="flex-shrink-0">
                                                {track.album?.coverArt ? (
                                                    <img
                                                        src={api.getCoverArtUrl(
                                                            track.album
                                                                .coverArt,
                                                            100
                                                        )}
                                                        alt={track.album.title}
                                                        className="w-12 h-12 rounded-sm"
                                                    />
                                                ) : (
                                                    <div className="w-12 h-12 bg-[#0a0a0a] rounded-sm flex items-center justify-center">
                                                        <Music className="w-5 h-5 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>

                                            {/* Track Info */}
                                            <div className="flex-1 min-w-0">
                                                <h3 className="text-sm font-medium text-white truncate">
                                                    {track.displayTitle ??
                                                        track.title}
                                                </h3>
                                                <p className="text-sm text-gray-400 truncate">
                                                    {track.artist?.name}
                                                </p>
                                            </div>

                                            {/* Duration */}
                                            <div className="text-sm text-gray-500">
                                                {track.duration
                                                    ? `${Math.floor(
                                                          track.duration / 60
                                                      )}:${(track.duration % 60)
                                                          .toString()
                                                          .padStart(2, "0")}`
                                                    : ""}
                                            </div>

                                            {/* Actions */}
                                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() =>
                                                        handleMoveUp(queueIndex)
                                                    }
                                                    disabled={
                                                        queueIndex <=
                                                        currentIndex + 1
                                                    }
                                                    className="p-2 hover:bg-[#0a0a0a] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title="Move up"
                                                >
                                                    <ChevronUp className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        handleMoveDown(
                                                            queueIndex
                                                        )
                                                    }
                                                    disabled={
                                                        queueIndex >=
                                                        queue.length - 1
                                                    }
                                                    className="p-2 hover:bg-[#0a0a0a] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title="Move down"
                                                >
                                                    <ChevronDown className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        handlePlayFromQueue(
                                                            queueIndex
                                                        )
                                                    }
                                                    className="p-2 hover:bg-[#0a0a0a] rounded-md transition-colors"
                                                    title="Play now"
                                                >
                                                    <Play className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        handleRemoveTrack(
                                                            queueIndex
                                                        )
                                                    }
                                                    className="p-2 hover:bg-red-500/10 rounded-md transition-colors text-red-400"
                                                    title="Remove"
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    </section>
                )}

                {/* Previously Played */}
                {previousTracks.length > 0 && (
                    <section className="bg-[#111] rounded-lg p-6">
                        <h2 className="text-xl font-semibold text-white mb-4">
                            Previously Played ({previousTracks.length})
                        </h2>
                        <Card>
                            <div className="divide-y divide-[#1c1c1c]">
                                {previousTracks.map((track, idx) => (
                                    <div
                                        key={`${track.id}-${idx}`}
                                        className="flex items-center gap-4 p-4 hover:bg-[#1a1a1a] transition-colors group opacity-50"
                                    >
                                        {/* Album Art */}
                                        <div className="flex-shrink-0">
                                            {track.album?.coverArt ? (
                                                <img
                                                    src={api.getCoverArtUrl(
                                                        track.album.coverArt,
                                                        100
                                                    )}
                                                    alt={track.album.title}
                                                    className="w-12 h-12 rounded-sm"
                                                />
                                            ) : (
                                                <div className="w-12 h-12 bg-[#0a0a0a] rounded-sm flex items-center justify-center">
                                                    <Music className="w-5 h-5 text-gray-600" />
                                                </div>
                                            )}
                                        </div>

                                        {/* Track Info */}
                                        <div className="flex-1 min-w-0">
                                            <h3 className="text-sm font-medium text-white truncate">
                                                {track.title}
                                            </h3>
                                            <p className="text-sm text-gray-400 truncate">
                                                {track.artist?.name}
                                            </p>
                                        </div>

                                        {/* Duration */}
                                        <div className="text-sm text-gray-500">
                                            {track.duration
                                                ? `${Math.floor(
                                                      track.duration / 60
                                                  )}:${(track.duration % 60)
                                                      .toString()
                                                      .padStart(2, "0")}`
                                                : ""}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </section>
                )}
            </div>
        </div>
    );
}
