"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import Image from "next/image";
import { dispatchQueryEvent } from "@/lib/query-events";

export default function SyncPage() {
    const router = useRouter();
    const [syncing, setSyncing] = useState(true);
    const [progress, setProgress] = useState(0);
    const [message, setMessage] = useState("Scanning your music library...");
    const [error, setError] = useState("");
    const [completedSteps, setCompletedSteps] = useState<string[]>([]);

    useEffect(() => {
        let mounted = true;
        let pollInterval: NodeJS.Timeout | null = null;
        let redirectTimeout: NodeJS.Timeout | null = null;

        const startSync = async () => {
            try {
                // Start the library scan
                const scanResult = await api.scanLibrary();
                const jobId = scanResult.jobId;

                if (!mounted) return;
                setMessage("Scanning your music library...");

                // Poll for actual scan progress
                pollInterval = setInterval(async () => {
                    try {
                        const status = await api.getScanStatus(jobId);

                        if (!mounted) {
                            if (pollInterval) clearInterval(pollInterval);
                            return;
                        }

                        if (status.status === "completed") {
                            if (pollInterval) clearInterval(pollInterval);
                            setProgress(90);
                            setCompletedSteps(["tracks", "library", "albums", "indexes"]);

                            // Trigger post-scan operations
                            try {
                                // 1. Audiobook sync
                                setMessage("Syncing audiobooks...");
                                await api.post("/audiobooks/sync");
                            } catch (audiobookError) {
                                console.error("Audiobook sync failed:", audiobookError);
                                // Don't fail the whole flow if audiobook sync fails
                            }

                            if (!mounted) return;
                            setProgress(95);

                            // Enrichment runs on-demand from Settings page
                            // Artists get images from Deezer/Fanart when first viewed

                            // Dispatch event to update Recently Added section
                            dispatchQueryEvent("library-updated");

                            setProgress(100);
                            setMessage("All set! Redirecting...");
                            redirectTimeout = setTimeout(() => {
                                // Use window.location for full page reload to ensure fresh data
                                window.location.href = "/";
                            }, 1500);
                        } else if (status.status === "failed") {
                            if (pollInterval) clearInterval(pollInterval);
                            setError(
                                "Scan failed. You can skip and try again later."
                            );
                            setSyncing(false);
                        } else {
                            // Update progress based on actual scan progress
                            setProgress(Math.min(status.progress || 0, 90)); // Cap at 90% to reserve last 10% for audiobooks

                            // Update completed steps based on progress
                            const steps: string[] = [];
                            if (status.progress >= 15) steps.push("tracks");
                            if (status.progress >= 30) steps.push("library");
                            if (status.progress >= 50) steps.push("albums");
                            if (status.progress >= 70) steps.push("indexes");
                            setCompletedSteps(steps);

                            if (status.progress > 0 && status.progress < 30) {
                                setMessage("Discovering tracks...");
                            } else if (
                                status.progress >= 30 &&
                                status.progress < 60
                            ) {
                                setMessage("Indexing albums...");
                            } else if (
                                status.progress >= 60 &&
                                status.progress < 90
                            ) {
                                setMessage("Organizing artists...");
                            } else if (status.progress >= 90) {
                                setMessage("Almost done...");
                            }
                        }
                    } catch (pollError) {
                        console.error("Error polling scan status:", pollError);
                    }
                }, 1000); // Poll every second
            } catch (err: any) {
                console.error("Sync error:", err);
                if (!mounted) return;
                setError(
                    "Failed to start sync. You can skip and start manually later."
                );
                setSyncing(false);
            }
        };

        startSync();

        return () => {
            mounted = false;
            if (pollInterval) {
                clearInterval(pollInterval);
            }
            if (redirectTimeout) {
                clearTimeout(redirectTimeout);
            }
        };
    }, []);

    const handleSkip = () => {
        // Use window.location for full page reload to ensure fresh data
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
            {/* Black background with subtle amber accent */}
            <div className="absolute inset-0 bg-[#000]">
                <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 via-transparent to-transparent" />
                <div className="absolute bottom-0 right-0 w-1/2 h-1/2 bg-gradient-to-tl from-amber-500/3 via-transparent to-transparent" />
            </div>

            {/* Main content */}
            <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
                <div className="w-full max-w-lg">
                    {/* Sync card */}
                    <div className="bg-white/[0.02] backdrop-blur-sm rounded-2xl border border-white/[0.06] p-8">
                        <div className="space-y-6">
                            {/* Logo and Title */}
                            <div className="text-center space-y-3">
                                <div className="flex justify-center">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-white/10 blur-xl rounded-full" />
                                        <Image
                                            src="/assets/images/LIDIFY.webp"
                                            alt="Lidify"
                                            width={80}
                                            height={80}
                                            className="relative z-10"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <h2 className="text-xl font-semibold text-white">
                                        {syncing ? "Setting Things Up" : "Ready to Go!"}
                                    </h2>
                                    <p className="text-white/50 text-sm mt-1">
                                        {error || message}
                                    </p>
                                </div>
                            </div>

                            {/* Progress bar */}
                            {syncing && !error && (
                                <div className="space-y-2">
                                    <div className="w-full bg-white/[0.06] rounded-full h-1.5 overflow-hidden">
                                        <div
                                            className="h-full bg-amber-500 transition-all duration-500 ease-out rounded-full"
                                            style={{ width: `${progress}%` }}
                                        />
                                    </div>
                                    <p className="text-xs text-white/40 text-center">
                                        {progress}% complete
                                    </p>
                                </div>
                            )}

                            {/* Error state */}
                            {error && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                                    <p className="text-red-400 text-sm text-center">
                                        {error}
                                    </p>
                                </div>
                            )}

                            {/* Steps list */}
                            <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/[0.06]">
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
                                                        ? "bg-amber-500/20"
                                                        : "bg-white/[0.06]"
                                                }`}
                                            >
                                                {isComplete && (
                                                    <svg
                                                        className="w-2.5 h-2.5 text-amber-500"
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
                                                        ? "text-white/70"
                                                        : "text-white/40"
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
                            className="px-4 py-2 text-sm text-white/50 hover:text-white/70 transition-colors"
                        >
                            Skip for Now →
                        </button>
                    </div>

                    {/* Footer note */}
                    <p className="text-center text-white/30 text-xs mt-6">
                        This may take a few minutes for large libraries
                    </p>
                </div>
            </div>
        </div>
    );
}
