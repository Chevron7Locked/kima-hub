"use client";

import { useAudioState, AudioFeatures } from "@/lib/audio-state-context";
import { cn } from "@/utils/cn";
import { useMemo, useState, useEffect, useRef, memo } from "react";
import { X, Maximize2, Minimize2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
    ResponsiveContainer,
    RadarChart,
    PolarGrid,
    PolarAngleAxis,
    Radar,
} from "recharts";

// Extended feature interface for all enhanced vibe data
interface ExtendedFeatures extends AudioFeatures {
    danceabilityMl?: number | null;
}

// Feature configurations for radar chart
const RADAR_FEATURES = [
    { key: "energy", label: "Energy", min: 0, max: 1 },
    { key: "valence", label: "Mood", min: 0, max: 1 },
    { key: "arousal", label: "Arousal", min: 0, max: 1 },
    { key: "danceability", label: "Dance", min: 0, max: 1 },
    { key: "bpm", label: "Tempo", min: 60, max: 200 },
    { key: "moodHappy", label: "Happy", min: 0, max: 1 },
    { key: "moodSad", label: "Sad", min: 0, max: 1 },
    { key: "moodRelaxed", label: "Relaxed", min: 0, max: 1 },
    { key: "moodAggressive", label: "Aggressive", min: 0, max: 1 },
    { key: "moodParty", label: "Party", min: 0, max: 1 },
    { key: "moodAcoustic", label: "Acoustic", min: 0, max: 1 },
    { key: "moodElectronic", label: "Electronic", min: 0, max: 1 },
];

const ML_MOODS = [
    { key: "moodHappy", label: "Happy", color: "#ecb200" },
    { key: "moodSad", label: "Sad", color: "#5c8dd6" },
    { key: "moodRelaxed", label: "Relaxed", color: "#1db954" },
    { key: "moodAggressive", label: "Aggressive", color: "#e35656" },
    { key: "moodParty", label: "Party", color: "#e056a0" },
    { key: "moodAcoustic", label: "Acoustic", color: "#d4a656" },
    { key: "moodElectronic", label: "Electronic", color: "#a056e0" },
];

interface EnhancedVibeOverlayProps {
    className?: string;
    currentTrackFeatures?: ExtendedFeatures | null;
    variant?: "floating" | "inline";
    onClose?: () => void;
}

// Helper to normalize values
function normalizeValue(
    value: number | null | undefined,
    min: number,
    max: number
): number {
    if (value == null) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

// Helper to get feature value safely
function getFeatureValue(
    features: ExtendedFeatures | null | undefined,
    key: string
): number | null {
    if (!features) return null;
    const value = (features as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
    return null;
}

// Audio waveform visualization component - slower, smoother animation
const AudioWaveform = memo(function AudioWaveform({
    energy,
    bpm,
}: {
    energy: number;
    bpm: number;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animationRef = useRef<number | null>(null);
    const timeRef = useRef(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const resize = () => {
            canvas.width = canvas.offsetWidth * 2;
            canvas.height = canvas.offsetHeight * 2;
            ctx.scale(2, 2);
        };
        resize();

        const animate = () => {
            if (document.hidden) {
                animationRef.current = requestAnimationFrame(animate);
                return;
            }

            const width = canvas.offsetWidth;
            const height = canvas.offsetHeight;

            ctx.clearRect(0, 0, width, height);

            // Calculate wave parameters based on audio features - SLOWER
            const baseAmplitude = height * 0.35 * Math.max(0.3, energy);
            const frequency = (bpm / 120) * 0.015; // Reduced frequency
            const speed = (bpm / 120) * 0.015; // Slower speed (was 0.05)

            // Draw multiple layered waves with #ecb200 accent
            for (let layer = 0; layer < 3; layer++) {
                const layerOffset = layer * 0.4;
                const layerAmplitude = baseAmplitude * (1 - layer * 0.2);
                const alpha = 0.5 - layer * 0.12;

                ctx.beginPath();
                ctx.moveTo(0, height / 2);

                for (let x = 0; x <= width; x += 2) {
                    const y =
                        height / 2 +
                        Math.sin(
                            (x * frequency + timeRef.current * speed + layerOffset) *
                                Math.PI
                        ) *
                            layerAmplitude +
                        Math.sin(
                            (x * frequency * 1.5 + timeRef.current * speed * 0.8) *
                                Math.PI
                        ) *
                            (layerAmplitude * 0.25);
                    ctx.lineTo(x, y);
                }

                ctx.strokeStyle = "#ecb200";
                ctx.globalAlpha = alpha;
                ctx.lineWidth = 2 - layer * 0.4;
                ctx.stroke();
            }

            // Draw glow effect
            ctx.globalAlpha = 0.15;
            ctx.filter = "blur(10px)";
            ctx.beginPath();
            ctx.moveTo(0, height / 2);
            for (let x = 0; x <= width; x += 2) {
                const y =
                    height / 2 +
                    Math.sin((x * frequency + timeRef.current * speed) * Math.PI) *
                        baseAmplitude;
                ctx.lineTo(x, y);
            }
            ctx.strokeStyle = "#ecb200";
            ctx.lineWidth = 8;
            ctx.stroke();
            ctx.filter = "none";
            ctx.globalAlpha = 1;

            timeRef.current += 1;
            animationRef.current = requestAnimationFrame(animate);
        };

        animate();

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [energy, bpm]);

    return (
        <canvas
            ref={canvasRef}
            className="w-full h-14"
            style={{ opacity: 0.7 }}
        />
    );
});

export function EnhancedVibeOverlay({
    className,
    currentTrackFeatures,
    variant = "floating",
    onClose,
}: EnhancedVibeOverlayProps) {
    const { vibeMode, vibeSourceFeatures } = useAudioState();
    const [isExpanded, setIsExpanded] = useState(true);
    const [viewMode, setViewMode] = useState<"full" | "minimal">("full");

    // Use vibeSourceFeatures as the source
    const sourceFeatures = vibeSourceFeatures as ExtendedFeatures | null;
    // Current features should be from the actual current track, NOT fallback to source
    const currentFeatures = currentTrackFeatures as ExtendedFeatures | null;
    // For display, use currentFeatures if available, otherwise show source (for first track)
    const displayFeatures = currentFeatures || sourceFeatures;

    // Prepare radar chart data
    const radarData = useMemo(() => {
        return RADAR_FEATURES.map((feature) => {
            const sourceVal = getFeatureValue(sourceFeatures, feature.key);
            // For current, use displayFeatures (falls back to source if current is null)
            const currentVal = getFeatureValue(displayFeatures, feature.key);

            return {
                feature: feature.label,
                source: normalizeValue(sourceVal, feature.min, feature.max) * 100,
                current: normalizeValue(currentVal, feature.min, feature.max) * 100,
                fullMark: 100,
            };
        });
    }, [sourceFeatures, displayFeatures]);

    // Calculate overall match score using cosine similarity (same as backend)
    const matchScore = useMemo(() => {
        if (!sourceFeatures || !currentFeatures) return null;

        // Build feature vectors for cosine similarity
        const sourceVector: number[] = [];
        const currentVector: number[] = [];

        RADAR_FEATURES.forEach((feature) => {
            const sourceVal = getFeatureValue(sourceFeatures, feature.key);
            const currentVal = getFeatureValue(currentFeatures, feature.key);

            // Use 0.5 as default for missing values (neutral)
            const sourceNorm = normalizeValue(sourceVal ?? (feature.min + feature.max) / 2, feature.min, feature.max);
            const currentNorm = normalizeValue(currentVal ?? (feature.min + feature.max) / 2, feature.min, feature.max);

            // Weight ML mood features higher (1.3x) like backend does
            const weight = feature.key.startsWith("mood") ? 1.3 : 1.0;
            sourceVector.push(sourceNorm * weight);
            currentVector.push(currentNorm * weight);
        });

        // Calculate cosine similarity
        let dotProduct = 0;
        let magSource = 0;
        let magCurrent = 0;

        for (let i = 0; i < sourceVector.length; i++) {
            dotProduct += sourceVector[i] * currentVector[i];
            magSource += sourceVector[i] * sourceVector[i];
            magCurrent += currentVector[i] * currentVector[i];
        }

        const magnitude = Math.sqrt(magSource) * Math.sqrt(magCurrent);
        if (magnitude === 0) return null;

        const similarity = dotProduct / magnitude;
        return Math.round(similarity * 100);
    }, [sourceFeatures, currentFeatures]);

    // Get audio features for waveform - use current if available, fallback to source
    const energy = getFeatureValue(currentFeatures, "energy") ?? getFeatureValue(sourceFeatures, "energy") ?? 0.5;
    const bpm = getFeatureValue(currentFeatures, "bpm") ?? getFeatureValue(sourceFeatures, "bpm") ?? 120;

    // Don't render if not in vibe mode
    if (!vibeMode) return null;

    const isFloating = variant === "floating";

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 20, scale: 0.95 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className={cn(
                    // Spotify-inspired dark theme
                    "bg-[#121212] text-white relative overflow-hidden",
                    isFloating
                        ? "fixed bottom-24 right-4 z-[55] rounded-xl shadow-2xl w-[380px] border border-[#282828]"
                        : "rounded-xl w-full border border-[#282828]",
                    className
                )}
            >
                {/* Header */}
                <div
                    className={cn(
                        "flex items-center justify-between px-4 py-3 border-b border-[#282828] cursor-pointer",
                        isFloating && "hover:bg-[#1a1a1a] transition-colors"
                    )}
                    onClick={() => isFloating && setIsExpanded(!isExpanded)}
                >
                    <div className="flex items-center gap-3">
                        <motion.div
                            animate={{
                                boxShadow: [
                                    "0 0 8px #ecb200",
                                    "0 0 16px #ecb200",
                                    "0 0 8px #ecb200",
                                ],
                            }}
                            transition={{ duration: 2, repeat: Infinity }}
                            className="w-2.5 h-2.5 rounded-full bg-[#ecb200]"
                        />
                        <span className="text-sm font-semibold tracking-wide">
                            Vibe Analysis
                        </span>
                        {matchScore !== null && (
                            <span
                                className={cn(
                                    "text-xs font-bold px-2.5 py-1 rounded-full",
                                    matchScore >= 80
                                        ? "bg-[#1db954]/20 text-[#1db954]"
                                        : matchScore >= 60
                                        ? "bg-[#ecb200]/20 text-[#ecb200]"
                                        : "bg-[#e35656]/20 text-[#e35656]"
                                )}
                            >
                                {matchScore}% Match
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setViewMode(viewMode === "full" ? "minimal" : "full");
                            }}
                            className="p-2 rounded-full hover:bg-[#282828] transition-colors"
                            title={viewMode === "full" ? "Minimal view" : "Full view"}
                        >
                            {viewMode === "full" ? (
                                <Minimize2 className="w-4 h-4 text-[#b3b3b3]" />
                            ) : (
                                <Maximize2 className="w-4 h-4 text-[#b3b3b3]" />
                            )}
                        </button>

                        {isFloating && onClose && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClose();
                                }}
                                className="p-2 hover:bg-[#282828] rounded-full transition-colors"
                            >
                                <X className="w-4 h-4 text-[#b3b3b3]" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Content */}
                <AnimatePresence mode="wait">
                    {isExpanded && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                        >
                            {/* Waveform visualization */}
                            <div className="px-4 pt-3 pb-1">
                                <AudioWaveform energy={energy} bpm={bpm} />
                            </div>

                            {viewMode === "full" ? (
                                <div className="p-4 space-y-4">
                                    {/* Radar Chart */}
                                    <div className="h-[260px] w-full bg-[#181818] rounded-lg p-2">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <RadarChart
                                                data={radarData}
                                                margin={{ top: 20, right: 30, bottom: 20, left: 30 }}
                                            >
                                                <PolarGrid
                                                    stroke="#282828"
                                                    strokeDasharray="3 3"
                                                />
                                                <PolarAngleAxis
                                                    dataKey="feature"
                                                    tick={{
                                                        fill: "#b3b3b3",
                                                        fontSize: 10,
                                                        fontWeight: 500,
                                                    }}
                                                    tickLine={false}
                                                />
                                                {/* Source track (dashed yellow) */}
                                                <Radar
                                                    name="Source"
                                                    dataKey="source"
                                                    stroke="#ecb200"
                                                    fill="#ecb200"
                                                    fillOpacity={0.1}
                                                    strokeWidth={2}
                                                    strokeDasharray="5 5"
                                                />
                                                {/* Current track (solid white) */}
                                                <Radar
                                                    name="Current"
                                                    dataKey="current"
                                                    stroke="#ffffff"
                                                    fill="#ffffff"
                                                    fillOpacity={0.15}
                                                    strokeWidth={2}
                                                />
                                            </RadarChart>
                                        </ResponsiveContainer>
                                    </div>

                                    {/* Feature cards */}
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="bg-[#181818] rounded-lg p-3">
                                            <div className="text-[10px] text-[#b3b3b3] uppercase tracking-wider mb-1">
                                                Analysis Mode
                                            </div>
                                            <div className="text-sm font-semibold capitalize text-white">
                                                {sourceFeatures?.analysisMode || "Standard"}
                                            </div>
                                        </div>
                                        <div className="bg-[#181818] rounded-lg p-3">
                                            <div className="text-[10px] text-[#b3b3b3] uppercase tracking-wider mb-1">
                                                Tempo
                                            </div>
                                            <div className="text-sm font-semibold text-white">
                                                {bpm ? `${Math.round(bpm)} BPM` : "N/A"}
                                            </div>
                                        </div>
                                    </div>

                                    {/* ML Mood Spectrum - shows current track's moods */}
                                    <div className="bg-[#181818] rounded-lg p-4">
                                        <div className="text-[10px] text-[#b3b3b3] uppercase tracking-wider mb-3">
                                            Mood Spectrum {!currentFeatures && "(Source Track)"}
                                        </div>
                                        <div className="space-y-3">
                                            {ML_MOODS.map((mood) => {
                                                const value = getFeatureValue(
                                                    displayFeatures,
                                                    mood.key
                                                );
                                                // Show the bar even if value is 0, only hide if null/undefined
                                                const percentage = value != null ? Math.round(value * 100) : 0;
                                                const hasValue = value != null;

                                                return (
                                                    <div key={mood.key} className="flex items-center gap-3">
                                                        <div
                                                            className="w-2 h-2 rounded-full shrink-0"
                                                            style={{ backgroundColor: mood.color }}
                                                        />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex justify-between items-center mb-1.5">
                                                                <span className="text-xs text-[#b3b3b3]">
                                                                    {mood.label}
                                                                </span>
                                                                <span className="text-xs font-medium tabular-nums text-white">
                                                                    {hasValue ? `${percentage}%` : "—"}
                                                                </span>
                                                            </div>
                                                            <div className="w-full bg-[#282828] rounded-full h-1 overflow-hidden">
                                                                <motion.div
                                                                    initial={{ width: 0 }}
                                                                    animate={{
                                                                        width: hasValue ? `${Math.max(percentage, 2)}%` : "0%",
                                                                    }}
                                                                    transition={{
                                                                        duration: 0.6,
                                                                        ease: "easeOut",
                                                                    }}
                                                                    className="h-full rounded-full"
                                                                    style={{ backgroundColor: mood.color }}
                                                                />
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                /* Minimal view - just radar */
                                <div className="p-4">
                                    <div className="h-[180px] w-full bg-[#181818] rounded-lg p-2">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <RadarChart data={radarData}>
                                                <PolarGrid stroke="#282828" />
                                                <PolarAngleAxis
                                                    dataKey="feature"
                                                    tick={{ fill: "#b3b3b3", fontSize: 9 }}
                                                    tickLine={false}
                                                />
                                                <Radar
                                                    name="Source"
                                                    dataKey="source"
                                                    stroke="#ecb200"
                                                    fill="#ecb200"
                                                    fillOpacity={0.1}
                                                    strokeWidth={2}
                                                    strokeDasharray="5 5"
                                                />
                                                <Radar
                                                    name="Current"
                                                    dataKey="current"
                                                    stroke="#ffffff"
                                                    fill="#ffffff"
                                                    fillOpacity={0.15}
                                                    strokeWidth={2}
                                                />
                                            </RadarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                            )}

                            {/* Legend */}
                            <div className="flex items-center justify-center gap-6 py-3 border-t border-[#282828]">
                                <div className="flex items-center gap-2">
                                    <div className="w-4 h-0.5 bg-[#ecb200]" style={{ borderStyle: "dashed" }} />
                                    <span className="text-[10px] text-[#b3b3b3]">Source</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-4 h-2 rounded-sm bg-white/30" />
                                    <span className="text-[10px] text-[#b3b3b3]">Current</span>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </AnimatePresence>
    );
}
