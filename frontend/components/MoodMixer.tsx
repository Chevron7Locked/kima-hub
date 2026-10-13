"use client";

import { useState, useEffect, useCallback, type CSSProperties } from "react";
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
    PartyPopper,
    Flame,
} from "lucide-react";
import { notify } from "@/lib/notify";

interface MoodMixerProps {
    isOpen: boolean;
    onClose: () => void;
}

// The five moods the server sorts tracks into (moodBucketService.MOODS).
// Keys are the stable API ids; labels are what people see.
type BucketMood = Extract<MoodType, "happy" | "sad" | "chill" | "aggressive" | "party">;

// The presets endpoint also reports how many library tracks still await mood
// analysis, so an empty mood can say "not analysed yet" rather than look final.
type PresetWithPending = MoodBucketPreset & { pendingTracks?: number };

const MOOD_CONFIG: Record<
    BucketMood,
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
        label: "Upbeat",
        description: "Bright & uplifting",
    },
    party: {
        icon: PartyPopper,
        color: "from-violet-500 to-purple-700",
        label: "Energetic",
        description: "Lively & danceable",
    },
    chill: {
        icon: Coffee,
        color: "from-teal-500 to-cyan-600",
        label: "Calm",
        description: "Relaxed & mellow",
    },
    sad: {
        icon: Frown,
        color: "from-blue-600 to-indigo-700",
        label: "Melancholic",
        description: "Wistful & reflective",
    },
    aggressive: {
        icon: Flame,
        color: "from-red-600 to-rose-700",
        label: "Intense",
        description: "Heavy & powerful",
    },
};

const MOOD_ORDER: BucketMood[] = ["happy", "party", "chill", "sad", "aggressive"];

export function MoodMixer({ isOpen, onClose }: MoodMixerProps) {
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [presets, setPresets] = useState<PresetWithPending[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState<BucketMood | null>(null);
    const [isVisible, setIsVisible] = useState(false);

    const loadPresets = useCallback(async () => {
        try {
            const data = await api.getMoodBucketPresets();
            setPresets(data);
        } catch {
            notify.error("Failed to load mood presets");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            loadPresets();
        } else {
            const timeout = setTimeout(() => setIsVisible(false), 200);
            return () => clearTimeout(timeout);
        }
    }, [isOpen, loadPresets]);

    const generateMix = async (mood: BucketMood) => {
        setGenerating(mood);

        try {
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

                playTracks(tracks, 0);

                await api.saveMoodBucketMix(mood, tracks.map((t) => t.id));

                // Force immediate refetch of mixes on home page
                // Using refetchQueries instead of invalidateQueries for immediate update
                await queryClient.refetchQueries({ queryKey: ["mixes"] });

                window.dispatchEvent(new CustomEvent("mix-generated"));
                window.dispatchEvent(new CustomEvent("mixes-updated"));

                onClose();
            } else {
                notify.error("Not enough tracks for this mood", {
                    message: "Analyse more music or choose a different mood.",
                });
            }
        } catch (error: unknown) {
            notify.error("Failed to generate mix", { message: error instanceof Error ? error.message : undefined });
        } finally {
            setGenerating(null);
        }
    };

    const getTrackCount = (mood: BucketMood): number => {
        // MoodBucketPreset uses 'id' as the mood identifier
        const preset = presets.find((p) => p.id === mood);
        return preset?.trackCount || 0;
    };

    // Tracks whose moods are not analysed yet (e.g. while a library re-analysis runs)
    const pendingTracks = presets[0]?.pendingTracks ?? 0;

    if (!isVisible && !isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-(--z-modal) bg-black/80 flex items-center justify-center p-4 animate-fade-soft"
            onClick={onClose}
        >
            <div
                className="bg-gradient-to-b from-[#1a1a1a] to-[#0a0a0a] rounded-2xl max-w-lg w-full max-h-[85vh] overflow-hidden border border-white/10 animate-pop"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6 border-b border-white/10 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[var(--color-brand)] to-amber-600 flex items-center justify-center">
                            <AudioWaveform className="w-5 h-5 text-black" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">
                                Mood Mixer
                            </h2>
                            <p className="text-sm text-[var(--text-secondary)]">
                                Pick your vibe
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-full hover:bg-white/10 transition-colors"
                    >
                        <X className="w-5 h-5 text-[var(--text-secondary)]" />
                    </button>
                </div>

                <div className="p-6 overflow-y-auto max-h-[calc(85vh-100px)]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-8 h-8 animate-spin text-brand" />
                        </div>
                    ) : (
                        /* Mood Grid */
                        <div className="grid grid-cols-3 gap-3">
                            {MOOD_ORDER.map((mood, i) => {
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
                                            animate-rise [animation-delay:calc(var(--i)*45ms)]
                                        `}
                                        title={
                                            isDisabled
                                                ? pendingTracks > 0
                                                    ? `Not analysed yet — ${pendingTracks.toLocaleString()} tracks still being analysed`.toLowerCase()
                                                    : `Need at least 8 tracks (have ${trackCount})`.toLowerCase()
                                                : config.description
                                        }
                                        style={{ "--i": i } as CSSProperties}
                                    >
                                        <div className="relative z-(--z-raised)">
                                            {isGenerating ? (
                                                <Loader2 className="w-8 h-8 text-white animate-spin" />
                                            ) : (
                                                <Icon className="w-8 h-8 text-white" />
                                            )}
                                        </div>

                                        <span className="relative z-(--z-raised) text-sm font-semibold text-white">
                                            {config.label}
                                        </span>

                                        <span className="absolute top-2 right-2 text-micro font-medium text-[var(--text-secondary)] bg-black/30 px-1.5 py-0.5 rounded-full">
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

                    <p className="text-center text-xs text-[var(--text-muted)] mt-4">
                        {pendingTracks > 0
                            ? `Moods not analysed yet for ${pendingTracks.toLocaleString()} tracks — mixes fill in as analysis finishes`
                            : "Moods are based on audio analysis of your library"}
                    </p>
                </div>
            </div>
        </div>
    );
}
