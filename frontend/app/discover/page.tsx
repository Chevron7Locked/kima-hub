"use client";

import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useToast } from "@/lib/toast-context";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAudioState, useAudioPlayback } from "@/lib/audio-context";
import { useDiscoverData } from "@/features/discover/hooks/useDiscoverData";
import { useDiscoverActions } from "@/features/discover/hooks/useDiscoverActions";
import { usePreviewPlayer } from "@/features/discover/hooks/usePreviewPlayer";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";
import { DiscoverActionBar } from "@/features/discover/components/DiscoverActionBar";
import { TrackList } from "@/features/discover/components/TrackList";
import { UnavailableAlbums } from "@/features/discover/components/UnavailableAlbums";
import { HowItWorks } from "@/features/discover/components/HowItWorks";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { DiscoverSettingsTab } from "@/components/activity/DiscoverSettingsTab";
import { api } from "@/lib/api";

export default function DiscoverWeeklyPage() {
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { setSettingsContent, settingsOwner } = useActivityPanelSettings();
    const queryClient = useQueryClient();

    // Custom hooks - single source of truth for batch status from useDiscoverData
    const { playlist, config, setConfig, loading, reloadData, batchStatus, refreshBatchStatus, setPendingGeneration, markGenerationStart, updateTrackLiked, isGenerating } = useDiscoverData();
    const {
        handleGenerate,
        handleLike,
        handlePlayPlaylist,
        handlePlayTrack,
        handleTogglePlay,
    } = useDiscoverActions(playlist, reloadData, isGenerating, refreshBatchStatus, setPendingGeneration, markGenerationStart, updateTrackLiked);
    const { currentPreview, handleTogglePreview } = usePreviewPlayer();
    const [retryingUnavailable, setRetryingUnavailable] = useState(false);
    const { toast } = useToast();

    const handleRetryUnavailable = async () => {
        setRetryingUnavailable(true);
        try {
            const result = await api.retryUnavailableAlbums();
            if (result.success && result.queued > 0) {
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                toast.success(`Retrying ${result.queued} albums`);
                refreshBatchStatus();
                setTimeout(() => reloadData(), 15000);
            } else {
                toast.info(result.message || "No albums to retry");
            }
        } catch (error) {
            console.error("Failed to retry unavailable albums:", error);
            if ((error as { status?: number })?.status === 409) {
                toast.error("A discovery batch is already in progress");
            } else {
                toast.error("Failed to retry unavailable albums");
            }
        } finally {
            setRetryingUnavailable(false);
        }
    };

    // Check if we're playing from this playlist
    const isPlaylistPlaying = playlist?.tracks.some(
        (t) => t.id === currentTrack?.id
    );

    // Build discover settings element (stable across renders via the effect dep array)
    const discoverSettingsRef = useRef<React.ReactNode>(null);
    const settingsOwnerRef = useRef(settingsOwner);
    settingsOwnerRef.current = settingsOwner;

    useEffect(() => {
        const handleBackToActivity = () => {
            window.dispatchEvent(
                new CustomEvent("set-activity-panel-tab", {
                    detail: { tab: "active" },
                })
            );
        };

        const handlePlaylistCleared = async () => {
            setPendingGeneration(false);
            await refreshBatchStatus();
            await reloadData();
        };

        const element = (
            <DiscoverSettingsTab
                config={config}
                onUpdateConfig={setConfig}
                onPlaylistCleared={handlePlaylistCleared}
                onBack={handleBackToActivity}
            />
        );

        discoverSettingsRef.current = element;

        // Auto-set on mount/update only if lyrics isn't active
        if (settingsOwnerRef.current !== "lyrics") {
            setSettingsContent(element, "discover");
        }

        return () => {
            setSettingsContent(null);
        };
    }, [config, setConfig, reloadData, refreshBatchStatus, setPendingGeneration, setSettingsContent]);

    // Handle settings button click - user actively wants discover settings, overrides lyrics
    const handleOpenSettings = () => {
        if (discoverSettingsRef.current) {
            setSettingsContent(discoverSettingsRef.current, "discover");
        }
        window.dispatchEvent(new CustomEvent("open-activity-panel"));
        window.dispatchEvent(
            new CustomEvent("set-activity-panel-tab", {
                detail: { tab: "settings" },
            })
        );
    };

    // Handle cancel generation - cancels stuck backend batch and clears frontend state
    const handleCancelGeneration = async () => {
        setPendingGeneration(false);
        queryClient.setQueryData(["discover-batch-status"], {
            active: false,
            status: null,
            batchId: null
        });

        try {
            await api.cancelDiscoverBatch();
        } catch (error) {
            console.error('[DiscoverWeekly] Backend cancel failed:', error);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <div className="min-h-screen relative">
            {/* Static gradient overlay - no animation */}
            <div className="fixed inset-0 pointer-events-none opacity-50">
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-transparent" />
            </div>

            <div className="relative">
                <DiscoverHero
                    playlist={playlist}
                    config={config}
                    onOpenSettings={handleOpenSettings}
                />

                <DiscoverActionBar
                    playlist={playlist}
                    isPlaylistPlaying={isPlaylistPlaying || false}
                    isPlaying={isPlaying}
                    onPlayToggle={isPlaylistPlaying && isPlaying ? handleTogglePlay : handlePlayPlaylist}
                    isGenerating={isGenerating}
                    onCancelGeneration={handleCancelGeneration}
                />

                {/* Track Listing */}
                <div className="px-4 md:px-8 pb-32">
                    {playlist && playlist.tracks.length > 0 ? (
                            <div className="space-y-8">
                                {/* Section header */}
                                <section>
                                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-4">
                                        <span className="w-1 h-8 bg-gradient-to-b from-[#eab308] to-[#f59e0b] rounded-full" />
                                        <span className="uppercase tracking-tighter">Playlist</span>
                                        <span className="flex-1 border-t border-white/10" />
                                        <span className="text-xs font-mono text-[#a855f7]">
                                            {playlist?.totalCount || 0} tracks
                                        </span>
                                    </h2>
                                    <TrackList
                                        tracks={playlist.tracks}
                                        currentTrack={currentTrack}
                                        isPlaying={isPlaying}
                                        onPlayTrack={handlePlayTrack}
                                        onTogglePlay={handleTogglePlay}
                                        onLike={handleLike}
                                    />
                                </section>

                                <section>
                                    <UnavailableAlbums
                                        unavailable={playlist.unavailable}
                                        currentPreview={currentPreview}
                                        onTogglePreview={handleTogglePreview}
                                        onRetryAll={handleRetryUnavailable}
                                        isRetrying={retryingUnavailable}
                                    />
                                </section>

                                <section>
                                    <HowItWorks />
                                </section>
                            </div>
                        ) : (
                            <div className="max-w-3xl mx-auto py-16">
                                {/* Data-driven empty state */}
                                <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-12 shadow-2xl shadow-black/40">
                                    {/* Accent line */}
                                    <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-[#eab308] to-[#f59e0b]" />

                                    {/* System status */}
                                    <div className="flex items-center gap-3 mb-8 pb-4 border-b border-white/10">
                                        <div className="w-2 h-2 bg-[#eab308]" />
                                        <span className="text-xs font-mono text-white/60 uppercase tracking-wider">
                                            System Ready
                                        </span>
                                    </div>

                                    <h3 className="text-4xl md:text-5xl font-black tracking-tighter text-white mb-4 leading-none">
                                        PLAYLIST<br/>
                                        GENERATION
                                    </h3>

                                    <p className="text-sm font-mono text-gray-500 mb-8 leading-relaxed">
                                        No active playlist detected. Initialize generation process to analyze listening history
                                        and create personalized recommendations.
                                    </p>

                                    {/* Stats grid */}
                                    <div className="grid grid-cols-3 gap-4 mb-8">
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                                            <div className="text-2xl font-black text-[#a855f7] mb-1">--</div>
                                            <div className="text-xs font-mono text-gray-500 uppercase">Tracks</div>
                                        </div>
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                                            <div className="text-2xl font-black text-[#a855f7] mb-1">--</div>
                                            <div className="text-xs font-mono text-gray-500 uppercase">Duration</div>
                                        </div>
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                                            <div className="text-2xl font-black text-[#a855f7] mb-1">--</div>
                                            <div className="text-xs font-mono text-gray-500 uppercase">Artists</div>
                                        </div>
                                    </div>

                                    <button
                                        onClick={handleGenerate}
                                        disabled={isGenerating}
                                        className={cn(
                                            "w-full py-4 px-6 border-2 rounded-lg font-black text-sm tracking-wider uppercase transition-all duration-300",
                                            isGenerating
                                                ? "border-white/20 bg-white/5 text-white/30 cursor-not-allowed"
                                                : "border-[#eab308] bg-[#eab308] text-black hover:bg-[#f59e0b] hover:border-[#f59e0b] hover:scale-[1.02] hover:shadow-lg hover:shadow-[#eab308]/20"
                                        )}
                                    >
                                        {isGenerating ? (
                                            <span className="flex items-center justify-center gap-3">
                                                <GradientSpinner size="sm" />
                                                {batchStatus?.status === "scanning"
                                                    ? "Processing..."
                                                    : `Downloading ${batchStatus?.completed || 0}/${batchStatus?.total || 0}`
                                                }
                                            </span>
                                        ) : (
                                            <span className="flex items-center justify-center gap-3">
                                                <RefreshCw className="w-4 h-4" />
                                                Initialize Generation
                                            </span>
                                        )}
                                    </button>
                                </div>
                            </div>
                        )}
                </div>
            </div>
        </div>
    );
}
