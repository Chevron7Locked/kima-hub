"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { enrichmentApi, type EnrichmentFailure } from "@/lib/enrichmentApi";
import { useFeatures } from "@/lib/features-context";
import {
    useQueryClient,
    useQuery,
    useMutation,
    keepPreviousData,
} from "@tanstack/react-query";
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
    Waves,
    ChevronDown,
    type LucideIcon,
} from "lucide-react";

interface CacheSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

function ProgressBar({
    progress,
    color = "bg-[#fca208]",
    showPercentage = true,
}: {
    progress: number;
    color?: string;
    showPercentage?: boolean;
}) {
    return (
        <div className="flex items-center gap-2 flex-1">
            <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                    className={`h-full ${color} transition-all duration-500 ease-out`}
                    style={{ width: `${Math.min(100, progress)}%` }}
                />
            </div>
            {showPercentage && (
                <span className="text-[10px] font-mono text-white/30 w-10 text-right uppercase tracking-wider">
                    {progress}%
                </span>
            )}
        </div>
    );
}

function EnrichmentStage({
    icon: Icon,
    label,
    description,
    completed,
    total,
    progress,
    isBackground = false,
    failed = 0,
    permanentlyFailed = 0,
    queued = 0,
    processing = 0,
}: {
    icon: LucideIcon;
    label: string;
    description: string;
    completed: number;
    total: number;
    progress: number;
    isBackground?: boolean;
    failed?: number;
    permanentlyFailed?: number;
    queued?: number;
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
                    <Loader2 className="w-4 h-4 text-[#fca208] animate-spin" />
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
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-lg bg-white/5 border border-white/10 text-white/40 uppercase tracking-wider">
                            background
                        </span>
                    )}
                </div>
                <p className="text-[10px] font-mono text-white/30 mt-0.5 uppercase tracking-wider">{description}</p>
                <div className="flex items-center gap-2 mt-2">
                    <ProgressBar
                        progress={progress}
                        color={
                            isComplete
                                ? "bg-green-500"
                                : isBackground
                                ? "bg-purple-500"
                                : "bg-[#fca208]"
                        }
                    />
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-white/20 uppercase tracking-wider">
                    <span>
                        {completed} / {total}
                    </span>
                    {queued > 0 && (
                        <span className="text-blue-400">
                            {queued} queued
                        </span>
                    )}
                    {processing > 0 && (
                        <span className="text-[#fca208]">
                            {processing} processing
                        </span>
                    )}
                    {failed > 0 && (
                        <span className="text-red-400">{failed} failed</span>
                    )}
                    {permanentlyFailed > 0 && (
                        <span className="text-red-400/60">{permanentlyFailed} permanently failed</span>
                    )}
                </div>
            </div>
        </div>
    );
}

const sliderClass = `w-32 h-1.5 bg-white/5 rounded-lg appearance-none cursor-pointer
    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gradient-to-r
    [&::-webkit-slider-thumb]:from-[#fca208] [&::-webkit-slider-thumb]:to-[#f97316]
    [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-[#fca208]/20
    hover:[&::-webkit-slider-thumb]:scale-110 [&::-webkit-slider-thumb]:transition-transform`;

const secondaryBtnClass = `px-4 py-1.5 text-xs font-mono bg-white/5 border border-white/10 text-white/70 rounded-lg uppercase tracking-wider
    hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all w-fit`;

function EnrichmentFailuresList() {
    const { data, isLoading } = useQuery({
        queryKey: ["enrichment-failures-inline"],
        queryFn: () => enrichmentApi.getFailures({ limit: 50 }),
        refetchInterval: 15000,
    });

    if (isLoading) return <div className="py-2 text-xs font-mono text-white/20 uppercase tracking-wider">Loading...</div>;
    if (!data?.failures?.length) return <div className="py-2 text-xs font-mono text-white/20 uppercase tracking-wider">No active failures</div>;

    return (
        <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
            {data.failures.map((f: EnrichmentFailure) => (
                <div key={f.id} className="flex items-center justify-between py-1 px-2 bg-white/[0.02] rounded text-xs font-mono">
                    <div className="flex-1 min-w-0">
                        <span className="text-white/60 truncate block">{f.entityName || f.entityId}</span>
                        <span className="text-red-400/50 text-[10px]">{f.errorMessage || "Unknown error"}</span>
                    </div>
                    <span className="text-white/20 text-[10px] ml-2 shrink-0">{f.errorCode}</span>
                </div>
            ))}
        </div>
    );
}

export function CacheSection({ settings, onUpdate }: CacheSectionProps) {
    const { musicCNN, vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const [syncing, setSyncing] = useState(false);
    const [clearingCaches, setClearingCaches] = useState(false);
    const [reEnriching, setReEnriching] = useState(false);
    const [cleaningStaleJobs, setCleaningStaleJobs] = useState(false);
    const [resettingArtists, setResettingArtists] = useState(false);
    const [resettingMoodTags, setResettingMoodTags] = useState(false);
    const [resettingAudio, setResettingAudio] = useState(false);
    const [resettingVibe, setResettingVibe] = useState(false);
    const [resettingEnrichment, setResettingEnrichment] = useState(false);
    const [retryingFailed, setRetryingFailed] = useState(false);
    const [retryResult, setRetryResult] = useState<{ reset: number } | null>(null);
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
    const [showInlineFailures, setShowInlineFailures] = useState(false);
    const queryClient = useQueryClient();
    const syncStartTimeRef = useRef<number>(0);

    useEffect(() => {
        if (window.location.hash === "#enrichment-failures") {
            setShowInlineFailures(true);
        }
    }, []);

    const {
        data: enrichmentProgress,
        refetch: refetchProgress,
        isPending: isProgressPending,
        isError: isProgressError,
    } = useQuery({
        queryKey: ["enrichment-progress"],
        queryFn: () => api.getEnrichmentProgress(),
        refetchInterval: 5000,
        staleTime: 2000,
        placeholderData: keepPreviousData,
        retry: 3,
    });

    const { data: enrichmentState } = useQuery({
        queryKey: ["enrichment-status"],
        queryFn: () => enrichmentApi.getStatus(),
        refetchInterval: 3000,
        staleTime: 1000,
    });

    const { data: failureCounts } = useQuery({
        queryKey: ["enrichment-failure-counts"],
        queryFn: () => enrichmentApi.getFailureCounts(),
        refetchInterval: 10000,
    });

    const { data: concurrencyConfig, isLoading: isConcurrencyLoading } =
        useQuery({
            queryKey: ["enrichment-concurrency"],
            queryFn: () => enrichmentApi.getConcurrency(),
            staleTime: 0,
        });

    const { data: workersConfig, isLoading: isWorkersLoading } = useQuery({
        queryKey: ["analysis-workers"],
        queryFn: () => enrichmentApi.getAnalysisWorkers(),
        staleTime: 0,
    });

    const setConcurrencyMutation = useMutation({
        mutationFn: (concurrency: number) =>
            enrichmentApi.setConcurrency(concurrency),
        onMutate: async (newConcurrency) => {
            await queryClient.cancelQueries({
                queryKey: ["enrichment-concurrency"],
            });
            const previousConcurrency = queryClient.getQueryData([
                "enrichment-concurrency",
            ]);
            queryClient.setQueryData(["enrichment-concurrency"], {
                concurrency: newConcurrency,
                artistsPerMin: newConcurrency * 6,
            });
            return { previousConcurrency };
        },
        onError: (err, newConcurrency, context) => {
            queryClient.setQueryData(
                ["enrichment-concurrency"],
                context?.previousConcurrency
            );
        },
    });

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
                description: `Using ${newWorkers} of ${
                    workersConfig?.cpuCores || 4
                } available CPU cores`,
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

    const { data: clapWorkersConfig, isLoading: isClapWorkersLoading } = useQuery({
        queryKey: ["clap-workers"],
        queryFn: () => enrichmentApi.getClapWorkers(),
        staleTime: 0,
    });

    const setClapWorkersMutation = useMutation({
        mutationFn: (workers: number) =>
            enrichmentApi.setClapWorkers(workers),
        onMutate: async (newWorkers) => {
            await queryClient.cancelQueries({
                queryKey: ["clap-workers"],
            });
            const previousWorkers = queryClient.getQueryData([
                "clap-workers",
            ]);
            queryClient.setQueryData(["clap-workers"], {
                workers: newWorkers,
                cpuCores: clapWorkersConfig?.cpuCores || 4,
                recommended: clapWorkersConfig?.recommended || 1,
                description: `Using ${newWorkers} of ${
                    clapWorkersConfig?.cpuCores || 4
                } available CPU cores`,
            });
            return { previousWorkers };
        },
        onError: (err, newWorkers, context) => {
            queryClient.setQueryData(
                ["clap-workers"],
                context?.previousWorkers
            );
        },
    });

    // Debounced slider commits -- only send API call after user stops dragging
    const workerDebounceRef = useRef<NodeJS.Timeout | null>(null);
    const debouncedSetWorkers = useCallback((workers: number) => {
        if (workerDebounceRef.current) clearTimeout(workerDebounceRef.current);
        // Optimistic UI update immediately
        queryClient.setQueryData(["analysis-workers"], {
            workers,
            cpuCores: workersConfig?.cpuCores || 4,
            recommended: workersConfig?.recommended || 2,
            description: `Using ${workers} of ${workersConfig?.cpuCores || 4} available CPU cores`,
        });
        workerDebounceRef.current = setTimeout(() => {
            setAnalysisWorkersMutation.mutate(workers);
        }, 500);
    }, [workersConfig, queryClient, setAnalysisWorkersMutation]);

    const clapDebounceRef = useRef<NodeJS.Timeout | null>(null);
    const debouncedSetClapWorkers = useCallback((workers: number) => {
        if (clapDebounceRef.current) clearTimeout(clapDebounceRef.current);
        queryClient.setQueryData(["clap-workers"], {
            workers,
            cpuCores: clapWorkersConfig?.cpuCores || 4,
            recommended: clapWorkersConfig?.recommended || 1,
            description: `Using ${workers} of ${clapWorkersConfig?.cpuCores || 4} available CPU cores`,
        });
        clapDebounceRef.current = setTimeout(() => {
            setClapWorkersMutation.mutate(workers);
        }, 500);
    }, [clapWorkersConfig, queryClient, setClapWorkersMutation]);

    // Clean up debounce timers on unmount
    useEffect(() => {
        return () => {
            if (workerDebounceRef.current) clearTimeout(workerDebounceRef.current);
            if (clapDebounceRef.current) clearTimeout(clapDebounceRef.current);
        };
    }, []);

    const enrichmentSpeed = concurrencyConfig?.concurrency ?? 1;

    useEffect(() => {
        if (!syncing) return;

        const maxPollDuration = 5 * 60 * 1000;
        const pollInterval = 2000;
        const startTime = syncStartTimeRef.current;

        const checkStatus = async () => {
            try {
                const status = await enrichmentApi.getStatus();
                const elapsed = Date.now() - startTime;
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
    };

    const handleSyncAndEnrich = async () => {
        setSyncing(true);
        syncStartTimeRef.current = Date.now();
        setError(null);
        try {
            if (settings.audiobookshelfEnabled) {
                await api.post("/audiobooks/sync", {});
            }
            await api.post("/podcasts/sync-covers", {});
            await api.syncLibraryEnrichment();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Sync error:", err);
            setError("Failed to sync");
            setSyncing(false);
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

    const handleResetArtists = async () => {
        setResettingArtists(true);
        setError(null);
        try {
            await api.resetArtistsOnly();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Reset artists error:", err);
            setError("Failed to reset artist enrichment");
        } finally {
            setResettingArtists(false);
        }
    };

    const handleResetMoodTags = async () => {
        setResettingMoodTags(true);
        setError(null);
        try {
            await api.resetMoodTagsOnly();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Reset mood tags error:", err);
            setError("Failed to reset mood tags");
        } finally {
            setResettingMoodTags(false);
        }
    };

    const handleResetAudioAnalysis = async () => {
        setResettingAudio(true);
        setError(null);
        try {
            await api.resetAudioAnalysisOnly();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Reset audio analysis error:", err);
            setError("Failed to reset audio analysis");
        } finally {
            setResettingAudio(false);
        }
    };

    const handleResetVibeEmbeddings = async () => {
        setResettingVibe(true);
        setError(null);
        try {
            await enrichmentApi.resetVibeEmbeddings();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Reset vibe embeddings error:", err);
            setError("Failed to reset vibe embeddings");
        } finally {
            setResettingVibe(false);
        }
    };

    const handleClearCaches = async () => {
        setClearingCaches(true);
        setError(null);
        try {
            await api.clearAllCaches();
            refreshNotifications();
        } catch {
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

    const handleRetryFailedAnalysis = async () => {
        setRetryingFailed(true);
        setRetryResult(null);
        setError(null);
        try {
            const result = await api.retryFailedAnalysis();
            setRetryResult({ reset: result.reset });
            refetchProgress();
        } catch (err) {
            console.error("Retry failed analysis error:", err);
            setError("Failed to retry analysis");
        } finally {
            setRetryingFailed(false);
        }
    };

    const handleResetEnrichment = async () => {
        if (!window.confirm(
            "This will wipe ALL enrichment data:\n\n" +
            "- Artist metadata (bios, images, similar artists)\n" +
            "- Audio analysis results (BPM, key, energy, etc.)\n" +
            "- Track embeddings (vibe map, similarity)\n" +
            "- Mood tags and genre tags\n" +
            "- All failure records\n" +
            "- Scan validation status\n\n" +
            "Everything will be re-enriched from scratch.\n\n" +
            "Are you sure?"
        )) return;

        setResettingEnrichment(true);
        setError(null);
        try {
            await api.resetAllEnrichmentData();
            refetchProgress();
            refreshNotifications();
        } catch (err) {
            console.error("Reset enrichment error:", err);
            setError("Failed to reset enrichment data");
        } finally {
            setResettingEnrichment(false);
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
                {isProgressPending ? (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10 flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-white/40" />
                        <span className="text-xs font-mono text-white/30 uppercase tracking-wider">Loading enrichment status...</span>
                    </div>
                ) : isProgressError && !enrichmentProgress ? (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-red-500/20 flex items-center justify-between">
                        <span className="text-xs font-mono text-red-400 uppercase tracking-wider">Failed to load enrichment status</span>
                        <button
                            onClick={() => refetchProgress()}
                            className="px-3 py-1 text-[10px] font-mono bg-white/5 border border-white/10 text-white/50 rounded-lg hover:bg-white/10 transition-colors uppercase tracking-wider"
                        >
                            Retry
                        </button>
                    </div>
                ) : enrichmentProgress ? (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-medium text-white">
                                Library Enrichment
                            </h3>
                            {enrichmentProgress.coreComplete &&
                                !enrichmentProgress.isFullyComplete && (
                                    <span className="text-[10px] font-mono text-purple-400 flex items-center gap-1 uppercase tracking-wider">
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        {enrichmentProgress.audioAnalysis.pending > 0 || enrichmentProgress.audioAnalysis.processing > 0
                                            ? "Audio analysis running"
                                            : "Vibe embeddings running"}
                                    </span>
                                )}
                            {enrichmentProgress.isFullyComplete && (
                                <span className="text-[10px] font-mono text-green-400 flex items-center gap-1 uppercase tracking-wider">
                                    <CheckCircle className="w-3 h-3" />
                                    Complete
                                </span>
                            )}
                        </div>

                        <div className="space-y-1">
                            {/* Artist Metadata */}
                            <div className="flex items-start gap-2">
                                <div className="flex-1">
                                    <EnrichmentStage
                                        icon={User}
                                        label="Artist Metadata"
                                        description="Bios, images, and similar artists from Last.fm"
                                        completed={enrichmentProgress.artists.completed}
                                        total={enrichmentProgress.artists.total}
                                        progress={enrichmentProgress.artists.progress}
                                        failed={enrichmentProgress.artists.failed}
                                    />
                                </div>
                                <button
                                    onClick={handleResetArtists}
                                    disabled={resettingArtists || syncing || reEnriching || isEnrichmentActive}
                                    className="mt-1 px-2 py-1 text-[10px] font-mono bg-white/5 border border-white/10 text-white/40 rounded-lg
                                        hover:bg-white/10 hover:text-white/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all whitespace-nowrap uppercase tracking-wider"
                                >
                                    {resettingArtists ? "Resetting..." : "Re-run"}
                                </button>
                            </div>

                            {/* Mood Tags */}
                            <div className="flex items-start gap-2">
                                <div className="flex-1">
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
                                </div>
                                <button
                                    onClick={handleResetMoodTags}
                                    disabled={resettingMoodTags || syncing || reEnriching || isEnrichmentActive}
                                    className="mt-1 px-2 py-1 text-[10px] font-mono bg-white/5 border border-white/10 text-white/40 rounded-lg
                                        hover:bg-white/10 hover:text-white/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all whitespace-nowrap uppercase tracking-wider"
                                >
                                    {resettingMoodTags ? "Resetting..." : "Re-run"}
                                </button>
                            </div>

                            {/* Audio Analysis */}
                            {!featuresLoading && musicCNN ? (
                                <div className="flex items-start gap-2">
                                    <div className="flex-1">
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
                                            queued={enrichmentProgress.audioAnalysis.queued}
                                            failed={enrichmentProgress.audioAnalysis.failed}
                                            permanentlyFailed={enrichmentProgress.audioAnalysis.permanentlyFailed}
                                            isBackground={true}
                                        />
                                    </div>
                                    <button
                                        onClick={handleResetAudioAnalysis}
                                        disabled={resettingAudio || syncing || reEnriching || isEnrichmentActive}
                                        className="mt-1 px-2 py-1 text-[10px] font-mono bg-white/5 border border-white/10 text-white/40 rounded-lg
                                            hover:bg-white/10 hover:text-white/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all whitespace-nowrap uppercase tracking-wider"
                                    >
                                        {resettingAudio ? "Resetting..." : "Re-run"}
                                    </button>
                                </div>
                            ) : !featuresLoading ? (
                                <div className="opacity-50 py-2">
                                    <h4 className="text-sm font-medium text-white/50">Audio Analysis</h4>
                                    <p className="text-xs font-mono text-white/30 uppercase tracking-wider">Not available (lite mode)</p>
                                    <p className="text-[10px] font-mono text-white/20 mt-1 uppercase tracking-wider">
                                        Service not detected -- check setup documentation
                                    </p>
                                </div>
                            ) : null}

                            {/* CLAP Embeddings */}
                            {!featuresLoading && vibeEmbeddings ? (
                                enrichmentProgress.clapEmbeddings && (
                                    <div className="flex items-start gap-2">
                                        <div className="flex-1">
                                            <EnrichmentStage
                                                icon={Waves}
                                                label="Vibe Embeddings"
                                                description="CLAP audio embeddings for similarity search"
                                                completed={enrichmentProgress.clapEmbeddings.completed}
                                                total={enrichmentProgress.clapEmbeddings.total}
                                                progress={enrichmentProgress.clapEmbeddings.progress}
                                                processing={enrichmentProgress.clapEmbeddings.processing}
                                                failed={enrichmentProgress.clapEmbeddings.failed}
                                                isBackground={true}
                                            />
                                        </div>
                                        <button
                                            onClick={handleResetVibeEmbeddings}
                                            disabled={resettingVibe || syncing || reEnriching || isEnrichmentActive}
                                            className="mt-1 px-2 py-1 text-[10px] font-mono bg-white/5 border border-white/10 text-white/40 rounded-lg
                                                hover:bg-white/10 hover:text-white/60 disabled:opacity-30 disabled:cursor-not-allowed transition-all whitespace-nowrap uppercase tracking-wider"
                                        >
                                            {resettingVibe ? "Resetting..." : "Re-run"}
                                        </button>
                                    </div>
                                )
                            ) : !featuresLoading ? (
                                <div className="opacity-50 py-2">
                                    <h4 className="text-sm font-medium text-white/50">Vibe Similarity</h4>
                                    <p className="text-xs font-mono text-white/30 uppercase tracking-wider">Not available (lite mode)</p>
                                    <p className="text-[10px] font-mono text-white/20 mt-1 uppercase tracking-wider">
                                        Service not detected -- check setup documentation
                                    </p>
                                </div>
                            ) : null}
                        </div>

                        {/* Control Buttons */}
                        <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-white/10">
                            <button
                                onClick={handleSyncAndEnrich}
                                disabled={
                                    syncing || reEnriching || isEnrichmentActive
                                }
                                className="px-3 py-1.5 text-xs font-black bg-[#fca208] text-black rounded-lg uppercase tracking-wider
                                hover:bg-[#f97316] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {syncing ? "Syncing..." : "Sync New"}
                            </button>
                            <button
                                onClick={handleFullEnrichment}
                                disabled={
                                    syncing || reEnriching || isEnrichmentActive
                                }
                                className="px-3 py-1.5 text-xs font-mono bg-white/5 border border-white/10 text-white/70 rounded-lg uppercase tracking-wider
                                hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                {reEnriching ? "Starting..." : "Re-enrich All"}
                            </button>

                            {isEnrichmentActive && (
                                <>
                                    {enrichmentState?.status === "running" ? (
                                        <button
                                            onClick={handlePause}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-yellow-600/20 border border-yellow-600/30 text-yellow-400 rounded-lg uppercase tracking-wider
                                            hover:bg-yellow-600/30 transition-colors"
                                        >
                                            <Pause className="w-3 h-3" />
                                            Pause
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleResume}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-green-600/20 border border-green-600/30 text-green-400 rounded-lg uppercase tracking-wider
                                            hover:bg-green-600/30 transition-colors"
                                        >
                                            <Play className="w-3 h-3" />
                                            Resume
                                        </button>
                                    )}
                                    <button
                                        onClick={handleStop}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-red-600/20 border border-red-600/30 text-red-400 rounded-lg uppercase tracking-wider
                                        hover:bg-red-600/30 transition-colors"
                                    >
                                        <StopCircle className="w-3 h-3" />
                                        Stop
                                    </button>
                                </>
                            )}

                        </div>

                        {totalFailures > 0 && (
                            <div className="mt-4 pt-3 border-t border-white/10">
                                <button
                                    onClick={() => setShowInlineFailures(!showInlineFailures)}
                                    className="flex items-center gap-2 text-xs font-mono text-red-400/70 uppercase tracking-wider hover:text-red-400 transition-colors"
                                >
                                    <AlertTriangle className="w-3 h-3" />
                                    {showInlineFailures ? "Hide" : "Show"} Failures ({totalFailures})
                                    <ChevronDown className={`w-3 h-3 transition-transform ${showInlineFailures ? "rotate-180" : ""}`} />
                                </button>
                                {showInlineFailures && <EnrichmentFailuresList />}
                            </div>
                        )}

                        {/* Status Message */}
                        {enrichmentState &&
                            enrichmentState.status !== "idle" && (
                                <div className="mt-3 p-2 bg-white/[0.02] rounded-lg border border-white/5 text-xs">
                                    <div className="flex items-center gap-2">
                                        {enrichmentState.status ===
                                            "running" && (
                                            <Loader2 className="w-3 h-3 animate-spin text-[#fca208]" />
                                        )}
                                        {enrichmentState.status ===
                                            "paused" && (
                                            <Pause className="w-3 h-3 text-yellow-400" />
                                        )}
                                        {enrichmentState.status ===
                                            "stopping" && (
                                            <StopCircle className="w-3 h-3 text-red-400 animate-pulse" />
                                        )}
                                        <span className="text-white/50 font-mono">
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
                                            <div className="mt-1 text-white/30 font-mono truncate">
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
                                            <div className="mt-1 text-white/30 font-mono truncate">
                                                Current:{" "}
                                                {enrichmentState.tracks.current}
                                            </div>
                                        )}
                                </div>
                            )}
                    </div>
                ) : null}

                {enrichmentProgress && (
                    <div className="flex items-center gap-3 -mt-3 mb-4 px-1">
                        <button
                            onClick={handleResetEnrichment}
                            disabled={resettingEnrichment || isEnrichmentActive}
                            className="px-3 py-1.5 text-xs font-black bg-red-600/80 text-white rounded-lg uppercase tracking-wider
                                hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {resettingEnrichment ? "Resetting..." : "Reset Enrichment Data"}
                        </button>
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
                            className={sliderClass}
                        />
                        <span className="text-xs font-mono text-white/50 w-16 text-right">
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
                            className={sliderClass}
                        />
                        <span className="text-xs font-mono text-white/50 w-16 text-right">
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
                        description="Parallel Last.fm/MusicBrainz requests for artist bios and mood tags"
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
                                className={`${sliderClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                            />
                            <div className="flex flex-col items-end gap-0.5">
                                {isConcurrencyLoading ? (
                                    <span className="text-xs font-mono text-white/30 w-24 text-right uppercase tracking-wider">
                                        Loading...
                                    </span>
                                ) : (
                                    <>
                                        <span className="text-xs font-mono text-white/50 w-24 text-right">
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
                                            <span className="text-[10px] font-mono text-white/30 w-24 text-right uppercase tracking-wider">
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
                {settings.autoEnrichMetadata && !featuresLoading && musicCNN && (
                    <SettingsRow
                        label="Audio Analysis Workers"
                        description="CPU workers for Essentia ML analysis"
                    >
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min={1}
                                max={8}
                                value={workersConfig?.workers ?? 2}
                                disabled={isWorkersLoading}
                                onChange={(e) => {
                                    debouncedSetWorkers(parseInt(e.target.value));
                                }}
                                className={`${sliderClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                            />
                            <div className="flex flex-col items-end gap-0.5">
                                {isWorkersLoading ? (
                                    <span className="text-xs font-mono text-white/30 w-24 text-right uppercase tracking-wider">
                                        Loading...
                                    </span>
                                ) : (
                                    <>
                                        <span className="text-xs font-mono text-white/50 w-24 text-right">
                                            {workersConfig?.workers ?? 2}{" "}
                                            workers
                                        </span>
                                        {workersConfig && (
                                            <span className="text-[10px] font-mono text-white/30 w-24 text-right uppercase tracking-wider">
                                                {workersConfig.cpuCores} cores
                                                available
                                            </span>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    </SettingsRow>
                )}

                {/* CLAP Analyzer Workers Control */}
                {settings.autoEnrichMetadata && !featuresLoading && vibeEmbeddings && (
                    <SettingsRow
                        label="Vibe Embedding Workers"
                        description="CPU workers for CLAP embeddings (vibe similarity)"
                    >
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min={1}
                                max={8}
                                value={clapWorkersConfig?.workers ?? 2}
                                disabled={isClapWorkersLoading}
                                onChange={(e) => {
                                    debouncedSetClapWorkers(parseInt(e.target.value));
                                }}
                                className={`${sliderClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                            />
                            <div className="flex flex-col items-end gap-0.5">
                                {isClapWorkersLoading ? (
                                    <span className="text-xs font-mono text-white/30 w-24 text-right uppercase tracking-wider">
                                        Loading...
                                    </span>
                                ) : (
                                    <>
                                        <span className="text-xs font-mono text-white/50 w-24 text-right">
                                            {clapWorkersConfig?.workers ?? 2}{" "}
                                            workers
                                        </span>
                                        {clapWorkersConfig && (
                                            <span className="text-[10px] font-mono text-white/30 w-24 text-right uppercase tracking-wider">
                                                {clapWorkersConfig.cpuCores} cores
                                                available
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
                        className={secondaryBtnClass}
                    >
                        {clearingCaches ? "Clearing..." : "Clear All Caches"}
                    </button>
                    <button
                        onClick={handleCleanupStaleJobs}
                        disabled={cleaningStaleJobs}
                        className={secondaryBtnClass}
                    >
                        {cleaningStaleJobs
                            ? "Cleaning..."
                            : "Cleanup Stale Jobs"}
                    </button>
                    {(enrichmentProgress?.audioAnalysis?.failed > 0 || enrichmentProgress?.audioAnalysis?.permanentlyFailed > 0) && (
                        <button
                            onClick={handleRetryFailedAnalysis}
                            disabled={retryingFailed || isEnrichmentActive}
                            className={secondaryBtnClass}
                        >
                            {retryingFailed
                                ? "Retrying..."
                                : `Retry Failed Analysis (${(enrichmentProgress.audioAnalysis.failed || 0) + (enrichmentProgress.audioAnalysis.permanentlyFailed || 0)})`}
                        </button>
                    )}
                    {retryResult && (
                        <p className="text-xs font-mono text-green-400 uppercase tracking-wider">
                            Reset {retryResult.reset} failed tracks to pending
                        </p>
                    )}
                    {cleanupResult && cleanupResult.totalCleaned > 0 && (
                        <p className="text-xs font-mono text-green-400 uppercase tracking-wider">
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
                        <p className="text-xs font-mono text-white/30 uppercase tracking-wider">
                            No stale jobs found
                        </p>
                    )}
                    {error && <p className="text-xs font-mono text-red-400 uppercase tracking-wider">{error}</p>}
                </div>
            </SettingsSection>

        </>
    );
}
