"use client";

import { useAudioState, AudioFeatures } from "@/lib/audio-state-context";
import { cn } from "@/utils/cn";
import { useMemo, useState } from "react";
import {
    X,
    AudioWaveform,
    Music,
    Zap,
    Heart,
    Footprints,
    Gauge,
    Smile,
    Frown,
    Coffee,
    Flame,
    PartyPopper,
    Guitar,
    Radio,
} from "lucide-react";

interface VibeOverlayProps {
    className?: string;
    currentTrackFeatures?: AudioFeatures | null;
    variant?: "floating" | "inline";
    onClose?: () => void;
}

// Extended features for detailed analysis
interface ExtendedFeatures extends AudioFeatures {
    arousal?: number | null;
    instrumentalness?: number | null;
    acousticness?: number | null;
    // All 7 ML mood predictions
    moodHappy?: number | null;
    moodSad?: number | null;
    moodRelaxed?: number | null;
    moodAggressive?: number | null;
    moodParty?: number | null;
    moodAcoustic?: number | null;
    moodElectronic?: number | null;
    analysisMode?: string | null;
}

// Feature configuration with icons and descriptions
const FEATURE_CONFIG = [
    {
        key: "energy",
        label: "Energy",
        icon: Zap,
        min: 0,
        max: 1,
        description: "Intensity and power",
        lowLabel: "Calm",
        highLabel: "Intense",
        unit: null as string | null,
    },
    {
        key: "valence",
        label: "Mood",
        icon: Heart,
        min: 0,
        max: 1,
        description: "Emotional positivity",
        lowLabel: "Melancholic",
        highLabel: "Happy",
        unit: null as string | null,
    },
    {
        key: "danceability",
        label: "Groove",
        icon: Footprints,
        min: 0,
        max: 1,
        description: "Rhythm & movement",
        lowLabel: "Freeform",
        highLabel: "Danceable",
        unit: null as string | null,
    },
    {
        key: "bpm",
        label: "Tempo",
        icon: Gauge,
        min: 60,
        max: 180,
        description: "Beats per minute",
        lowLabel: "Slow",
        highLabel: "Fast",
        unit: "BPM" as string | null,
    },
    {
        key: "arousal",
        label: "Arousal",
        icon: AudioWaveform,
        min: 0,
        max: 1,
        description: "Excitement level",
        lowLabel: "Peaceful",
        highLabel: "Energetic",
        unit: null as string | null,
    },
];

// ML Mood predictions (Enhanced mode only)
const ML_MOOD_CONFIG = [
    { key: "moodHappy", label: "Happy", icon: Smile, color: "text-yellow-400" },
    { key: "moodSad", label: "Sad", icon: Frown, color: "text-blue-400" },
    {
        key: "moodRelaxed",
        label: "Relaxed",
        icon: Coffee,
        color: "text-green-400",
    },
    {
        key: "moodAggressive",
        label: "Aggressive",
        icon: Flame,
        color: "text-red-400",
    },
    {
        key: "moodParty",
        label: "Party",
        icon: PartyPopper,
        color: "text-pink-400",
    },
    {
        key: "moodAcoustic",
        label: "Acoustic",
        icon: Guitar,
        color: "text-amber-400",
    },
    {
        key: "moodElectronic",
        label: "Electronic",
        icon: Radio,
        color: "text-purple-400",
    },
];

function normalizeValue(
    value: number | null | undefined,
    min: number,
    max: number
): number {
    if (value === null || value === undefined) return 0;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function getMatchColor(diff: number): string {
    if (diff < 0.15) return "text-green-400";
    if (diff < 0.3) return "text-brand";
    return "text-red-400";
}

function getMatchBgColor(diff: number): string {
    if (diff < 0.15) return "bg-green-500/20";
    if (diff < 0.3) return "bg-brand/20";
    return "bg-red-500/20";
}

export function VibeOverlay({
    className,
    currentTrackFeatures,
    variant = "floating",
    onClose,
}: VibeOverlayProps) {
    const { vibeMode, vibeSourceFeatures } = useAudioState();
    const [isExpanded, setIsExpanded] = useState(true);

    // Calculate match scores for each feature
    const featureComparisons = useMemo(() => {
        if (!vibeSourceFeatures || !currentTrackFeatures) return null;

        return FEATURE_CONFIG.map((feature) => {
            const sourceVal = (vibeSourceFeatures as ExtendedFeatures)?.[
                feature.key as keyof ExtendedFeatures
            ];
            const currentVal = (currentTrackFeatures as ExtendedFeatures)?.[
                feature.key as keyof ExtendedFeatures
            ];

            const sourceNorm = normalizeValue(
                sourceVal as number,
                feature.min,
                feature.max
            );
            const currentNorm = normalizeValue(
                currentVal as number,
                feature.min,
                feature.max
            );
            const diff = Math.abs(sourceNorm - currentNorm);
            const match = Math.round((1 - diff) * 100);

            return {
                ...feature,
                sourceValue: sourceVal,
                currentValue: currentVal,
                sourceNorm,
                currentNorm,
                diff,
                match,
                hasData: sourceVal != null && currentVal != null,
            };
        }).filter((f) => f.hasData);
    }, [vibeSourceFeatures, currentTrackFeatures]);

    // Overall match score
    const overallMatch = useMemo(() => {
        if (!featureComparisons || featureComparisons.length === 0) return null;
        const totalMatch = featureComparisons.reduce(
            (sum, f) => sum + f.match,
            0
        );
        return Math.round(totalMatch / featureComparisons.length);
    }, [featureComparisons]);

    // Don't render if not in vibe mode
    if (!vibeMode) return null;

    const isFloating = variant === "floating";

    return (
        <div
            className={cn(
                "bg-black/90 backdrop-blur-xl border border-white/10 text-white",
                isFloating &&
                    "fixed bottom-24 right-4 z-50 rounded-2xl shadow-2xl w-72 animate-in slide-in-from-right-5 duration-300",
                !isFloating && "rounded-xl w-full",
                className
            )}
        >
            {/* Header */}
            <div
                className={cn(
                    "flex items-center justify-between px-4 py-3 border-b border-white/10 cursor-pointer",
                    isFloating && "hover:bg-white/5"
                )}
                onClick={() => isFloating && setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2">
                    <AudioWaveform className="w-4 h-4 text-brand" />
                    <span className="text-sm font-semibold">Vibe Analysis</span>
                </div>
                <div className="flex items-center gap-2">
                    {overallMatch !== null && (
                        <span
                            className={cn(
                                "text-lg font-bold tabular-nums",
                                overallMatch >= 80
                                    ? "text-green-400"
                                    : overallMatch >= 60
                                    ? "text-brand"
                                    : "text-red-400"
                            )}
                        >
                            {overallMatch}%
                        </span>
                    )}
                    {isFloating && onClose && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onClose();
                            }}
                            className="p-1 hover:bg-white/10 rounded-full transition-colors"
                        >
                            <X className="w-4 h-4 text-gray-400" />
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            {isExpanded && (
                <div className="p-4 space-y-4">
                    {/* What is this? */}
                    <p className="text-xs text-gray-400 leading-relaxed">
                        Comparing current track to your vibe source.
                        {(vibeSourceFeatures as ExtendedFeatures)
                            ?.analysisMode === "enhanced"
                            ? " Using ML mood predictions for accurate matching."
                            : " Using audio signal analysis for matching."}
                    </p>

                    {/* Feature Bars */}
                    <div className="space-y-3">
                        {featureComparisons?.map((feature) => {
                            const Icon = feature.icon;
                            return (
                                <div key={feature.key} className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5">
                                            <Icon className="w-3.5 h-3.5 text-gray-500" />
                                            <span className="text-xs font-medium text-gray-300">
                                                {feature.label}
                                            </span>
                                        </div>
                                        <span
                                            className={cn(
                                                "text-xs font-bold tabular-nums",
                                                getMatchColor(feature.diff)
                                            )}
                                        >
                                            {feature.match}%
                                        </span>
                                    </div>

                                    {/* Comparison Bar */}
                                    <div className="relative h-2 bg-white/5 rounded-full overflow-hidden">
                                        {/* Source marker (yellow dashed) */}
                                        <div
                                            className="absolute top-0 bottom-0 w-0.5 bg-brand z-10"
                                            style={{
                                                left: `${
                                                    feature.sourceNorm * 100
                                                }%`,
                                            }}
                                        />
                                        {/* Current value bar */}
                                        <div
                                            className={cn(
                                                "absolute top-0 bottom-0 left-0 rounded-full transition-all duration-500",
                                                getMatchBgColor(feature.diff)
                                            )}
                                            style={{
                                                width: `${
                                                    feature.currentNorm * 100
                                                }%`,
                                            }}
                                        />
                                        {/* Current marker */}
                                        <div
                                            className="absolute top-0 bottom-0 w-1 bg-white rounded-full transition-all duration-500"
                                            style={{
                                                left: `calc(${
                                                    feature.currentNorm * 100
                                                }% - 2px)`,
                                            }}
                                        />
                                    </div>

                                    {/* Labels */}
                                    <div className="flex justify-between text-[10px] text-gray-600">
                                        <span>{feature.lowLabel}</span>
                                        {feature.unit &&
                                            feature.currentValue && (
                                                <span className="text-gray-400">
                                                    {Math.round(
                                                        feature.currentValue as number
                                                    )}{" "}
                                                    {feature.unit}
                                                </span>
                                            )}
                                        <span>{feature.highLabel}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* ML Moods (Enhanced mode only) */}
                    {(vibeSourceFeatures as ExtendedFeatures)?.analysisMode ===
                        "enhanced" && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-1.5 pb-1 border-b border-white/5">
                                <Music className="w-3 h-3 text-gray-500" />
                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
                                    ML Mood Analysis
                                </span>
                            </div>
                            <div className="grid grid-cols-4 gap-2">
                                {ML_MOOD_CONFIG.map((mood) => {
                                    const sourceVal = (
                                        vibeSourceFeatures as ExtendedFeatures
                                    )?.[mood.key as keyof ExtendedFeatures] as
                                        | number
                                        | null;
                                    const currentVal = (
                                        currentTrackFeatures as ExtendedFeatures
                                    )?.[mood.key as keyof ExtendedFeatures] as
                                        | number
                                        | null;
                                    const hasData =
                                        sourceVal != null && currentVal != null;
                                    const diff = hasData
                                        ? Math.abs(sourceVal - currentVal)
                                        : 0;
                                    const match = hasData
                                        ? Math.round((1 - diff) * 100)
                                        : null;
                                    const Icon = mood.icon;

                                    if (!hasData) return null;

                                    return (
                                        <div
                                            key={mood.key}
                                            className={cn(
                                                "flex flex-col items-center gap-1 p-1.5 rounded-lg",
                                                match !== null && match >= 80
                                                    ? "bg-green-500/10"
                                                    : match !== null &&
                                                      match >= 60
                                                    ? "bg-white/5"
                                                    : "bg-red-500/10"
                                            )}
                                            title={`Source: ${Math.round(
                                                sourceVal * 100
                                            )}% | Current: ${Math.round(
                                                currentVal * 100
                                            )}%`}
                                        >
                                            <Icon
                                                className={cn(
                                                    "w-3.5 h-3.5",
                                                    mood.color
                                                )}
                                            />
                                            <span className="text-[9px] text-gray-400">
                                                {mood.label}
                                            </span>
                                            {match !== null && (
                                                <span
                                                    className={cn(
                                                        "text-[10px] font-bold",
                                                        match >= 80
                                                            ? "text-green-400"
                                                            : match >= 60
                                                            ? "text-gray-300"
                                                            : "text-red-400"
                                                    )}
                                                >
                                                    {match}%
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Legend */}
                    <div className="flex items-center justify-center gap-4 pt-2 border-t border-white/5">
                        <div className="flex items-center gap-1.5">
                            <div className="w-3 h-0.5 bg-brand" />
                            <span className="text-[10px] text-gray-500">
                                Source
                            </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <div className="w-3 h-2 bg-white/40 rounded-sm" />
                            <span className="text-[10px] text-gray-500">
                                Current
                            </span>
                        </div>
                    </div>

                    {/* Match Explanation */}
                    {overallMatch !== null && (
                        <div
                            className={cn(
                                "text-center py-2 px-3 rounded-lg text-xs",
                                overallMatch >= 80
                                    ? "bg-green-500/10 text-green-400"
                                    : overallMatch >= 60
                                    ? "bg-brand/10 text-brand"
                                    : "bg-red-500/10 text-red-400"
                            )}
                        >
                            {overallMatch >= 80 &&
                                "Excellent match - very similar vibe"}
                            {overallMatch >= 60 &&
                                overallMatch < 80 &&
                                "Good match - similar energy"}
                            {overallMatch < 60 &&
                                "Different vibe - exploring variety"}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Compact version for mobile overlay player - shows as album art replacement
export function VibeComparisonArt({
    currentTrackFeatures,
    className,
}: {
    currentTrackFeatures?: AudioFeatures | null;
    className?: string;
}) {
    const { vibeMode, vibeSourceFeatures } = useAudioState();

    // Calculate feature comparisons
    const comparisons = useMemo(() => {
        if (!vibeSourceFeatures || !currentTrackFeatures) return null;

        return FEATURE_CONFIG.slice(0, 4)
            .map((feature) => {
                const sourceVal = (vibeSourceFeatures as ExtendedFeatures)?.[
                    feature.key as keyof ExtendedFeatures
                ];
                const currentVal = (currentTrackFeatures as ExtendedFeatures)?.[
                    feature.key as keyof ExtendedFeatures
                ];

                const sourceNorm = normalizeValue(
                    sourceVal as number,
                    feature.min,
                    feature.max
                );
                const currentNorm = normalizeValue(
                    currentVal as number,
                    feature.min,
                    feature.max
                );
                const diff = Math.abs(sourceNorm - currentNorm);

                return {
                    ...feature,
                    sourceNorm,
                    currentNorm,
                    diff,
                    match: Math.round((1 - diff) * 100),
                    hasData: sourceVal != null && currentVal != null,
                };
            })
            .filter((f) => f.hasData);
    }, [vibeSourceFeatures, currentTrackFeatures]);

    const overallMatch = useMemo(() => {
        if (!comparisons || comparisons.length === 0) return null;
        const totalMatch = comparisons.reduce((sum, f) => sum + f.match, 0);
        return Math.round(totalMatch / comparisons.length);
    }, [comparisons]);

    if (!vibeMode || !comparisons) return null;

    // Radar chart dimensions
    const size = 320;
    const center = size / 2;
    const maxRadius = 110;

    const getPolygonPoints = (values: number[]) => {
        const angleStep = (2 * Math.PI) / values.length;
        return values
            .map((value, i) => {
                const angle = angleStep * i - Math.PI / 2;
                const radius = value * maxRadius;
                const x = center + radius * Math.cos(angle);
                const y = center + radius * Math.sin(angle);
                return `${x},${y}`;
            })
            .join(" ");
    };

    const sourceValues = comparisons.map((c) => c.sourceNorm);
    const currentValues = comparisons.map((c) => c.currentNorm);

    return (
        <div
            className={cn(
                "relative w-full h-full flex items-center justify-center",
                "md:bg-gradient-to-br md:from-[#1a1a2e] md:via-[#0f0f1a] md:to-[#000000] md:overflow-hidden",
                className
            )}
        >
            {/* Animated background glow */}
            <div className="absolute inset-0">
                <div className="absolute top-1/4 left-1/4 w-32 h-32 bg-brand/20 rounded-full blur-3xl animate-pulse" />
                <div className="absolute bottom-1/4 right-1/4 w-32 h-32 bg-purple-500/20 rounded-full blur-3xl animate-pulse delay-1000" />
            </div>

            {/* Radar Chart */}
            <svg width={size} height={size} className="relative z-10">
                {/* Background circles */}
                {[0.25, 0.5, 0.75, 1].map((scale) => (
                    <circle
                        key={scale}
                        cx={center}
                        cy={center}
                        r={maxRadius * scale}
                        fill="none"
                        stroke="rgba(255,255,255,0.08)"
                        strokeWidth="1"
                    />
                ))}

                {/* Axis lines */}
                {comparisons.map((_, i) => {
                    const angleStep = (2 * Math.PI) / comparisons.length;
                    const angle = angleStep * i - Math.PI / 2;
                    const x = center + maxRadius * Math.cos(angle);
                    const y = center + maxRadius * Math.sin(angle);
                    return (
                        <line
                            key={i}
                            x1={center}
                            y1={center}
                            x2={x}
                            y2={y}
                            stroke="rgba(255,255,255,0.1)"
                            strokeWidth="1"
                        />
                    );
                })}

                {/* Source polygon (yellow, dashed) */}
                <polygon
                    points={getPolygonPoints(sourceValues)}
                    fill="rgba(236, 178, 0, 0.15)"
                    stroke="#ecb200"
                    strokeWidth="2"
                    strokeDasharray="6,4"
                />

                {/* Current polygon (white/gradient, solid) */}
                <polygon
                    points={getPolygonPoints(currentValues)}
                    fill="url(#currentGradient)"
                    stroke="rgba(255, 255, 255, 0.9)"
                    strokeWidth="2"
                />

                {/* Gradient definition */}
                <defs>
                    <linearGradient
                        id="currentGradient"
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="100%"
                    >
                        <stop
                            offset="0%"
                            stopColor="rgba(255, 255, 255, 0.2)"
                        />
                        <stop
                            offset="100%"
                            stopColor="rgba(168, 85, 247, 0.2)"
                        />
                    </linearGradient>
                </defs>

                {/* Feature labels */}
                {comparisons.map((feature, i) => {
                    const angleStep = (2 * Math.PI) / comparisons.length;
                    const angle = angleStep * i - Math.PI / 2;
                    const labelRadius = maxRadius + 25;
                    const x = center + labelRadius * Math.cos(angle);
                    const y = center + labelRadius * Math.sin(angle);
                    const Icon = feature.icon;

                    return (
                        <g key={feature.key}>
                            {/* Icon background */}
                            <circle
                                cx={x}
                                cy={y}
                                r={14}
                                fill="rgba(0,0,0,0.5)"
                                stroke={
                                    feature.match >= 70
                                        ? "rgba(74, 222, 128, 0.5)"
                                        : "rgba(255,255,255,0.2)"
                                }
                                strokeWidth="1"
                            />
                            {/* Feature label */}
                            <text
                                x={x}
                                y={y + 28}
                                textAnchor="middle"
                                className="fill-gray-400 text-[10px] font-medium"
                            >
                                {feature.label}
                            </text>
                            {/* Match percentage */}
                            <text
                                x={x}
                                y={y + 40}
                                textAnchor="middle"
                                className={cn(
                                    "text-[10px] font-bold",
                                    feature.match >= 70
                                        ? "fill-green-400"
                                        : feature.match >= 50
                                        ? "fill-yellow-400"
                                        : "fill-red-400"
                                )}
                            >
                                {feature.match}%
                            </text>
                        </g>
                    );
                })}

                {/* Center match score */}
                <circle
                    cx={center}
                    cy={center}
                    r={35}
                    fill="rgba(0,0,0,0.7)"
                    stroke={
                        overallMatch && overallMatch >= 70
                            ? "#4ade80"
                            : overallMatch && overallMatch >= 50
                            ? "#facc15"
                            : "#f87171"
                    }
                    strokeWidth="2"
                />
                <text
                    x={center}
                    y={center - 5}
                    textAnchor="middle"
                    className={cn(
                        "text-2xl font-bold",
                        overallMatch && overallMatch >= 70
                            ? "fill-green-400"
                            : overallMatch && overallMatch >= 50
                            ? "fill-yellow-400"
                            : "fill-red-400"
                    )}
                >
                    {overallMatch}%
                </text>
                <text
                    x={center}
                    y={center + 12}
                    textAnchor="middle"
                    className="fill-gray-400 text-[10px] font-medium uppercase tracking-wider"
                >
                    Match
                </text>
            </svg>

            {/* Legend */}
            <div className="absolute bottom-4 left-0 right-0 flex items-center justify-center gap-6">
                <div className="flex items-center gap-2">
                    <div
                        className="w-4 h-0.5 bg-brand border-dashed"
                        style={{ borderStyle: "dashed" }}
                    />
                    <span className="text-[10px] text-gray-400">
                        Source Vibe
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-4 h-2 bg-white/30 rounded-sm" />
                    <span className="text-[10px] text-gray-400">
                        Current Track
                    </span>
                </div>
            </div>
        </div>
    );
}
