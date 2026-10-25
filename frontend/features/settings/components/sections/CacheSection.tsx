"use client";

import { useState, useEffect, useRef } from "react";
import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import {
    api,
    type EnrichmentFailure,
    type EnrichmentRerunStep,
    type GpuRuntimeStatus,
} from "@/lib/api";
import { useWorkerSetting } from "../../hooks/useWorkerSetting";
import { useAuth } from "@/lib/auth-context";
import { useFeatures } from "@/lib/features-context";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { BothAtOnceSwitch, BOTH_AT_ONCE_DESCRIPTION, BOTH_AT_ONCE_LABEL } from "@/components/enrichment/BothAtOnceSwitch";
import {
    useQueryClient,
    useQuery,
    useMutation,
    keepPreviousData,
} from "@tanstack/react-query";
import {
    CheckCircle,
    User,
    Fingerprint,
    Activity,
    Pause,
    Play,
    StopCircle,
    AlertTriangle,
    Waves,
    Network,
    Smile,
    ChevronDown,
    type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

interface CacheSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

function ProgressBar({
    progress,
    color = "bg-brand",
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
                    className={`h-full ${color} transition-all duration-200`}
                    style={{ width: `${Math.min(100, progress)}%` }}
                />
            </div>
            {showPercentage && (
                <span className="text-xs tabular-nums text-[var(--text-muted)] w-10 text-right">
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
    missing = 0,
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
    /** Songs whose files are gone: left out of the count, shown beside it. */
    missing?: number;
}) {
    const isComplete = progress === 100;
    const hasActivity = processing > 0;

    return (
        <div className="flex items-start gap-3 py-2">
            <div
                className={`mt-0.5 p-1.5 rounded-lg ${
                    isComplete ? "bg-success/20" : "bg-white/5"
                }`}
            >
                {isComplete ? (
                    <CheckCircle className="w-4 h-4 text-success" />
                ) : hasActivity ? (
                    <GradientSpinner size="sm" />
                ) : (
                    <Icon className="w-4 h-4 text-[var(--text-muted)]" />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">
                        {label}
                    </span>
                    {isBackground && !isComplete && (
                        <span className="text-xs px-1.5 py-0.5 rounded-lg bg-white/5 border border-white/10 text-[var(--text-muted)]">
                            background
                        </span>
                    )}
                </div>
                <p className="text-xs tabular-nums text-[var(--text-muted)] mt-0.5">{description}</p>
                <div className="flex items-center gap-2 mt-2">
                    <ProgressBar
                        progress={progress}
                        color={
                            isComplete
                                ? "bg-success"
                                : isBackground
                                ? "bg-brand/60"
                                : "bg-brand"
                        }
                    />
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs tabular-nums text-[var(--text-muted)]">
                    <span>
                        {completed} / {total - missing}
                    </span>
                    {missing > 0 && <span>{missing} files missing</span>}
                    {queued > 0 && (
                        <span className="text-[var(--text-secondary)]">
                            {queued} queued
                        </span>
                    )}
                    {processing > 0 && (
                        <span className="text-brand">
                            {processing} processing
                        </span>
                    )}
                    {failed > 0 && (
                        <span className="text-danger-light">{failed} failed</span>
                    )}
                    {permanentlyFailed > 0 && (
                        <span className="text-danger-light/60">{permanentlyFailed} permanently failed</span>
                    )}
                </div>
            </div>
        </div>
    );
}

const sliderClass = `w-32 h-1.5 bg-white/5 rounded-lg appearance-none cursor-pointer
    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gradient-to-r
    [&::-webkit-slider-thumb]:from-brand [&::-webkit-slider-thumb]:to-brand-dark
    hover:[&::-webkit-slider-thumb]:scale-110 [&::-webkit-slider-thumb]:transition-transform`;

/** A slider for one analyzer's worker count, beside the cores it can use. */
function WorkerSliderRow({ label, description, config, isLoading, setWorkers }: {
    label: string;
    description: string;
    config: ReturnType<typeof useWorkerSetting>["config"];
    isLoading: boolean;
    setWorkers: (workers: number) => void;
}) {
    return (
        <SettingsRow label={label} description={description}>
            <div className="flex items-center gap-3">
                <input
                    type="range"
                    min={1}
                    max={config?.cpuCores ?? 8}
                    aria-label={label}
                    value={config?.workers ?? 2}
                    disabled={isLoading}
                    onChange={(e) => setWorkers(parseInt(e.target.value))}
                    className={`${sliderClass} disabled:opacity-50 disabled:cursor-not-allowed`}
                />
                <div className="flex flex-col items-end gap-0.5">
                    {isLoading ? (
                        <span className="text-xs text-[var(--text-muted)] w-24 text-right">
                            Loading...
                        </span>
                    ) : (
                        <>
                            <span className="text-xs tabular-nums text-[var(--text-secondary)] w-24 text-right">
                                {config?.workers ?? 2} workers
                            </span>
                            {config && (
                                <span className="text-xs tabular-nums text-[var(--text-muted)] w-24 text-right">
                                    {config.cpuCores} cores available
                                </span>
                            )}
                            {config?.analyzerOnline === false && (
                                <span className="text-xs text-warning w-24 text-right">
                                    analyzer offline
                                </span>
                            )}
                        </>
                    )}
                </div>
            </div>
        </SettingsRow>
    );
}

function EnrichmentFailuresList({ active = false }: { active?: boolean }) {
    const { data, isLoading } = useQuery({
        queryKey: ["enrichment-failures-inline"],
        queryFn: () => api.getEnrichmentFailures({ limit: 50 }),
        // The list only changes while a run is in flight; when idle it is
        // fetched once on mount and left alone.
        refetchInterval: active ? 15000 : false,
    });

    if (isLoading) return <div className="py-2 text-xs text-[var(--text-muted)]">Loading...</div>;
    if (!data?.failures?.length) return <div className="py-2 text-xs text-[var(--text-muted)]">No active failures</div>;

    return (
        <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
            {data.failures.map((f: EnrichmentFailure) => (
                <div key={f.id} className="flex items-center justify-between py-1 px-2 bg-white/[0.02] rounded text-xs tabular-nums">
                    <div className="flex-1 min-w-0">
                        <span className="text-[var(--text-secondary)] truncate block">{f.entityName || f.entityId}</span>
                        <span className="text-danger-light/50 text-micro">{f.errorMessage || "Unknown error"}</span>
                    </div>
                    <span className="text-[var(--text-muted)] text-micro ml-2 shrink-0">{f.errorCode}</span>
                </div>
            ))}
        </div>
    );
}

type QueueResult = "retry" | "everything" | "wipe" | "rerun";
type ConfirmTarget = "retryFailedAndBlocked" | "redecideEverything" | "wipeAndRerun" | null;

/**
 * What each step a re-run can start from redoes (services/enrichmentRestart.ts); a step added to the API must be
 * described here. `relaysMap`: the re-run lays the vibe map out again, which every step but the moods does.
 */
const RERUN_STEPS: Record<EnrichmentRerunStep, { label: string; message: string; relaysMap: boolean }> = {
    moods: {
        label: "moods",
        message:
            "Recomputes every song's moods from its stored sound vector; the mood mixes, stations and song tags " +
            "follow. No audio is re-read.",
        relaysMap: false,
    },
    similarity: {
        label: "similarity + map",
        message:
            "Rebuilds the feel, the library statistics and the vibe map from scratch. " +
            "Nothing about your tracks is measured again, so this is the quickest one.",
        relaysMap: true,
    },
    vectors: {
        label: "sound vectors",
        message:
            "Re-runs sound vectors for every track, then the moods and the vibe map. " +
            "Audio analysis and identification are kept.",
        relaysMap: true,
    },
    analysis: {
        label: "audio analysis",
        message:
            "Re-runs audio analysis for every track, then sound vectors, the moods and the vibe map. " +
            "Identification (which recording each track is) is kept.",
        relaysMap: true,
    },
    artists: {
        label: "artists",
        message:
            "Re-runs artist bios, genres and similar artists, then rebuilds the vibe map " +
            "(its formula reads artist genres). Audio analysis, sound vectors and moods are kept.",
        relaysMap: true,
    },
    identification: {
        label: "identification (everything)",
        message:
            "Same as wiping and re-running everything: identification, artists, audio analysis, " +
            "sound vectors, the moods and the vibe map, all from the start.",
        relaysMap: true,
    },
};

/** The order the steps are offered in, as written above: quickest first. */
const RERUN_ORDER = Object.keys(RERUN_STEPS) as EnrichmentRerunStep[];

const WIPE_MESSAGE =
    "Clears what Kima worked out about your music: which recording each track is, audio analysis, vibe data, moods, the vibe map, " +
    "artist bios and similar artists. " +
    "Then it works it all out again with the new engine. Your music, playlists, plays, likes and edits stay. " +
    "Takes a few hours on a large library; the vibe map is back when it finishes.";

const confirmMeta: Record<
    NonNullable<ConfirmTarget>,
    { title: string; message: string; confirmText: string }
> = {
    retryFailedAndBlocked: {
        title: "Retry What Didn't Work?",
        message:
        "Re-runs every incomplete track. Complete tracks are skipped. Nothing is deleted.",
        confirmText: "Retry What Didn't Work",
    },
    redecideEverything: {
        title: "Start Over on Everything?",
        message:
        "Re-processes the whole library. Existing matches are kept. Nothing is deleted. Takes hours on a large library.",
        confirmText: "Start Over on Everything",
    },
    wipeAndRerun: {
        title: "Wipe and Re-run Enrichment?",
        message: WIPE_MESSAGE,
        confirmText: "Wipe and Re-run",
    },
};

type EnrichmentProgress = Awaited<ReturnType<typeof api.getEnrichmentProgress>>;
type EnrichmentPhase = NonNullable<NonNullable<Awaited<ReturnType<typeof api.getEnrichmentState>>>["currentPhase"]>;

/** The steps that run after the core enrichment, in the order a cycle runs them. */
const BACKGROUND_STEPS: { label: string; done: (p: EnrichmentProgress) => boolean }[] = [
    {
        label: "Audio analysis",
        done: (p) => (p.audioAnalysis?.pending ?? 0) === 0 && (p.audioAnalysis?.processing ?? 0) === 0,
    },
    {
        label: "Vibe embeddings",
        done: (p) => (p.clapEmbeddings?.pending ?? 0) === 0 && (p.clapEmbeddings?.processing ?? 0) === 0,
    },
    { label: "Moods", done: (p) => (p.moods?.pending ?? 0) === 0 },
    { label: "Similarity", done: (p) => (p.similarity?.pending ?? 0) === 0 },
];

/** "<step> running" for the first background step with work left. */
export function backgroundStepRunning(p: EnrichmentProgress): string {
    const step = BACKGROUND_STEPS.find((s) => !s.done(p)) ?? BACKGROUND_STEPS[BACKGROUND_STEPS.length - 1];
    return `${step.label} running`;
}

const PHASE_LABELS: Record<EnrichmentPhase, string> = {
    artists: "artist metadata",
    tracks: "song identification",
    fingerprint: "fingerprints",
    audio: "audio analysis",
    podcasts: "podcasts",
    vibe: "vibe embeddings",
    mood: "moods",
    similarity: "similarity",
};

/** The enrichment step a cycle is on, in the words the step list uses. */
export function phaseLabel(phase: EnrichmentPhase | null | undefined): string {
    return phase ? PHASE_LABELS[phase] : "enrichment";
}

// The analyzer installs the runtime while either switch is on and keeps it when both are off, so the
// status keeps polling until the runtime matches the switches.
export function gpuSettling(g: GpuRuntimeStatus): boolean {
    if (g.installing) return true;
    if (!g.enabled && !g.analysis) return false;
    if (!g.installed) return g.status !== "failed";
    return (g.enabled && !g.effective && !g.fellBack) || (g.analysis && !g.analysisEffective && !g.analysisFellBack);
}

/** One GPU switch and the state it was measured in; `on`, `effective` and `fellBack` are that switch's. */
function GpuSwitchRow({ id, label, description, gpu, on, effective, fellBack, pending, onChange }: {
    id: string;
    label: string;
    description: string;
    gpu: GpuRuntimeStatus | null;
    on: boolean;
    effective: boolean;
    fellBack: boolean;
    pending: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <SettingsRow label={label} description={description} htmlFor={id}>
            <div className="flex flex-col items-end gap-1">
                <SettingsToggle id={id} checked={on} disabled={pending} onChange={onChange} />
                {gpu && (
                    <span
                        data-testid={`${id}-status`}
                        className={`text-xs text-right ${
                            on && (gpu.status === "failed" || fellBack)
                                ? "text-warning"
                                : effective
                                  ? "text-success"
                                  : "text-[var(--text-muted)]"
                        }`}
                    >
                        {gpuStatusText(gpu, on, effective, fellBack)}
                    </span>
                )}
            </div>
        </SettingsRow>
    );
}

export function gpuStatusText(g: GpuRuntimeStatus, on: boolean, effective: boolean, fellBack: boolean): string {
    if (g.installing) return "Downloading GPU runtime (~2 GB)…";
    // A failure only matters to a switch that wants the runtime; the analyzer forgets it once both are off.
    if (!on)
        return g.installed
            ? "Runtime installed; GPU is off."
            : "Off (CPU)";
    if (g.status === "failed") {
        switch (g.reason) {
            case "no_gpu":
                return "Failed: no NVIDIA GPU visible";
            case "no_network":
                return "Failed: package index unreachable";
            case "driver_too_old":
                return "Failed: NVIDIA driver too old";
            case "unsupported_platform":
                return "Failed: Linux x86_64 only";
            case "checksum_mismatch":
                return "Failed: checksum mismatch";
            default:
                return `Failed: ${g.reason || "install error"}.`;
        }
    }
    if (effective) return "Active";
    if (fellBack) return "Installed, but the GPU session fell back to the CPU";
    if (g.installed)
        return "Installed, applying (the analyzer restarts between songs)";
    return g.installerUp
        ? "Enabled, downloading"
        : "Waiting for the vibe embeddings analyzer, which does the download";
}

export function CacheSection({ settings, onUpdate }: CacheSectionProps) {
    const { musicCNN, vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const { user: currentUser } = useAuth();
    const [syncing, setSyncing] = useState(false);
    const [clearingCaches, setClearingCaches] = useState(false);
    const [clearCachesResult, setClearCachesResult] = useState<string | null>(null);
    const [cleaningStaleJobs, setCleaningStaleJobs] = useState(false);
    const [retryingAll, setRetryingAll] = useState(false);
    const [redeciding, setRedeciding] = useState(false);
    const [retryingFailed, setRetryingFailed] = useState(false);
    const [retryResult, setRetryResult] = useState<{ reset: number } | null>(null);
    const [queueResult, setQueueResult] = useState<QueueResult | null>(null);
    const [wiping, setWiping] = useState(false);
    const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);
    const [rerunStep, setRerunStep] = useState<EnrichmentRerunStep>("similarity");
    const [rerunConfirmStep, setRerunConfirmStep] = useState<EnrichmentRerunStep | null>(null);
    const [rerunningStep, setRerunningStep] = useState(false);
    const [maintenanceOpen, setMaintenanceOpen] = useState(false);
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

    // This query is the one that answers "is enrichment doing anything", so it
    // is the only one that keeps a heartbeat while idle -- and at 30s rather
    // than 3s, because an idle run does not become busy without the user
    // starting it or an SSE event arriving.
    const { data: enrichmentState } = useQuery({
        queryKey: ["enrichment-status"],
        queryFn: () => api.getEnrichmentState(),
        refetchInterval: (query) =>
            query.state.data?.status && query.state.data.status !== "idle"
                ? 3000
                : 30000,
        staleTime: 1000,
    });

    // Everything below only changes while a run is in flight, so it polls only then.
    const enrichmentActive =
        !!enrichmentState?.status && enrichmentState.status !== "idle";

    const {
        data: enrichmentProgress,
        refetch: refetchProgress,
        isPending: isProgressPending,
        isError: isProgressError,
    } = useQuery({
        queryKey: ["enrichment-progress"],
        queryFn: () => api.getEnrichmentProgress(),
        // useEventSource already invalidates this key on "enrichment:progress",
        // so while idle the poll is pure duplication.
        refetchInterval: enrichmentActive ? 5000 : false,
        staleTime: 2000,
        placeholderData: keepPreviousData,
        retry: 3,
    });

    const { data: failureCounts } = useQuery({
        queryKey: ["enrichment-failure-counts"],
        queryFn: () => api.getEnrichmentFailureCounts(),
        // Failures only appear while something is being enriched.
        refetchInterval: enrichmentActive ? 10000 : false,
    });

    const { data: concurrencyConfig, isLoading: isConcurrencyLoading } =
        useQuery({
            queryKey: ["enrichment-concurrency"],
            queryFn: () => api.getEnrichmentConcurrency(),
            staleTime: 0,
        });

    const setConcurrencyMutation = useMutation({
        mutationFn: (concurrency: number) =>
            api.setEnrichmentConcurrency(concurrency),
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
        onError: (_err, _newConcurrency, context) => {
            queryClient.setQueryData(
                ["enrichment-concurrency"],
                context?.previousConcurrency
            );
        },
    });

    const analysisWorkers = useWorkerSetting(
        "analysis-workers",
        () => api.getAnalysisWorkers(),
        (workers) => api.setAnalysisWorkers(workers),
        2,
    );
    const clapWorkers = useWorkerSetting(
        "clap-workers",
        () => api.getClapWorkers(),
        (workers) => api.setClapWorkers(workers),
        1,
    );

    const { data: gpuStatus } = useQuery({
        queryKey: ["gpu-runtime-status"],
        queryFn: () => api.getGpuStatus(),
        refetchInterval: (query) =>
            query.state.data && gpuSettling(query.state.data) ? 5000 : false,
    });

    const setGpuMutation = useMutation({
        mutationFn: (enabled: boolean) => api.setGpuEnabled(enabled),
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: ["gpu-runtime-status"],
            }),
    });

    const setGpuAnalysisMutation = useMutation({
        mutationFn: (analysis: boolean) => api.setGpuAnalysisEnabled(analysis),
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: ["gpu-runtime-status"],
            }),
    });

    const enrichmentSpeed = concurrencyConfig?.concurrency ?? 1;

    useEffect(() => {
        if (!syncing) return;

        const maxPollDuration = 5 * 60 * 1000;
        const pollInterval = 2000;
        const startTime = syncStartTimeRef.current;

        const checkStatus = async () => {
            try {
                const status = await api.getEnrichmentState();
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

    const handleSyncAndEnrich = async () => {
        setSyncing(true);
        syncStartTimeRef.current = Date.now();
        setError(null);
        try {
            if (settings.audiobookshelfEnabled) {
                await api.post("/audiobooks/sync", {});
            }
            await api.syncLibraryEnrichment();
            refetchProgress();
        } catch (err) {
            console.error("Sync error:", err);
            setError("Failed to sync");
            setSyncing(false);
        }
    };

    const runQueueAction = async (
        run: () => Promise<unknown>,
        setBusy: (busy: boolean) => void,
        result: QueueResult,
        failure: string,
    ) => {
        setBusy(true);
        setError(null);
        try {
            await run();
            setQueueResult(result);
            refetchProgress();
            void queryClient.invalidateQueries({ queryKey: ["enrichment-failure-counts"] });
            void queryClient.invalidateQueries({ queryKey: ["enrichment-failures-inline"] });
        } catch (err) {
            console.error(failure, err);
            setError(failure);
        } finally {
            setBusy(false);
        }
    };

    const execRetryFailedAndBlocked = () =>
        runQueueAction(() => api.retryFailedAndBlocked(), setRetryingAll, "retry", "Couldn't queue the retry");

    const execRedecideEverything = () =>
        runQueueAction(() => api.redecideEverything(), setRedeciding, "everything", "Couldn't start the pass");

    const execWipeAndRerun = () =>
        runQueueAction(() => api.wipeAndRerunEnrichment(), setWiping, "wipe", "Couldn't wipe and re-run");

    const execRerunStep = (step: EnrichmentRerunStep) =>
        runQueueAction(() => api.rerunEnrichment(step), setRerunningStep, "rerun", "Couldn't start the re-run");

    const handleClearCaches = async () => {
        setClearingCaches(true);
        setClearCachesResult(null);
        setError(null);
        try {
            const result = await api.clearAllCaches();
            setClearCachesResult(result.message);
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

    const handleConfirmAction = async () => {
        const target = confirmTarget;
        setConfirmTarget(null);
        if (target === "retryFailedAndBlocked") await execRetryFailedAndBlocked();
        else if (target === "redecideEverything") await execRedecideEverything();
        else if (target === "wipeAndRerun") await execWipeAndRerun();
    };

    const controlEnrichment = async (run: () => Promise<unknown>, failure: string, alsoRefresh: string[] = []) => {
        try {
            await run();
            for (const key of ["enrichment-status", ...alsoRefresh]) {
                queryClient.invalidateQueries({ queryKey: [key] });
            }
        } catch (err) {
            console.error(failure, err);
            setError(failure);
        }
    };

    const handlePause = () => controlEnrichment(() => api.pauseEnrichment(), "Failed to pause enrichment");

    const handleResume = () => controlEnrichment(() => api.resumeEnrichment(), "Failed to resume enrichment");

    const handleStop = () =>
        controlEnrichment(() => api.stopEnrichment(), "Failed to stop enrichment", ["enrichment-progress"]);

    const isEnrichmentActive =
        enrichmentState?.status === "running" ||
        enrichmentState?.status === "paused";
    const totalFailures = failureCounts?.total || 0;

    return (
        <>
            <SettingsSection id="cache" title="Library Enrichment">
                {isProgressPending ? (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10 flex items-center gap-2">
                        <GradientSpinner size="sm" />
                        <span className="text-xs text-[var(--text-muted)]">Loading enrichment status...</span>
                    </div>
                ) : isProgressError && !enrichmentProgress ? (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-danger/20 flex items-center justify-between">
                        <span className="text-xs text-danger-light">Failed to load enrichment status</span>
                        <Button size="sm" onClick={() => refetchProgress()}>
                            Retry
                        </Button>
                    </div>
                ) : enrichmentProgress ? (
                    <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-medium text-white">
                                Enrichment Status
                            </h3>
                            {enrichmentProgress.coreComplete &&
                                !enrichmentProgress.isFullyComplete && (
                                    <span className="text-xs tabular-nums text-brand flex items-center gap-1">
                                        <GradientSpinner size="sm" />
                                        {backgroundStepRunning(enrichmentProgress)}
                                    </span>
                                )}
                            {enrichmentProgress.isFullyComplete && (
                                <span className="text-xs tabular-nums text-success flex items-center gap-1">
                                    <CheckCircle className="w-3 h-3" />
                                    Complete
                                </span>
                            )}
                        </div>

                        <div className="space-y-1">
                            <EnrichmentStage
                                icon={User}
                                label="Artist Metadata"
                                description="Bios, photos, genres, and similar artists from Wikipedia, Fanart.tv, Deezer, MusicBrainz, and ListenBrainz"
                                completed={enrichmentProgress.artists.completed}
                                total={enrichmentProgress.artists.total}
                                progress={enrichmentProgress.artists.progress}
                                failed={enrichmentProgress.artists.failed}
                            />

                            <EnrichmentStage
                                icon={Fingerprint}
                                label="Song Identification"
                                description="Which recording each song is, from AcoustID fingerprints and MusicBrainz"
                                completed={
                                    enrichmentProgress.trackTags.enriched
                                }
                                total={enrichmentProgress.trackTags.total}
                                progress={enrichmentProgress.trackTags.progress}
                                missing={enrichmentProgress.trackTags.waitingMissing}
                            />

                            {/* audioAnalysis is absent from the progress payload until the analyzer has run. */}
                            {!featuresLoading && musicCNN && enrichmentProgress.audioAnalysis ? (
                                <EnrichmentStage
                                    icon={Activity}
                                    label="Audio Analysis"
                                    description="Tempo, key, danceability, and mood readings from each song's audio"
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
                                    missing={enrichmentProgress.audioAnalysis.waitingMissing}
                                    isBackground={true}
                                />
                            ) : !featuresLoading ? (
                                <div className="opacity-50 py-2">
                                    <h4 className="text-sm font-medium text-[var(--text-secondary)]">Audio Analysis</h4>
                                    <p className="text-xs text-[var(--text-muted)]">Not available (lite mode)</p>
                                    <p className="text-xs text-[var(--text-muted)] mt-1">
                                        Service not detected -- check setup documentation
                                    </p>
                                </div>
                            ) : null}

                            {/* CLAP Embeddings, then the matching built on them */}
                            {!featuresLoading && vibeEmbeddings ? (
                                <>
                                    {enrichmentProgress.clapEmbeddings && (
                                        <EnrichmentStage
                                            icon={Waves}
                                            label="Vibe Embeddings"
                                            description="CLAP sound vectors for similarity search and moods"
                                            completed={enrichmentProgress.clapEmbeddings.completed}
                                            total={enrichmentProgress.clapEmbeddings.total}
                                            progress={enrichmentProgress.clapEmbeddings.progress}
                                            processing={enrichmentProgress.clapEmbeddings.processing}
                                            failed={enrichmentProgress.clapEmbeddings.failed}
                                            missing={enrichmentProgress.clapEmbeddings.waitingMissing}
                                            isBackground={true}
                                        />
                                    )}
                                    {enrichmentProgress.moods && (
                                        <EnrichmentStage
                                            icon={Smile}
                                            label="Moods"
                                            description="The 22 learned moods for each song, scored from its sound vector, behind the mood mixes, stations and song tags"
                                            completed={enrichmentProgress.moods.completed}
                                            total={enrichmentProgress.moods.total}
                                            progress={enrichmentProgress.moods.progress}
                                            isBackground={true}
                                        />
                                    )}
                                    {enrichmentProgress.similarity && (
                                        <EnrichmentStage
                                            icon={Network}
                                            label="Similarity"
                                            description="Matching from sound, feel and artist genre"
                                            completed={enrichmentProgress.similarity.completed}
                                            total={enrichmentProgress.similarity.total}
                                            progress={enrichmentProgress.similarity.progress}
                                            isBackground={true}
                                        />
                                    )}
                                </>
                            ) : !featuresLoading ? (
                                <div className="opacity-50 py-2">
                                    <h4 className="text-sm font-medium text-[var(--text-secondary)]">Vibe Similarity</h4>
                                    <p className="text-xs text-[var(--text-muted)]">Not available (lite mode)</p>
                                    <p className="text-xs text-[var(--text-muted)] mt-1">
                                        Service not detected -- check setup documentation
                                    </p>
                                </div>
                            ) : null}
                        </div>

                        <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-white/10">
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleSyncAndEnrich}
                                disabled={
                                    syncing || isEnrichmentActive
                                }
                            >
                                {syncing ? "Syncing..." : "Sync New"}
                            </Button>
                            <Button
                                size="sm"
                                onClick={() => setConfirmTarget("retryFailedAndBlocked")}
                                disabled={retryingAll || syncing || isEnrichmentActive}
                            >
                                {retryingAll ? "Queuing..." : "Retry what didn't work"}
                            </Button>
                            {currentUser?.role === "admin" && (
                                <Button
                                    size="sm"
                                    onClick={() => setConfirmTarget("redecideEverything")}
                                    disabled={redeciding || syncing || isEnrichmentActive}
                                >
                                    {redeciding ? "Queuing..." : "Start over on everything"}
                                </Button>
                            )}
                            {currentUser?.role === "admin" && (
                                <Button
                                    size="sm"
                                    onClick={() => setConfirmTarget("wipeAndRerun")}
                                    disabled={wiping}
                                    data-testid="enrichment-wipe"
                                >
                                    {wiping ? "Wiping..." : "Wipe and re-run"}
                                </Button>
                            )}
                            {currentUser?.role === "admin" && (
                                <span className="flex items-center gap-2">
                                    <label htmlFor="enrichment-rerun-step" className="sr-only">
                                        Step to re-run from
                                    </label>
                                    <select
                                        id="enrichment-rerun-step"
                                        value={rerunStep}
                                        onChange={(e) => setRerunStep(e.target.value as EnrichmentRerunStep)}
                                        disabled={rerunningStep}
                                        className="h-9 rounded-lg border border-white/10 bg-surface px-2 text-xs text-[var(--text-primary)] focus:border-[var(--color-brand)] focus:outline-none"
                                        data-testid="enrichment-rerun-select"
                                    >
                                        {RERUN_ORDER.map((step) => (
                                            <option key={step} value={step}>
                                                {RERUN_STEPS[step].label}
                                            </option>
                                        ))}
                                    </select>
                                    <Button
                                        size="sm"
                                        onClick={() => setRerunConfirmStep(rerunStep)}
                                        disabled={rerunningStep || wiping}
                                        data-testid="enrichment-rerun"
                                    >
                                        {rerunningStep ? "Starting..." : "Re-run from"}
                                    </Button>
                                </span>
                            )}
                            {queueResult !== null && (
                                <span className="self-center text-xs text-success" data-testid="enrichment-queue-result">
                                    {queueResult === "wipe" ? "Wiped. Re-running." : "Queued"}
                                </span>
                            )}

                            {isEnrichmentActive && (
                                <>
                                    {enrichmentState?.status === "running" ? (
                                        <button
                                            onClick={handlePause}
                                            className="flex items-center gap-1.5 px-3 py-2.5 min-h-[44px] text-xs tabular-nums bg-warning/20 border border-warning/30 text-warning rounded-lg
                                            hover:bg-warning/30 transition-colors"
                                        >
                                            <Pause className="w-3 h-3" />
                                            Pause
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleResume}
                                            className="flex items-center gap-1.5 px-3 py-2.5 min-h-[44px] text-xs tabular-nums bg-success/20 border border-success/30 text-success rounded-lg
                                            hover:bg-success/30 transition-colors"
                                        >
                                            <Play className="w-3 h-3" />
                                            Resume
                                        </button>
                                    )}
                                    <button
                                        onClick={handleStop}
                                        className="flex items-center gap-1.5 px-3 py-2.5 min-h-[44px] text-xs tabular-nums bg-danger/20 border border-danger/30 text-danger-light rounded-lg
                                        hover:bg-danger/30 transition-colors"
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
                                    className="flex items-center gap-2 text-xs tabular-nums text-danger-light/70 hover:brightness-125 transition-colors"
                                >
                                    <AlertTriangle className="w-3 h-3" />
                                    {showInlineFailures ? "Hide" : "Show"} Failures ({totalFailures})
                                    <ChevronDown className={`w-3 h-3 transition-transform ${showInlineFailures ? "rotate-180" : ""}`} />
                                </button>
                                {showInlineFailures && <EnrichmentFailuresList active={enrichmentActive} />}
                            </div>
                        )}

                        <div aria-live="polite" aria-atomic="true">
                            {enrichmentState &&
                                enrichmentState.status !== "idle" && (
                                    <div className="mt-3 p-2 bg-white/[0.02] rounded-lg border border-white/5 text-xs">
                                        {enrichmentState.hung ? (
                                            <>
                                                <div className="flex items-center gap-2">
                                                    <AlertTriangle className="w-3 h-3 text-danger-light" />
                                                    <span className="text-danger-light font-medium">
                                                        Enrichment appears
                                                        stalled
                                                    </span>
                                                </div>
                                                <p className="mt-1 text-[var(--text-secondary)]">
                                                    Status is &quot;running&quot;
                                                    but nothing has completed
                                                    for over 15 minutes. The
                                                    audio analyzer may be down
                                                    or the work queue wedged --
                                                    check the analyzer container
                                                    and the enrichment error
                                                    list below.
                                                </p>
                                            </>
                                        ) : (
                                            <>
                                        <div className="flex items-center gap-2">
                                            {enrichmentState.status ===
                                                "running" && (
                                                <GradientSpinner size="sm" />
                                            )}
                                            {enrichmentState.status ===
                                                "paused" && (
                                                <Pause className="w-3 h-3 text-warning" />
                                            )}
                                            {enrichmentState.status ===
                                                "stopping" && (
                                                <StopCircle className="w-3 h-3 text-danger-light animate-pulse" />
                                            )}
                                            <span className="text-[var(--text-secondary)] tabular-nums">
                                                {enrichmentState.status ===
                                                    "running" &&
                                                    `Processing ${phaseLabel(enrichmentState.currentPhase)}...`}
                                                {enrichmentState.status ===
                                                "paused" && "Enrichment paused"}
                                                {enrichmentState.status ===
                                                    "stopping" &&
                                                    "Stopping..."}
                                            </span>
                                        </div>
                                            </>
                                        )}
                                    </div>
                                )}
                        </div>
                    </div>
                ) : null}

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
                            aria-label="User cache size"
                            value={settings.maxCacheSizeMb}
                            onChange={(e) =>
                                onUpdate({
                                    maxCacheSizeMb: parseInt(e.target.value),
                                })
                            }
                            className={sliderClass}
                        />
                        <span className="text-xs tabular-nums text-[var(--text-secondary)] w-16 text-right">
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
                            aria-label="Transcode cache size"
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
                        <span className="text-xs tabular-nums text-[var(--text-secondary)] w-16 text-right">
                            {settings.transcodeCacheMaxGb} GB
                        </span>
                    </div>
                </SettingsRow>

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

                {settings.autoEnrichMetadata && (
                    <SettingsRow
                        label="Metadata Fetch Speed"
                        description="Parallel MusicBrainz/enrichment requests for artist bios and song identification"
                    >
                        <div className="flex items-center gap-3">
                            <input
                                type="range"
                                min={1}
                                max={5}
                                aria-label="Metadata Fetch Speed"
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
                                    <span className="text-xs text-[var(--text-muted)] w-24 text-right">
                                        Loading...
                                    </span>
                                ) : (
                                    <>
                                        <span className="text-xs tabular-nums text-[var(--text-secondary)] w-24 text-right">
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
                                            <span className="text-xs tabular-nums text-[var(--text-muted)] w-24 text-right">
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

                {settings.autoEnrichMetadata && !featuresLoading && musicCNN && (
                    <WorkerSliderRow
                        label="Audio Analysis Workers"
                        description="CPU workers for Essentia ML analysis"
                        {...analysisWorkers}
                    />
                )}

                {settings.autoEnrichMetadata && !featuresLoading && vibeEmbeddings && (
                    <WorkerSliderRow
                        label="Vibe Embedding Workers"
                        description="CPU workers for CLAP embeddings (vibe similarity)"
                        {...clapWorkers}
                    />
                )}

                {settings.autoEnrichMetadata && !featuresLoading && musicCNN && vibeEmbeddings && (
                    <SettingsRow label={BOTH_AT_ONCE_LABEL} description={BOTH_AT_ONCE_DESCRIPTION} htmlFor="analysis-together">
                        <BothAtOnceSwitch id="analysis-together" />
                    </SettingsRow>
                )}

                {/* Each GPU switch row shows only measured state; on hosts the
                    CUDA runtime cannot exist for (arm, macOS), the rows are
                    not offered at all. */}
                {settings.autoEnrichMetadata && !featuresLoading && vibeEmbeddings && gpuStatus?.supported && (
                    <GpuSwitchRow
                        id="gpu-onnx-toggle"
                        label="NVIDIA GPU for vibe embeddings"
                        description="Run vibe embeddings on an NVIDIA GPU. Downloads about 2 GB of pinned packages into the data directory (they take about 3.4 GB) the first time. Applies on its own within a minute: the analyzer finishes the songs it is on, then restarts."
                        gpu={gpuStatus ?? null}
                        on={gpuStatus?.enabled ?? false}
                        effective={gpuStatus?.effective ?? false}
                        fellBack={gpuStatus?.fellBack ?? false}
                        pending={setGpuMutation.isPending}
                        onChange={(checked) => setGpuMutation.mutate(checked)}
                    />
                )}
                {settings.autoEnrichMetadata && !featuresLoading && musicCNN && gpuStatus?.supported && (
                    <GpuSwitchRow
                        id="gpu-analysis-toggle"
                        label="NVIDIA GPU for audio analysis"
                        description="Run the mood, valence and arousal models on an NVIDIA GPU. Uses the same download as vibe embeddings. Applies on its own within a minute: the analyzer finishes the songs it is on, then restarts."
                        gpu={gpuStatus ?? null}
                        on={gpuStatus?.analysis ?? false}
                        effective={gpuStatus?.analysisEffective ?? false}
                        fellBack={gpuStatus?.analysisFellBack ?? false}
                        pending={setGpuAnalysisMutation.isPending}
                        onChange={(checked) => setGpuAnalysisMutation.mutate(checked)}
                    />
                )}

                <div className="mt-6 rounded-lg border border-white/10 overflow-hidden">
                    <button
                        onClick={() => setMaintenanceOpen((o) => !o)}
                        aria-expanded={maintenanceOpen}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white/[0.03] hover:bg-white/[0.06] transition-colors text-left"
                    >
                        <div>
                            <span className="text-xs text-[var(--text-secondary)]">
                                Maintenance Operations
                            </span>
                            <p className="text-xs text-[var(--text-muted)] mt-0.5">
                                Cache clearing, stale job cleanup, failed-analysis retry
                            </p>
                        </div>
                        <ChevronDown
                            className={`w-4 h-4 text-[var(--text-muted)] transition-transform shrink-0 ${maintenanceOpen ? "rotate-180" : ""}`}
                        />
                    </button>

                    {maintenanceOpen && (
                        <div className="px-4 pt-3 pb-4 space-y-3 border-t border-white/10">
                            <Button size="sm" onClick={handleClearCaches} disabled={clearingCaches}>
                                {clearingCaches ? "Clearing..." : "Clear All Caches"}
                            </Button>
                            <Button size="sm" onClick={handleCleanupStaleJobs} disabled={cleaningStaleJobs}>
                                {cleaningStaleJobs ? "Cleaning..." : "Cleanup Stale Jobs"}
                            </Button>
                            {((enrichmentProgress?.audioAnalysis?.failed ?? 0) > 0 || (enrichmentProgress?.audioAnalysis?.permanentlyFailed ?? 0) > 0) && (
                                <Button
                                    size="sm"
                                    onClick={handleRetryFailedAnalysis}
                                    disabled={retryingFailed || isEnrichmentActive}
                                >
                                    {retryingFailed
                                        ? "Retrying..."
                                        : `Retry Failed Analysis (${(enrichmentProgress?.audioAnalysis?.failed || 0) + (enrichmentProgress?.audioAnalysis?.permanentlyFailed || 0)})`}
                                </Button>
                            )}

                            {retryResult && (
                                <p className="text-xs tabular-nums text-success">
                                    Reset {retryResult.reset} failed tracks to pending
                                </p>
                            )}
                            {clearCachesResult && (
                                <p className="text-xs tabular-nums text-success">
                                    {clearCachesResult}
                                </p>
                            )}
                            {cleanupResult && cleanupResult.totalCleaned > 0 && (
                                <p className="text-xs tabular-nums text-success">
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
                                <p className="text-xs text-[var(--text-muted)]">
                                    No stale jobs found
                                </p>
                            )}
                        </div>
                    )}
                </div>
                {/* Outside the collapsible: every action in this section reports here. */}
                {error && <p role="alert" className="mt-2 px-1 text-xs tabular-nums text-danger-light">{error}</p>}
            </SettingsSection>

            {confirmTarget && (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setConfirmTarget(null)}
                    onConfirm={handleConfirmAction}
                    title={confirmMeta[confirmTarget].title}
                    message={confirmMeta[confirmTarget].message}
                    confirmText={confirmMeta[confirmTarget].confirmText}
                    cancelText="Cancel"
                    variant="danger"
                />
            )}
            {rerunConfirmStep && (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setRerunConfirmStep(null)}
                    onConfirm={() => {
                        const step = rerunConfirmStep;
                        setRerunConfirmStep(null);
                        void execRerunStep(step);
                    }}
                    title={`Re-run from ${RERUN_STEPS[rerunConfirmStep].label}?`}
                    message={
                        RERUN_STEPS[rerunConfirmStep].message +
                        (RERUN_STEPS[rerunConfirmStep].relaysMap
                            ? " The vibe map is laid out again when it finishes."
                            : " The vibe map stays as it is.") +
                        " Your music, playlists, plays, likes and edits stay."
                    }
                    confirmText="Re-run"
                    cancelText="Cancel"
                    variant="danger"
                />
            )}
        </>
    );
}
