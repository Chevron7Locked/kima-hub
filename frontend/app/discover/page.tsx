"use client";

import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAudioState, useAudioPlayback } from "@/lib/audio-context";
import { useDiscoverData } from "@/features/discover/hooks/useDiscoverData";
import { useDiscoverActions } from "@/features/discover/hooks/useDiscoverActions";
import { usePreview } from "@/hooks/usePreview";
import { usePublicConfig } from "@/hooks/useQueries";
import { ACQUIRE_LOCKED } from "@/lib/acquire";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";
import { DiscoverActionBar } from "@/features/discover/components/DiscoverActionBar";
import { TrackList } from "@/features/discover/components/TrackList";
import { UnavailableAlbums } from "@/features/discover/components/UnavailableAlbums";
import { HowItWorks } from "@/features/discover/components/HowItWorks";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { DiscoverSettingsTab } from "@/components/activity/DiscoverSettingsTab";
import { api } from "@/lib/api";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { plural } from "@/lib/format";
import { openActivityPanel, setActivityPanelTab } from "@/hooks/useActivityPanel";

export default function DiscoverWeeklyPage() {
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { setSettingsContent, settingsOwner } = useActivityPanelSettings();
    const queryClient = useQueryClient();
    const { canAcquire } = usePublicConfig();

    // Custom hooks - single source of truth for batch status from useDiscoverData
    const { playlist, config, setConfig, loading, loadError, reloadData, batchStatus, refreshBatchStatus, setPendingGeneration, markGenerationStart, updateTrackLiked, isGenerating } = useDiscoverData();
    const {
        handleGenerate,
        handleLike,
        handlePlayPlaylist,
        handlePlayTrack,
        handleTogglePlay,
    } = useDiscoverActions(playlist, reloadData, isGenerating, refreshBatchStatus, setPendingGeneration, markGenerationStart, updateTrackLiked);
    const preview = usePreview();
    const [retryingUnavailable, setRetryingUnavailable] = useState(false);

    const handleRetryUnavailable = async () => {
        setRetryingUnavailable(true);
        try {
            const result = await api.retryUnavailableAlbums();
            if (result.success && result.queued > 0) {
                openActivityPanel("active");
                refreshBatchStatus();
                setTimeout(() => reloadData(), 15000);
            } else {
                notify.info("No albums to retry", { message: result.message });
            }
        } catch (error) {
            console.error("Failed to retry unavailable albums:", error);
            if ((error as { status?: number })?.status === 409) {
                notify.error("A discovery batch is already in progress");
            } else {
                notify.error("Failed to retry unavailable albums");
            }
        } finally {
            setRetryingUnavailable(false);
        }
    };

    const isPlaylistPlaying = playlist?.tracks.some(
        (t) => t.id === currentTrack?.id
    );

    // Build discover settings element (stable across renders via the effect dep array)
    const discoverSettingsRef = useRef<React.ReactNode>(null);
    const settingsOwnerRef = useRef(settingsOwner);
    settingsOwnerRef.current = settingsOwner;

    useEffect(() => {
        const handleBackToActivity = () => {
            setActivityPanelTab("active");
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
        openActivityPanel("settings");
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
            console.error('Backend cancel failed:', error);
        }
    };

    // Map real backend status values to human-readable phase labels
    const getProgressLabel = () => {
        if (!batchStatus?.active) return null;
        if (batchStatus.status === "scanning") {
            return "Finding artists…";
        }
        if (batchStatus.status === "downloading") {
            const completed = batchStatus.completed ?? 0;
            const total = batchStatus.total ?? 0;
            return total > 0
                ? `Downloading albums (${completed} / ${total})…`
                : "Downloading albums…";
        }
        return "Working…";
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen gap-4">
                <p className="text-sm text-[var(--text-muted)]">Could not load discovery data.</p>
                <Button
                    variant="secondary"
                    onClick={reloadData}
                >
                    <RefreshCw className="w-4 h-4" />
                    Retry
                </Button>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
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

                <div className="page-shell pb-32">
                    {playlist && playlist.tracks.length > 0 ? (
                            <div className="section-stack">
                                <section>
                                    <SectionHeader type="track" title="Playlist" count={plural(playlist?.totalCount || 0, "track")} className="mb-4" />
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
                                        currentPreview={preview.previewId}
                                        onTogglePreview={(albumId, artistName, title) =>
                                            preview.toggle(albumId, api.getTrackPreviewStreamUrl(artistName, title))
                                        }
                                        onRetryAll={canAcquire ? handleRetryUnavailable : undefined}
                                        isRetrying={retryingUnavailable}
                                    />
                                </section>

                                <section>
                                    <HowItWorks />
                                </section>
                            </div>
                        ) : (
                            <div className="max-w-3xl mx-auto py-16">
                                <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-12">
                                    <div className="absolute top-0 left-0 w-1 h-full bg-brand" />

                                    <div className="flex items-center gap-3 mb-8 pb-4 border-b border-white/10">
                                        <div className="w-2 h-2 bg-[var(--color-brand)]" />
                                        <span className="text-xs tabular-nums text-[var(--text-secondary)]">
                                            {isGenerating ? "Generating" : "Ready"}
                                        </span>
                                    </div>

                                    <h3 className="text-4xl md:text-5xl font-bold tracking-tight text-white mb-4 leading-none">
                                        This week&apos;s<br/>
                                        <span className="text-[var(--color-brand)]">playlist</span>
                                    </h3>

                                    <p className="text-sm text-[var(--text-muted)] mb-6 leading-relaxed">
                                        Kima finds artists similar to ones you already love, picks a representative track
                                        from each, then builds your weekly playlist.
                                    </p>

                                    {/* What this does -- disk disclosure, visible before generating */}
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02]">
                                            <div className="text-xs text-[var(--text-muted)] mb-1">Finds</div>
                                            <div className="text-xs text-[var(--text-secondary)] leading-snug">Similar artists via ListenBrainz + local similarity, grouped by similarity tier</div>
                                        </div>
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02]">
                                            <div className="text-xs text-[var(--text-muted)] mb-1">Downloads</div>
                                            <div className="text-xs text-[var(--text-secondary)] leading-snug">Full albums to <span className="text-[var(--text-muted)]">/music/discovery</span> on your server</div>
                                        </div>
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02]">
                                            <div className="text-xs text-[var(--text-muted)] mb-1">Cleans up</div>
                                            <div className="text-xs text-[var(--text-secondary)] leading-snug">Unliked albums are removed at week&apos;s end -- liked ones stay forever</div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-3 gap-4 mb-8">
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                                            <div className="text-2xl font-bold text-white mb-1">--</div>
                                            <div className="text-xs text-[var(--text-muted)]">Tracks</div>
                                        </div>
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                                            <div className="text-2xl font-bold text-white mb-1">--</div>
                                            <div className="text-xs text-[var(--text-muted)]">Duration</div>
                                        </div>
                                        <div className="border border-white/10 rounded-lg p-4 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                                            <div className="text-2xl font-bold text-white mb-1">--</div>
                                            <div className="text-xs text-[var(--text-muted)]">Artists</div>
                                        </div>
                                    </div>

                                    {canAcquire ? (
                                        <button
                                            onClick={handleGenerate}
                                            disabled={isGenerating}
                                            aria-label={isGenerating ? "Playlist generation in progress" : "Build this week's playlist"}
                                            className={cn(
                                                "w-full py-4 px-6 border-2 rounded-lg font-bold text-sm transition-all duration-300 min-h-[52px] focus-visible:outline-2 focus-visible:outline-[var(--color-brand)] focus-visible:outline-offset-2",
                                                isGenerating
                                                    ? "border-white/20 bg-white/5 text-[var(--text-muted)] cursor-not-allowed"
                                                    : "border-[var(--color-brand)] bg-[var(--color-brand)] text-black hover:bg-[var(--color-brand-hover)] hover:border-[var(--color-brand-hover)] hover:scale-[1.02]"
                                            )}
                                        >
                                            {isGenerating ? (
                                                <span className="flex items-center justify-center gap-3">
                                                    <GradientSpinner size="sm" />
                                                    {getProgressLabel()}
                                                </span>
                                            ) : (
                                                <span className="flex items-center justify-center gap-3">
                                                    <RefreshCw className="w-4 h-4" />
                                                    Build This Week&apos;s Playlist
                                                </span>
                                            )}
                                        </button>
                                    ) : (
                                        <p className="text-sm text-[var(--text-muted)]">
                                            Building this playlist downloads albums: {ACQUIRE_LOCKED}.
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                </div>
            </div>
        </div>
    );
}
