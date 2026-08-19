"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import Image from "next/image";

function deriveProgress(p: number): number {
    return Math.min(p, 90);
}

function deriveSteps(p: number): string[] {
    const steps: string[] = [];
    if (p >= 15) steps.push("tracks");
    if (p >= 30) steps.push("library");
    if (p >= 50) steps.push("albums");
    if (p >= 70) steps.push("indexes");
    return steps;
}

function deriveMessage(p: number): string {
    if (p > 0 && p < 30) return "Discovering tracks...";
    if (p >= 30 && p < 60) return "Indexing albums...";
    if (p >= 60 && p < 90) return "Organizing artists...";
    if (p >= 90) return "Almost done...";
    return "Scanning your music library...";
}

export default function SyncPage() {
    useRouter();
    const queryClient = useQueryClient();
    const [initError, setInitError] = useState("");
    const [initFailed, setInitFailed] = useState(false);
    const [postScanDone, setPostScanDone] = useState(false);
    const [scanJobId, setScanJobId] = useState<string | null>(null);
    const handledRef = useRef(false);

    // Scan status: SSE updates populate cache, with API polling as fallback.
    // The scan can complete before SSE delivers the event (race condition),
    // so we poll the status endpoint every 2s until completed/failed.
    const { data: scanStatus } = useQuery<{
        status: string;
        progress: number;
        jobId: string;
        result?: { tracksAdded: number; tracksUpdated: number; tracksRemoved: number };
        error?: string;
    } | null>({
        queryKey: ["scan-status", scanJobId],
        queryFn: async () => {
            // Check if SSE already populated the cache
            const cached = queryClient.getQueryData<{
                status: string;
                progress: number;
                jobId: string;
            }>(["scan-status", scanJobId]);
            if (cached?.status === "completed" || cached?.status === "failed") {
                return cached;
            }
            // Poll the API as fallback
            try {
                const result = await api.getScanStatus(scanJobId!);
                return { ...result, jobId: scanJobId! };
            } catch {
                return cached ?? null;
            }
        },
        enabled: !!scanJobId,
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            if (status === "completed" || status === "failed") return false;
            return 500;
        },
        refetchOnWindowFocus: false,
    });

    // Derive display state from scanStatus (no setState in effects)
    const { progress, message, completedSteps, syncing, error } = useMemo(() => {
        if (initFailed) {
            return {
                progress: 0,
                message: "",
                completedSteps: [] as string[],
                syncing: false,
                error: initError,
            };
        }

        if (scanStatus?.status === "failed") {
            return {
                progress: 0,
                message: "",
                completedSteps: [] as string[],
                syncing: false,
                error: "Scan failed. You can skip and try again later.",
            };
        }

        if (scanStatus?.status === "completed") {
            return {
                progress: postScanDone ? 100 : 90,
                message: postScanDone ? "All set! Redirecting..." : "Syncing audiobooks...",
                completedSteps: ["tracks", "library", "albums", "indexes"],
                syncing: true,
                error: "",
            };
        }

        if (scanStatus?.status === "active") {
            const p = scanStatus.progress || 0;
            return {
                progress: deriveProgress(p),
                message: deriveMessage(p),
                completedSteps: deriveSteps(p),
                syncing: true,
                error: "",
            };
        }

        return {
            progress: 0,
            message: "Scanning your music library...",
            completedSteps: [] as string[],
            syncing: true,
            error: "",
        };
    }, [scanStatus, postScanDone, initFailed, initError]);

    // Start scan on mount
    useEffect(() => {
        let mounted = true;

        const startSync = async () => {
            try {
                const scanResult = await api.scanLibrary();
                if (!mounted) return;
                setScanJobId(scanResult.jobId);
            } catch (err: unknown) {
                console.error("Sync error:", err);
                if (!mounted) return;
                setInitError("Failed to start sync. You can skip and start manually later.");
                setInitFailed(true);
            }
        };

        startSync();
        return () => { mounted = false; };
    }, []);

    // Handle post-scan side effects (audiobook sync, redirect)
    useEffect(() => {
        if (!scanStatus || handledRef.current) return;
        if (scanStatus.status !== "completed") return;

        handledRef.current = true;

        (async () => {
            try {
                await api.post("/audiobooks/sync");
            } catch (audiobookError) {
                console.error("Audiobook sync failed:", audiobookError);
            }

            setPostScanDone(true);
            setTimeout(() => {
                window.location.href = "/";
            }, 1500);
        })();
    }, [scanStatus]);

    const handleSkip = () => {
        window.location.href = "/";
    };

    const steps = [
        { id: "tracks", label: "Scanning tracks" },
        { id: "library", label: "Building library" },
        { id: "albums", label: "Organizing albums" },
        { id: "indexes", label: "Creating indexes" },
    ];

    return (
        <div className="min-h-screen w-full relative overflow-hidden">
            {/* Dark background (matches onboarding) */}
            <div className="absolute inset-0 bg-[#000]">
                <div className="absolute inset-0 bg-gradient-to-br from-brand/5 via-transparent to-transparent" />
            </div>

            {/* Main content */}
            <div className="relative z-(--z-raised) min-h-screen flex items-center justify-center p-6">
                <div className="w-full max-w-lg">
                    {/* Logo/Brand -- matches onboarding header */}
                    <div className="text-center mb-8">
                        <div className="inline-flex items-center gap-4 mb-4">
                            <div className="relative">
                                <div className="absolute inset-0 bg-white/10 blur-xl rounded-full" />
                                <Image
                                    src="/assets/images/kima.webp"
                                    alt="Kima"
                                    width={48}
                                    height={48}
                                    className="relative z-(--z-raised) drop-shadow-2xl"
                                />
                            </div>
                            <h1 className="text-4xl font-bold text-white">
                                Kima Hub
                            </h1>
                        </div>
                    </div>

                    {/* Sync card -- same aesthetic as onboarding card */}
                    <div className="bg-[#111]/90 rounded-lg border border-white/10 shadow-xl overflow-hidden">
                        <div className="p-6 md:p-8 space-y-6">
                            {/* Title + status message */}
                            <div>
                                <h2 className="text-2xl font-bold text-white mb-1">
                                    {syncing ? "Setting Things Up" : "Ready to Go!"}
                                </h2>
                                <p className="text-[var(--text-secondary)]">
                                    {error || message}
                                </p>
                            </div>

                            {/* Progress bar */}
                            {syncing && !error && (
                                <div className="space-y-2">
                                    <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                                        <div
                                            className="h-full bg-brand transition-all duration-500 ease-out rounded-full"
                                            style={{ width: `${progress}%` }}
                                        />
                                    </div>
                                    <p className="text-xs text-[var(--text-muted)] text-center">
                                        {progress}% complete
                                    </p>
                                </div>
                            )}

                            {/* Error state */}
                            {error && (
                                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                                    <p className="text-red-400 text-sm">
                                        {error}
                                    </p>
                                </div>
                            )}

                            {/* Steps list */}
                            <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/10">
                                {steps.map((step) => {
                                    const isComplete = completedSteps.includes(step.id);
                                    return (
                                        <div
                                            key={step.id}
                                            className="flex items-center gap-2 text-sm"
                                        >
                                            <div
                                                className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                                                    isComplete
                                                        ? "bg-brand/20"
                                                        : "bg-white/10"
                                                }`}
                                            >
                                                {isComplete && (
                                                    <svg
                                                        className="w-2.5 h-2.5 text-brand"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        viewBox="0 0 24 24"
                                                    >
                                                        <path
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                            strokeWidth={3}
                                                            d="M5 13l4 4L19 7"
                                                        />
                                                    </svg>
                                                )}
                                            </div>
                                            <span
                                                className={
                                                    isComplete
                                                        ? "text-[var(--text-secondary)] font-medium"
                                                        : "text-[var(--text-muted)]"
                                                }
                                            >
                                                {step.label}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {/* Skip button */}
                    <div className="flex justify-end mt-4">
                        <button
                            onClick={handleSkip}
                            className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-white/70 transition-colors focus:outline-none focus:ring-2 focus:ring-brand/30 rounded"
                        >
                            Skip for now
                        </button>
                    </div>

                    {/* Footer note */}
                    <p className="text-center text-[var(--text-muted)] text-xs mt-6">
                        Enrichment and metadata analysis will continue in the background once you&apos;re in.
                    </p>
                </div>
            </div>
        </div>
    );
}
