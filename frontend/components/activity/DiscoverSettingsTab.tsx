"use client";

import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { Trash2, Loader2, ArrowLeft } from "lucide-react";
import type { DiscoverConfig } from "@/features/discover/types";

interface DiscoverSettingsTabProps {
    config: DiscoverConfig | null;
    onUpdateConfig: (updatedConfig: DiscoverConfig | null) => void;
    onPlaylistCleared?: () => void;
    onBack: () => void;
}

export function DiscoverSettingsTab({
    config,
    onUpdateConfig,
    onPlaylistCleared,
    onBack,
}: DiscoverSettingsTabProps) {
    const { toast } = useToast();
    const [isClearing, setIsClearing] = useState(false);
    const debounceRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    // Generic handler for config changes with debounce
    function handleConfigChange<K extends keyof DiscoverConfig>(
        key: K,
        value: DiscoverConfig[K]
    ) {
        // Update local state immediately for responsive UI
        if (config) {
            onUpdateConfig({ ...config, [key]: value });
        }

        // Debounce the API call
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(async () => {
            try {
                await api.updateDiscoverConfig({ [key]: value });
            } catch {
                toast.error("Failed to save setting");
            }
        }, 500);
    }

    async function handleClearPlaylist() {
        if (isClearing) return;

        const confirmed = window.confirm(
            "Clear Discovery Playlist?\n\n" +
                "• Liked albums will be moved to your library\n" +
                "• Non-liked albums will be deleted\n\n" +
                "This action cannot be undone."
        );

        if (!confirmed) return;

        setIsClearing(true);
        try {
            const result = await api.clearDiscoverPlaylist();

            if (result.likedMoved > 0 && result.activeDeleted > 0) {
                toast.success(
                    `Moved ${result.likedMoved} liked album${result.likedMoved !== 1 ? "s" : ""} to library, deleted ${result.activeDeleted} album${result.activeDeleted !== 1 ? "s" : ""}`
                );
            } else if (result.likedMoved > 0) {
                toast.success(
                    `Moved ${result.likedMoved} liked album${result.likedMoved !== 1 ? "s" : ""} to library`
                );
            } else if (result.activeDeleted > 0) {
                toast.success(
                    `Deleted ${result.activeDeleted} album${result.activeDeleted !== 1 ? "s" : ""}`
                );
            } else {
                toast.info("No albums to clear");
            }

            onPlaylistCleared?.();
        } catch {
            toast.error("Failed to clear playlist");
        } finally {
            setIsClearing(false);
        }
    }

    return (
        <div className="h-full flex flex-col bg-[#0a0a0a]">
            {/* Header with back button */}
            <div className="flex items-center gap-3 px-5 py-4 border-b-2 border-white/20">
                <button
                    onClick={onBack}
                    className="border border-white/20 p-2 hover:border-[#a855f7] hover:bg-white/5 transition-colors"
                    title="Back to activity"
                >
                    <ArrowLeft className="w-4 h-4 text-white/60" />
                </button>
                <h3 className="text-sm font-black uppercase tracking-wider text-white">Settings</h3>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-8">
                {/* Playlist Size */}
                <div>
                    <label className="block text-xs font-mono text-gray-500 uppercase tracking-wider mb-4">
                        Playlist Size
                    </label>
                    <div className="border border-white/10 p-4 mb-3">
                        <div className="flex items-baseline justify-between">
                            <span className="text-4xl font-black text-[#a855f7] font-mono">
                                {config?.playlistSize || 10}
                            </span>
                            <span className="text-xs font-mono text-gray-500 uppercase">
                                tracks
                            </span>
                        </div>
                    </div>
                    <input
                        type="range"
                        min="5"
                        max="50"
                        step="5"
                        value={config?.playlistSize || 10}
                        onChange={(e) =>
                            handleConfigChange("playlistSize", parseInt(e.target.value))
                        }
                        className="w-full h-1 bg-white/10 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-[#a855f7] [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white/20 hover:[&::-webkit-slider-thumb]:bg-white"
                    />
                    <p className="text-xs font-mono text-gray-500 mt-3">
                        One track per album / Larger = more discovery
                    </p>
                </div>

                {/* Download Buffer */}
                <div>
                    <label className="block text-xs font-mono text-gray-500 uppercase tracking-wider mb-4">
                        Download Buffer
                    </label>
                    <div className="border border-white/10 p-4 mb-3">
                        <div className="flex items-baseline justify-between">
                            <span className="text-4xl font-black text-[#a855f7] font-mono">
                                {((config?.downloadRatio ?? 1.3) * 100 - 100).toFixed(0)}%
                            </span>
                            <span className="text-xs font-mono text-gray-500 uppercase">
                                extra
                            </span>
                        </div>
                    </div>
                    <input
                        type="range"
                        min="1.0"
                        max="2.0"
                        step="0.1"
                        value={config?.downloadRatio ?? 1.3}
                        onChange={(e) =>
                            handleConfigChange("downloadRatio", parseFloat(e.target.value))
                        }
                        className="w-full h-1 bg-white/10 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-[#a855f7] [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white/20 hover:[&::-webkit-slider-thumb]:bg-white"
                    />
                    <p className="text-xs font-mono text-gray-500 mt-3">
                        Redundancy for failed downloads / Higher = more reliable
                    </p>
                </div>

                {/* Album Exclusion */}
                <div>
                    <label className="block text-xs font-mono text-gray-500 uppercase tracking-wider mb-4">
                        Album Exclusion
                    </label>
                    <div className="border border-white/10 p-4 mb-3">
                        <div className="flex items-baseline justify-between">
                            <span className="text-4xl font-black text-[#a855f7] font-mono">
                                {(config?.exclusionMonths ?? 6) === 0
                                    ? "--"
                                    : config?.exclusionMonths ?? 6}
                            </span>
                            {(config?.exclusionMonths ?? 6) !== 0 && (
                                <span className="text-xs font-mono text-gray-500 uppercase">
                                    months
                                </span>
                            )}
                        </div>
                    </div>
                    <input
                        type="range"
                        min="0"
                        max="12"
                        step="1"
                        value={config?.exclusionMonths ?? 6}
                        onChange={(e) =>
                            handleConfigChange("exclusionMonths", parseInt(e.target.value))
                        }
                        className="w-full h-1 bg-white/10 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-[#a855f7] [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white/20 hover:[&::-webkit-slider-thumb]:bg-white"
                    />
                    <p className="text-xs font-mono text-gray-500 mt-3">
                        Cooldown period for repeat recommendations / 0 = disabled
                    </p>
                </div>

                {/* Clear Playlist */}
                <div className="pt-6 border-t-2 border-white/20">
                    <label className="block text-xs font-mono text-gray-500 uppercase tracking-wider mb-4">
                        Danger Zone
                    </label>
                    <p className="text-xs font-mono text-gray-500 mb-4 leading-relaxed">
                        Remove current playlist / Liked albums → library / Others → deleted
                    </p>
                    <button
                        onClick={handleClearPlaylist}
                        disabled={isClearing}
                        className="w-full flex items-center justify-center gap-3 px-4 py-3 border-2 border-red-500/30 hover:border-red-500 hover:bg-red-500/10 text-red-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed font-black text-xs uppercase tracking-wider"
                    >
                        {isClearing ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Processing
                            </>
                        ) : (
                            <>
                                <Trash2 className="w-4 h-4" />
                                Clear Playlist
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
