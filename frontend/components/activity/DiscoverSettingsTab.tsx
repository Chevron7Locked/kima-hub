"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { Trash2, Loader2, ArrowLeft } from "lucide-react";
import type { DiscoverConfig } from "@/features/discover/types";

interface ConfigSliderProps {
    label: string;
    display: ReactNode;
    unit?: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (value: number) => void;
    caption: string;
}

function ConfigSlider({ label, display, unit, min, max, step, value, onChange, caption }: ConfigSliderProps) {
    return (
        <div>
            <label className="block text-xs text-[var(--text-muted)] mb-4">{label}</label>
            <div className="border border-white/10 p-4 mb-3">
                <div className="flex items-baseline justify-between">
                    <span className="text-4xl font-bold text-brand tabular-nums">{display}</span>
                    {unit && <span className="text-xs text-[var(--text-muted)]">{unit}</span>}
                </div>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                className="w-full h-1 bg-white/10 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white/20 hover:[&::-webkit-slider-thumb]:bg-white"
            />
            <p className="text-xs tabular-nums text-[var(--text-muted)] mt-3">{caption}</p>
        </div>
    );
}

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
    const [isClearing, setIsClearing] = useState(false);
    const debounceRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, []);

    function handleConfigChange<K extends keyof DiscoverConfig>(
        key: K,
        value: DiscoverConfig[K]
    ) {
        if (config) {
            onUpdateConfig({ ...config, [key]: value });
        }

        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
        }
        debounceRef.current = setTimeout(async () => {
            try {
                await api.updateDiscoverConfig({ [key]: value });
            } catch {
                notify.error("Failed to save setting");
            }
        }, 500);
    }

    async function handleClearPlaylist() {
        if (isClearing) return;

        const confirmed = window.confirm(
            "clear discovery playlist?\n\n" +
                "• liked albums will be moved to your library\n" +
                "• non-liked albums will be deleted\n\n" +
                "this action cannot be undone."
        );

        if (!confirmed) return;

        setIsClearing(true);
        try {
            const result = await api.clearDiscoverPlaylist();

            const albums = (n: number) => `${n} album${n !== 1 ? "s" : ""}`;
            const kept = result.lidarrFailed?.length ?? 0;
            const parts = [
                result.likedMoved > 0 && `Moved ${albums(result.likedMoved)} you liked to your library.`,
                result.activeDeleted > 0 && `Deleted ${albums(result.activeDeleted)}.`,
                // Lidarr refusing, a file Kima could not delete, or Lidarr off: the server's own alert lists them and why.
                kept > 0 && `Kept ${albums(kept)} the clear could not finish; the alert says why.`,
            ].filter(Boolean);
            notify.info("Discover playlist cleared", {
                message: parts.length > 0 ? parts.join(" ") : "There were no albums to clear.",
            });

            onPlaylistCleared?.();
        } catch {
            notify.error("Failed to clear playlist");
        } finally {
            setIsClearing(false);
        }
    }

    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]">
            <div className="flex items-center gap-3 px-5 py-4 border-b-2 border-white/20">
                <button
                    onClick={onBack}
                    className="border border-white/20 p-2 hover:border-brand hover:bg-white/5 transition-colors"
                    title="back to activity"
                >
                    <ArrowLeft className="w-4 h-4 text-[var(--text-secondary)]" />
                </button>
                <h3 className="text-sm font-bold text-white">Settings</h3>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-8">
                <ConfigSlider
                    label="Playlist Size"
                    display={config?.playlistSize || 10}
                    unit="tracks"
                    min={5}
                    max={50}
                    step={5}
                    value={config?.playlistSize || 10}
                    onChange={(value) => handleConfigChange("playlistSize", value)}
                    caption="One track per album / Larger = more discovery"
                />

                <ConfigSlider
                    label="Download Buffer"
                    display={`${((config?.downloadRatio ?? 1.3) * 100 - 100).toFixed(0)}%`}
                    unit="extra"
                    min={1}
                    max={2}
                    step={0.1}
                    value={config?.downloadRatio ?? 1.3}
                    onChange={(value) => handleConfigChange("downloadRatio", value)}
                    caption="Redundancy for failed downloads / Higher = more reliable"
                />

                <ConfigSlider
                    label="Album Exclusion"
                    display={(config?.exclusionMonths ?? 6) === 0 ? "--" : config?.exclusionMonths ?? 6}
                    unit={(config?.exclusionMonths ?? 6) !== 0 ? "months" : undefined}
                    min={0}
                    max={12}
                    step={1}
                    value={config?.exclusionMonths ?? 6}
                    onChange={(value) => handleConfigChange("exclusionMonths", value)}
                    caption="Cooldown period for repeat recommendations / 0 = disabled"
                />

                <div className="pt-6 border-t-2 border-white/20">
                    <label className="block text-xs text-[var(--text-muted)] mb-4">
                        Danger Zone
                    </label>
                    <p className="text-xs text-[var(--text-muted)] mb-4 leading-relaxed">
                        Remove current playlist / Liked albums → library / Others → deleted
                    </p>
                    <button
                        onClick={handleClearPlaylist}
                        disabled={isClearing}
                        className="w-full flex items-center justify-center gap-3 px-4 py-3 border-2 border-danger/30 hover:border-danger hover:bg-danger/10 text-danger-light transition-all disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-xs"
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
