"use client";

import { useState, useEffect, useCallback } from "react";
import { api, MoodType, MoodBucketPreset } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { useQueryClient } from "@tanstack/react-query";
import {
    Play,
    Loader2,
    AudioWaveform,
    X,
    Smile,
    Frown,
    Coffee,
    Zap,
    PartyPopper,
    Brain,
    CloudRain,
    Flame,
    Guitar,
} from "lucide-react";
import { useToast } from "@/lib/toast-context";

interface MoodMixerProps {
    isOpen: boolean;
    onClose: () => void;
}

// Mood configuration with icons and colors
const MOOD_CONFIG: Record<
    MoodType,
    {
        icon: React.ComponentType<{ className?: string }>;
        color: string;
        label: string;
        description: string;
    }
> = {
    happy: {
        icon: Smile,
        color: "from-yellow-500 to-orange-500",
        label: "Happy",
        description: "Uplifting & joyful",
    },
    sad: {
        icon: Frown,
        color: "from-blue-600 to-indigo-700",
        label: "Sad",
        description: "Melancholic & emotional",
    },
    chill: {
        icon: Coffee,
        color: "from-teal-500 to-cyan-600",
        label: "Chill",
        description: "Relaxed & mellow",
    },
    energetic: {
        icon: Zap,
        color: "from-orange-500 to-red-500",
        label: "Energetic",
        description: "High energy & pumped",
    },
    party: {
        icon: PartyPopper,
        color: "from-pink-500 to-purple-600",
        label: "Party",
        description: "Dance & celebrate",
    },
    focus: {
        icon: Brain,
        color: "from-emerald-500 to-green-600",
        label: "Focus",
        description: "Concentration & flow",
    },
    melancholy: {
        icon: CloudRain,
        color: "from-slate-500 to-gray-600",
        label: "Melancholy",
        description: "Bittersweet & reflective",
    },
    aggressive: {
        icon: Flame,
        color: "from-red-600 to-rose-700",
        label: "Aggressive",
        description: "Intense & powerful",
    },
    acoustic: {
        icon: Guitar,
        color: "from-amber-600 to-yellow-700",
        label: "Acoustic",
        description: "Organic & unplugged",
    },
};

// Order for display in 3x3 grid
const MOOD_ORDER: MoodType[] = [
    "happy",
    "energetic",
    "party",
    "chill",
    "focus",
    "acoustic",
    "melancholy",
    "sad",
    "aggressive",
];

export function MoodMixer({ isOpen, onClose }: MoodMixerProps) {
    const { toast } = useToast();
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [presets, setPresets] = useState<MoodBucketPreset[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState<MoodType | null>(null);
    const [isVisible, setIsVisible] = useState(false);

    const loadPresets = useCallback(async () => {
        try {
            const data = await api.getMoodBucketPresets();
            setPresets(data);
        } catch (error) {
            console.error("Failed to load mood presets:", error);
            toast.error("Failed to load mood presets");
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            loadPresets();
        } else {
            const timeout = setTimeout(() => setIsVisible(false), 200);
            return () => clearTimeout(timeout);
        }
    }, [isOpen, loadPresets]);

    const generateMix = async (mood: MoodType) => {
        const config = MOOD_CONFIG[mood];
        setGenerating(mood);

        try {
            // Get the mix from pre-computed bucket (instant!)
            const mix = await api.getMoodBucketMix(mood);

            if (mix.tracks && mix.tracks.length > 0) {
                const tracks: Track[] = mix.tracks.map((t) => ({
                    id: t.id,
                    title: t.title,
                    artist: {
                        name: t.album?.artist?.name || "Unknown Artist",
                        id: t.album?.artist?.id,
                    },
                    album: {
                        title: t.album?.title || "Unknown Album",
                        coverArt: t.album?.coverUrl,
                        id: t.albumId,
                    },
                    duration: t.duration,
                }));

                // Start playback
                playTracks(tracks, 0);

                // Save as user's active mood mix
                await api.saveMoodBucketMix(mood);

                toast.success(`${config.label} Mix - Playing ${tracks.length} tracks`);

                // Force immediate refetch of mixes on home page
                // Using refetchQueries instead of invalidateQueries for immediate update
                await queryClient.refetchQueries({ queryKey: ["mixes"] });

                // Also dispatch events for any other listeners
                window.dispatchEvent(new CustomEvent("mix-generated"));
                window.dispatchEvent(new CustomEvent("mixes-updated"));

                onClose();
            } else {
                toast.error("Not enough tracks for this mood - try analyzing more music or choose a different mood");
            }
        } catch (error: unknown) {
            console.error("Failed to generate mood mix:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Failed to generate mix";
            toast.error(errorMessage);
        } finally {
            setGenerating(null);
        }
    };

    // Get track count for a mood
    const getTrackCount = (mood: MoodType): number => {
        // MoodBucketPreset uses 'id' as the mood identifier
        const preset = presets.find((p) => p.id === mood);
        return preset?.trackCount || 0;
    };

    if (!isVisible && !isOpen) return null;

    return (
        <div
            className={`fixed inset-0 z-[80] bg-black/80 flex items-center justify-center p-4 transition-opacity duration-200 ${
                isOpen ? "opacity-100" : "opacity-0"
            }`}
            onClick={onClose}
        >
            <div
                className={`bg-gradient-to-b from-[#1a1a1a] to-[#0a0a0a] rounded-2xl max-w-lg w-full max-h-[85vh] overflow-hidden border border-white/10 shadow-2xl transition-all duration-200 ${
                    isOpen ? "scale-100 opacity-100" : "scale-95 opacity-0"
                }`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-6 border-b border-white/10 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#ecb200] to-amber-600 flex items-center justify-center">
                            <AudioWaveform className="w-5 h-5 text-black" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">
                                Mood Mixer
                            </h2>
                            <p className="text-sm text-gray-400">
                                Pick your vibe
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-full hover:bg-white/10 transition-colors"
                    >
                        <X className="w-5 h-5 text-gray-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto max-h-[calc(85vh-100px)]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-8 h-8 animate-spin text-[#ecb200]" />
                        </div>
                    ) : (
                        /* 3x3 Mood Grid */
                        <div className="grid grid-cols-3 gap-3">
                            {MOOD_ORDER.map((mood) => {
                                const config = MOOD_CONFIG[mood];
                                const Icon = config.icon;
                                const trackCount = getTrackCount(mood);
                                const isDisabled = trackCount < 8;
                                const isGenerating = generating === mood;

                                return (
                                    <button
                                        key={mood}
                                        onClick={() => generateMix(mood)}
                                        disabled={
                                            generating !== null || isDisabled
                                        }
                                        className={`
                                            relative group aspect-square rounded-xl overflow-hidden
                                            bg-gradient-to-br ${config.color}
                                            border border-white/10 hover:border-white/30
                                            transition-all duration-200 hover:scale-[1.03] active:scale-[0.97]
                                            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100
                                            flex flex-col items-center justify-center gap-2 p-3
                                        `}
                                        title={
                                            isDisabled
                                                ? `Need at least 8 tracks (have ${trackCount})`
                                                : config.description
                                        }
                                    >
                                        {/* Icon */}
                                        <div className="relative z-10">
                                            {isGenerating ? (
                                                <Loader2 className="w-8 h-8 text-white animate-spin" />
                                            ) : (
                                                <Icon className="w-8 h-8 text-white drop-shadow-lg" />
                                            )}
                                        </div>

                                        {/* Label */}
                                        <span className="relative z-10 text-sm font-semibold text-white drop-shadow-lg">
                                            {config.label}
                                        </span>

                                        {/* Track count badge */}
                                        <span className="absolute top-2 right-2 text-[10px] font-medium text-white/70 bg-black/30 px-1.5 py-0.5 rounded-full">
                                            {trackCount}
                                        </span>

                                        {/* Hover overlay with play icon */}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                            {!isGenerating && !isDisabled && (
                                                <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                                                    <Play
                                                        className="w-6 h-6 text-white ml-0.5"
                                                        fill="currentColor"
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* Help text */}
                    <p className="text-center text-xs text-gray-500 mt-4">
                        Moods are based on audio analysis of your library
                    </p>
                </div>
            </div>
        </div>
    );
}
