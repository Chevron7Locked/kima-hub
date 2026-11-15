"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PlayDisc } from "@/components/ui/MediaActionBar";
import { usePlayRow } from "@/hooks/usePlayRow";
import { queueSource, useQueueFrom } from "@/lib/queue-source";
import type { DiscoverPlaylist } from "../types";

interface DiscoverActionBarProps {
    playlist: DiscoverPlaylist | null;
    onPlayAll: () => void;
    isGenerating: boolean;
    onCancelGeneration?: () => void;
}

export function DiscoverActionBar({
    playlist,
    onPlayAll,
    isGenerating,
    onCancelGeneration,
}: DiscoverActionBarProps) {
    const { isPlaying, playRow } = usePlayRow();
    // Current only while the loaded queue came from this playlist's play button.
    const isPlaylistPlaying = useQueueFrom(queueSource.discover);
    const canPlay = !!playlist && playlist.tracks.length > 0;
    const canCancel = isGenerating && !!onCancelGeneration;
    if (!canPlay && !canCancel) return null;

    const showPause = isPlaylistPlaying && isPlaying;

    return (
        <div className="page-shell pb-6 flex items-center gap-4">
            {canPlay && (
                <PlayDisc
                    showPause={showPause}
                    onClick={() => playRow(isPlaylistPlaying, onPlayAll)}
                    shape="square"
                    disabled={isGenerating}
                    label={showPause ? "pause" : "play discover weekly"}
                />
            )}

            {canCancel && (
                <Button variant="secondary" onClick={onCancelGeneration} className="h-12">
                    <X className="w-4 h-4" />
                    Cancel
                </Button>
            )}
        </div>
    );
}
