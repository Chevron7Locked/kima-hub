"use client";

import { useState, useEffect, useRef } from "react";
import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { enrichmentApi } from "@/lib/enrichmentApi";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import {
    CheckCircle,
    Loader2,
    User,
    Heart,
    Activity,
    Pause,
    Play,
    StopCircle,
    AlertTriangle,
} from "lucide-react";
import { EnrichmentFailuresModal } from "@/components/EnrichmentFailuresModal";

interface CacheSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

// Progress bar component
function ProgressBar({
    progress,
    color = "bg-[#ecb200]",
    showPercentage = true,
}: {
    progress: number;
    color?: string;
    showPercentage?: boolean;
}) {
    return (
        <div className="flex items-center gap-2 flex-1">
            <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                    className={`h-full ${color} transition-all duration-500 ease-out`}
                    style={{ width: `${Math.min(100, progress)}%` }}
                />
            </div>
            {showPercentage && (
                <span className="text-xs text-white/50 w-10 text-right">
                    {progress}%
                </span>
            )}
        </div>
    );
}

// Enrichment stage component
function EnrichmentStage({
    icon: Icon,
    label,
    description,
    completed,
    total,
    progress,
    isBackground = false,
    failed = 0,
    processing = 0,
}: {
    icon: React.ElementType;
    label: string;
    description: string;
    completed: number;
    total: number;
    progress: number;
    isBackground?: boolean;
    failed?: number;
    processing?: number;
}) {
    const isComplete = progress === 100;
    const hasActivity = processing > 0;

    return (
        <div className="flex items-start gap-3 py-2">
            <div
                className={`mt-0.5 p-1.5 rounded-lg ${
                    isComplete ? "bg-green-500/20" : "bg-white/5"
                }`}
            >
                {isComplete ? (
                    <CheckCircle className="w-4 h-4 text-green-400" />
                ) : hasActivity ? (
                    <Loader2 className="w-4 h-4 text-[#ecb200] animate-spin" />
                ) : (
                    <Icon className="w-4 h-4 text-white/40" />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">
                        {label}
                    </span>
                    {isBackground && !isComplete && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">
                            background
                        </span>
                    )}
                </div>
                <p className="text-xs text-white/40 mt-0.5">{description}</p>
                <div className="flex items-center gap-2 mt-2">
                    <ProgressBar
                        progress={progress}
                        color={
                            isComplete
                                ? "bg-green-500"
                                : isBackground
                                ? "bg-purple-500"
                                : "bg-[#ecb200]"
                        }
                    />
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-white/30">
                    <span>
                        {completed} / {total}
                    </span>
                    {processing > 0 && (
                        <span className="text-[#ecb200]">
                            {processing} processing
                        </span>
                    )}
                    {failed > 0 && (
                        <span className="text-red-400">{failed} failed</span>
                    )}
                </div>
            </div>
        </div>
    );
}

export function CacheSection({ settings, onUpdate }: CacheSectionProps) {
    const [syncing, setSyncing] = useState(false);
    const [clearingCaches, setClearingCaches] = useState(false);
    const [reEnriching, setReEnriching] = useState(false);
    const [cleaningStaleJobs, setCleaningStaleJobs] = useState(false);
    const [cleanupResult, setCleanupResult] = useState<{
        totalCleaned: number;
        cleaned: {
            discoveryBatches: { cleaned: number };
            downloadJobs: { cleaned: number };
            spotifyImportJobs: { cleaned: number };
            bullQueues: { cleaned: number };
        };
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showFailuresModal, setShowFailuresModal] = useState(false);
    const queryClient = useQueryClient();
    const syncStartTimeRef = useRef<number>(0);

    // Check URL hash for auto-opening failures modal
    useEffect(() => {
        if (window.location.hash === "#enrichment-failures") {
            setShowFailuresModal(true);
        }
    }, []);

    // Fetch enrichment progress
    const { data: enrichmentProgress, refetch: refetchProgress } = useQuery({
        queryKey: ["enrichment-progress"],
        queryFn: () => api.getEnrichmentProgress(),
        refetchInterval: 5000, // Refresh every 5 seconds
        staleTime: 2000,
    });

    // Fetch enrichment state
    const { data: enrichmentState } = useQuery({
        queryKey: ["enrichment-status"],
        queryFn: () => enrichmentApi.getStatus(),
        refetchInterval: 3000,
        staleTime: 1000,
    });

    // Fetch failure counts
    const { data: failureCounts } = useQuery({
        queryKey: ["enrichment-failure-counts"],
        queryFn: () => enrichmentApi.getFailureCounts(),
        refetchInterval: 10000,
    });

    // Fetch concurrency config
    const { data: concurrencyConfig, isLoading: isConcurrencyLoading } =
        useQuery({
            queryKey: ["enrichment-concurrency"],
            queryFn: () => enrichmentApi.getConcurrency(),
            staleTime: 0,
        });

    // Fetch audio analyzer workers config
    const { data: workersConfig, isLoading: isWorkersLoading } = useQuery({
        queryKey: ["analysis-workers"],
        queryFn: () => enrichmentApi.getAnalysisWorkers(),
        staleTime: 0,
    });

    // Update concurrency mutation with optimistic updates
    // Note: We do NOT invalidate on onSettled because the optimistic update
    // already provides the correct UI state. Invalidating causes a race condition
    // where the refetch returns stale data before the server update completes,
    // causing the slider to "bounce" between values.
    const setConcurrencyMutation = useMutation({
        mutationFn: (concurrency: number) =>
            enrichmentApi.setConcurrency(concurrency),
        onMutate: async (newConcurrency) => {
            // Cancel outgoing refetches
            await queryClient.cancelQueries({
                queryKey: ["enrichment-concurrency"],
            });

            // Snapshot previous value
            const previousConcurrency = queryClient.getQueryData([
                "enrichment-concurrency",
            ]);

            // Optimistically update to new value
            queryClient.setQueryData(["enrichment-concurrency"], {
                concurrency: newConcurrency,
                artistsPerMin: newConcurrency * 6, // Approximate estimate
            });

            return { previousConcurrency };
        },
        onError: (err, newConcurrency, context) => {
            // Rollback on error
            queryClient.setQueryData(
                ["enrichment-concurrency"],
                context?.previousConcurrency
            );
        },
        // Removed onSettled invalidation - optimistic update handles UI,
        // and the query will refetch naturally based on staleTime
    });

    // Update audio analyzer workers mutation with optimistic updates
    const setAnalysisWorkersMutation = useMutation({
        mutationFn: (workers: number) =>
            enrichmentApi.setAnalysisWorkers(workers),
        onMutate: async (newWorkers) => {
            await queryClient.cancelQueries({
                queryKey: ["analysis-workers"],
            });

            const previousWorkers = queryClient.getQueryData([
                "analysis-workers",
            ]);

            queryClient.setQueryData(["analysis-workers"], {
                workers: newWorkers,
                cpuCores: workersConfig?.cpuCores || 4,
                recommended: workersConfig?.recommended || 2,
                description: `Using ${newWorkers} of ${workersConfig?.cpuCores || 4} available CPU cores`,
            });

            return { previousWorkers };
        },
        onError: (err, newWorkers, context) => {
            queryClient.setQueryData(
                ["analysis-workers"],
                context?.previousWorkers
            );
        },
    });

    // Use query data directly instead of local state
    const enrichmentSpeed = concurrencyConfig?.concurrency ?? 1;

    // Poll enrichment status when syncing to detect completion
    useEffect(() => {
        if (!syncing) return;

        const maxPollDuration = 5 * 60 * 1000; // 5 minutes max
        const pollInterval = 2000; // Check every 2 seconds

        const startTime = syncStartTimeRef.current;

        const checkStatus = async () => {
            try {
                const status = await enrichmentApi.getStatus();
                const elapsed = Date.now() - startTime;

                // Stop polling if idle or max duration exceeded
                if (status?.status === "idle" || elapsed > maxPollDuration) {
                    setSyncing(false);
                    refetchProgress();
                }
            } catch (err) {
                console.error("Failed to check enrichment status:", err);
            }
        };

        const intervalId = setInterval(checkStatus, pollInterval);

        return () => clearInterval(intervalId);
    }, [syncing, refetchProgress]);

    const refreshNotifications = () => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({
            queryKey: ["unread-notification-count"],
        });
        window.dispatchEvent(new CustomEvent("notifications-changed"));
    };

    const handleSyncAndEnrich = async () => {
        setSyncing(true);
        syncStartTimeRef.current = Date.now();
        setError(null);
        try {
            // Always sync audiobooks if Audiobookshelf is enabled (independent of enrichment setting)
            if (settings.audiobookshelfEnabled) {
                await api.post("/audiobooks/sync", {});
            }
            await api.post("/podcasts/sync-covers", {});
            // Use the new fast incremental sync endpoint
            await api.syncLibraryEnrichment();
            refreshNotifications();
            refetchProgress();
            // Don't set syncing to false here - let the polling effect handle it
        } catch (err) {
            console.error("Sync error:", err);
            setError("Failed to sync");
            setSyncing(false); // Only stop on error
        }
    };

    const handleFullEnrichment = async () => {
        setReEnriching(true);
        setError(null);
        try {
            await api.triggerFullEnrichment();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Full enrichment error:", err);
            setError("Failed to start full enrichment");
        } finally {
            setReEnriching(false);
        }
    };

    const handleClearCaches = async () => {
        setClearingCaches(true);
        setError(null);
        try {
            await api.clearAllCaches();
            refreshNotifications();
        } catch (err) {
            setError("Failed to clear caches");
        } finally {
            setClearingCaches(false);
        }
    };

    const handleCleanupStaleJobs = async () => {
        setCleaningStaleJobs(true);
        setCleanupResult(null);
        setError(null);
        try {
            const result = await api.cleanupStaleJobs();
            setCleanupResult(result);
            refreshNotifications();
        } catch (err) {
            console.error("Stale job cleanup error:", err);
            setError("Failed to cleanup stale jobs");
        } finally {
            setCleaningStaleJobs(false);
        }
    };

    const handlePause = async () => {
        try {
            await enrichmentApi.pause();
            queryClient.invalidateQueries({ queryKey: ["enrichment-status"] });
        } catch (err) {
            console.error("Pause error:", err);
            setError("Failed to pause enrichment");
        }
    };

    const handleResume = async () => {
        try {
            await enrichmentApi.resume();
            queryClient.invalidateQueries({ queryKey: ["enrichment-status"] });
        } catch (err) {
            console.error("Resume error:", err);
            setError("Failed to resume enrichment");
        }
    };

    const handleStop = async () => {
        try {
            await enrichmentApi.stop();
            queryClient.invalidateQueries({ queryKey: ["enrichment-status"] });
            queryClient.invalidateQueries({
                queryKey: ["enrichment-progress"],
            });
        } catch (err) {
            console.error("Stop error:", err);
            setError("Failed to stop enrichment");
        }
    };

    const isEnrichmentActive =
        enrichmentState?.status === "running" ||
        enrichmentState?.status === "paused";
    const totalFailures = failureCounts?.total || 0;

    return (
        <>
            <SettingsSection id="cache" title="Cache & Automation">
                {/* Enrichment Progress */}
                {enrichmentProgress && (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-medium text-white">
                                Library Enrichment
                            </h3>
                            {enrichmentProgress.coreComplete &&
                                !enrichmentProgress.isFullyComplete && (
                                    <span className="text-xs text-purple-400 flex items-center gap-1">
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        Audio analysis running
                                    </span>
                                )}
                            {enrichmentProgress.isFullyComplete && (
                                <span className="text-xs text-green-400 flex items-center gap-1">
                                    <CheckCircle className="w-3 h-3" />
                                    Complete
                                </span>
                            )}
                        </div>

                        <div className="space-y-1">
                            <EnrichmentStage
                                icon={User}
                                label="Artist Metadata"
                                description="Bios, images, and similar artists from Last.fm"
                                completed={enrichmentProgress.artists.completed}
                                total={enrichmentProgress.artists.total}
                                progress={enrichmentProgress.artists.progress}
                                failed={enrichmentProgress.artists.failed}
                            />

                            <EnrichmentStage
                                icon={Heart}
                                label="Mood Tags"
                                description="Vibes and mood data from Last.fm"
                                completed={
                                    enrichmentProgress.trackTags.enriched
                                }
                                total={enrichmentProgress.trackTags.total}
                                progress={enrichmentProgress.trackTags.progress}
                            />

                            <EnrichmentStage
                                icon={Activity}
                                label="Audio Analysis"
                                description="BPM, key, energy, and danceability from audio files"
                                completed={
                                    enrichmentProgress.audioAnalysis.completed
                                }
                                total={enrichmentProgress.audioAnalysis.total}
                                progress={
                                    enrichmentProgress.audioAnalysis.progress
                                }
                                processing={
                                    enrichmentProgress.audioAnalysis.processing
                                }
                                failed={enrichmentProgress.audioAnalysis.failed}
                                isBackground={true}
                            />
                        </div>

                        {/* Control Buttons */}
                        <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-white/10">
                            {/* Main Actions */}
                            <button
                                onClick={handleSyncAndEnrich}
                                disabled={
                                    syncing || reEnriching || isEnrichmentActive
                                }
                                className="px-3 py-1.5 text-xs bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {syncing ? "Syncing..." : "Sync New"}
                            </button>
                            <button
                                onClick={handleFullEnrichment}
                                disabled={
                                    syncing || reEnriching || isEnrichmentActive
                                }
                                className="px-3 py-1.5 text-xs bg-[#333] text-white rounded-full
                                hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {reEnriching ? "Starting..." : "Re-enrich All"}
                            </button>

                            {/* Control Actions */}
                            {isEnrichmentActive && (
                                <>
                                    {enrichmentState?.status === "running" ? (
                                        <button
                                            onClick={handlePause}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-yellow-600 text-white rounded-full
                                            hover:bg-yellow-700 transition-colors"
                                        >
                                            <Pause className="w-3 h-3" />
                                            Pause
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleResume}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-600 text-white rounded-full
                                            hover:bg-green-700 transition-colors"
                                        >
                                            <Play className="w-3 h-3" />
                                            Resume
                                        </button>
                                    )}
                                    <button
                                        onClick={handleStop}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 text-white rounded-full
                                        hover:bg-red-700 transition-colors"
                                    >
                                        <StopCircle className="w-3 h-3" />
                                        Stop
                                    </button>
                                </>
                            )}

                            {/* Failures Button */}
                            {totalFailures > 0 && (
                                <button
                                    onClick={() => setShowFailuresModal(true)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-500/20 text-red-400 border border-red-500/30 rounded-full
                                    hover:bg-red-500/30 transition-colors ml-auto"
                                >
                                    <AlertTriangle className="w-3 h-3" />
                                    View Failures ({totalFailures})
                                </button>
                            )}
                        </div>

                        {/* Status Message */}
                        {enrichmentState &&
                            enrichmentState.status !== "idle" && (
                                <div className="mt-3 p-2 bg-white/5 rounded text-xs">
                                    <div className="flex items-center gap-2">
                                        {enrichmentState.status ===
                                            "running" && (
                                            <Loader2 className="w-3 h-3 animate-spin text-[#ecb200]" />
                                        )}
                                        {enrichmentState.status ===
                                            "paused" && (
                                            <Pause className="w-3 h-3 text-yellow-400" />
                                        )}
                                        {enrichmentState.status ===
                                            "stopping" && (
                                            <StopCircle className="w-3 h-3 text-red-400 animate-pulse" />
                                        )}
                                        <span className="text-white/70">
                                            {enrichmentState.status ===
                                                "running" &&
                                                `Processing ${enrichmentState.currentPhase}...`}
                                            {enrichmentState.status ===
                                                "paused" && "Enrichment paused"}
                                            {enrichmentState.status ===
                                                "stopping" &&
                                                `Stopping... finishing ${
                                                    enrichmentState.stoppingInfo
                                                        ?.currentItem ||
                                                    "current item"
                                                }`}
                                        </span>
                                    </div>
                                    {enrichmentState.status === "running" &&
                                        enrichmentState.currentPhase ===
                                            "artists" &&
                                        enrichmentState.artists?.current && (
                                            <div className="mt-1 text-white/50 truncate">
                                                Current:{" "}
                                                {
                                                    enrichmentState.artists
                                                        .current
                                                }
                                            </div>
                                        )}
                                    {enrichmentState.status === "running" &&
                                        enrichmentState.currentPhase ===
                                            "tracks" &&
                                        enrichmentState.tracks?.current && (
                                            <div className="mt-1 text-white/50 truncate">
                                                Current:{" "}
                                                {enrichmentState.tracks.current}
                                            </div>
                                        )}
                                </div>
                            )}
                    </div>
                )}

                {/* Cache Sizes */}
                <SettingsRow
                    label="User cache size"
                    description="Maximum storage for offline content"
                >
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min={512}
                            max={20480}
                            step={512}
                            value={settings.maxCacheSizeMb}
                            onChange={(e) =>
                                onUpdate({
                                    maxCacheSizeMb: parseInt(e.target.value),
                                })
                            }
                            className="w-32 h-1 bg-[#404040] rounded-lg appearance-none cursor-pointer
                            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                        />
                        <span className="text-sm text-white w-16 text-right">
                            {(settings.maxCacheSizeMb / 1024).toFixed(1)} GB
                        </span>
                    </div>
                </SettingsRow>

                <SettingsRow
                    label="Transcode cache size"
                    description="Server restart required for changes"
                >
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min={1}
                            max={50}
                            value={settings.transcodeCacheMaxGb}
                            onChange={(e) =>
                                onUpdate({
                                    transcodeCacheMaxGb: parseInt(
                                        e.target.value
                                    ),
                                })
                            }
                            className="w-32 h-1 bg-[#404040] rounded-lg appearance-none cursor-pointer
                            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                        />
                        <span className="text-sm text-white w-16 text-right">
                            {settings.transcodeCacheMaxGb} GB
                        </span>
                    </div>
                </SettingsRow>

                {/* Automation */}
                <SettingsRow
                    label="Auto sync library"
                    description="Automatically sync library changes"
                    htmlFor="auto-sync"
                >
                    <SettingsToggle
                        id="auto-sync"
                        checked={settings.autoSync}
                        onChange={(checked) => onUpdate({ autoSync: checked })}
                    />
                </SettingsRow>

                <SettingsRow
                    label="Auto enrich metadata"
                    description="Automatically enrich metadata for new content"
                    htmlFor="auto-enrich"
                >
                    <SettingsToggle
                        id="auto-enrich"
                        checked={settings.autoEnrichMetadata}
                        onChange={(checked) =>
                            onUpdate({ autoEnrichMetadata: checked })
                        }
                    />
                </SettingsRow>

                {/* Enrichment Speed Control */}
                {settings.autoEnrichMetadata && (
                    <SettingsRow
                        label="Metadata Fetch Speed"
                        description="Parallel Last.fm/MusicBrainz requests for artist bios and mood tags. Higher = faster but may trigger rate limits."
                    >
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min={1}
                                max={5}
                                value={enrichmentSpeed}
                                disabled={isConcurrencyLoading}
                                onChange={(e) => {
                                    const newSpeed = parseInt(e.target.value);
                                    setConcurrencyMutation.mutate(newSpeed);
                                }}
                                className="w-32 h-1 bg-[#404040] rounded-lg appearance-none cursor-pointer
                                disabled:opacity-50 disabled:cursor-not-allowed
                                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                            />
                            <div className="flex flex-col items-end gap-0.5">
                                {isConcurrencyLoading ? (
                                    <span className="text-sm text-white/50 w-24 text-right">
                                        Loading...
                                    </span>
                                ) : (
                                    <>
                                        <span className="text-sm text-white w-24 text-right">
                                            {enrichmentSpeed === 1
                                                ? "Conservative"
                                                : enrichmentSpeed === 2
                                                ? "Moderate"
                                                : enrichmentSpeed === 3
                                                ? "Balanced"
                                                : enrichmentSpeed === 4
                                                ? "Fast"
                                                : "Maximum"}
                                        </span>
                                        {concurrencyConfig && (
                                            <span className="text-xs text-white/50 w-24 text-right">
                                                ~
                                                {
                                                    concurrencyConfig.artistsPerMin
                                                }{" "}
                                                artists/min
                                            </span>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    </SettingsRow>
                )}


                {/* Audio Analyzer Workers Control */}
                {settings.autoEnrichMetadata && (
                    <SettingsRow
                        label="Audio Analysis Workers"
                        description="CPU workers for Essentia ML analysis (BPM, key, mood, energy). Lower values reduce CPU usage on older systems."
                    >
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min={1}
                                max={8}
                                value={workersConfig?.workers ?? 2}
                                disabled={isWorkersLoading}
                                onChange={(e) => {
                                    const newWorkers = parseInt(e.target.value);
                                    setAnalysisWorkersMutation.mutate(newWorkers);
                                }}
                                className="w-32 h-1 bg-[#404040] rounded-lg appearance-none cursor-pointer
                                disabled:opacity-50 disabled:cursor-not-allowed
                                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                            />
                            <div className="flex flex-col items-end gap-0.5">
                                {isWorkersLoading ? (
                                    <span className="text-sm text-white/50 w-24 text-right">
                                        Loading...
                                    </span>
                                ) : (
                                    <>
                                        <span className="text-sm text-white w-24 text-right">
                                            {workersConfig?.workers ?? 2} workers
                                        </span>
                                        {workersConfig && (
                                            <span className="text-xs text-white/50 w-24 text-right">
                                                {workersConfig.cpuCores} cores available
                                            </span>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    </SettingsRow>
                )}
                {/* Cache Actions */}
                <div className="flex flex-col gap-3 pt-4">
                    <button
                        onClick={handleClearCaches}
                        disabled={clearingCaches}
                        className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full w-fit
                        hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {clearingCaches ? "Clearing..." : "Clear All Caches"}
                    </button>
                    <button
                        onClick={handleCleanupStaleJobs}
                        disabled={cleaningStaleJobs}
                        className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full w-fit
                        hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {cleaningStaleJobs
                            ? "Cleaning..."
                            : "Cleanup Stale Jobs"}
                    </button>
                    {cleanupResult && cleanupResult.totalCleaned > 0 && (
                        <p className="text-sm text-green-400">
                            Cleaned:{" "}
                            {cleanupResult.cleaned.discoveryBatches.cleaned}{" "}
                            batches,{" "}
                            {cleanupResult.cleaned.downloadJobs.cleaned}{" "}
                            downloads,{" "}
                            {cleanupResult.cleaned.spotifyImportJobs.cleaned}{" "}
                            imports, {cleanupResult.cleaned.bullQueues.cleaned}{" "}
                            queue jobs
                        </p>
                    )}
                    {cleanupResult && cleanupResult.totalCleaned === 0 && (
                        <p className="text-sm text-white/50">
                            No stale jobs found
                        </p>
                    )}
                    {error && <p className="text-sm text-red-400">{error}</p>}
                </div>
            </SettingsSection>

            <EnrichmentFailuresModal
                isOpen={showFailuresModal}
                onClose={() => setShowFailuresModal(false)}
            />
        </>
    );
}
