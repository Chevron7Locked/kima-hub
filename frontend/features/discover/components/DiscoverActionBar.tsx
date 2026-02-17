"use client";

import { Play, Pause, X } from "lucide-react";
import { cn } from "@/utils/cn";
import type { DiscoverPlaylist } from "../types";

interface DiscoverActionBarProps {
    playlist: DiscoverPlaylist | null;
    isPlaylistPlaying: boolean;
    isPlaying: boolean;
    onPlayToggle: () => void;
    isGenerating: boolean;
    onCancelGeneration?: () => void;
}

export function DiscoverActionBar({
    playlist,
    isPlaylistPlaying,
    isPlaying,
    onPlayToggle,
    isGenerating,
    onCancelGeneration,
}: DiscoverActionBarProps) {
    return (
        <div className=" px-6 md:px-8 py-6">
            <div className="max-w-[1600px] mx-auto flex items-center gap-4">
                {/* Play Button */}
                {playlist && playlist.tracks.length > 0 && (
                    <button
                        onClick={onPlayToggle}
                        disabled={isGenerating}
                        className={cn(
                            "h-12 w-12 flex items-center justify-center border-2 rounded-lg transition-all duration-300",
                            isGenerating ?
                                "border-white/20 bg-white/5 cursor-not-allowed opacity-50"
                            :   "border-[#eab308] bg-[#eab308] hover:bg-[#f59e0b] hover:border-[#f59e0b] hover:scale-110 hover:shadow-lg hover:shadow-[#eab308]/20",
                        )}
                    >
                        {isPlaylistPlaying && isPlaying ?
                            <Pause className="w-5 h-5 fill-current text-black" />
                        :   <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                        }
                    </button>
                )}

                {/* Cancel Generation Button */}
                {isGenerating && onCancelGeneration && (
                    <button
                        onClick={onCancelGeneration}
                        className="h-12 px-4 flex items-center gap-2 border-2 border-red-500/30 hover:border-red-500 hover:bg-red-500/10 text-red-400 rounded-lg transition-all duration-300 text-sm font-black uppercase tracking-wider"
                    >
                        <X className="w-4 h-4" />
                        Cancel
                    </button>
                )}
            </div>
        </div>
    );
}
