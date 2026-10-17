"use client";

import { useState, useEffect, useCallback, type CSSProperties } from "react";
import { api, MoodType, MoodBucketPreset, AiGenerateResult, AiVibeQuery, NormalizedAiVibeQuery } from "@/lib/api";
import { queryKeys } from "@/hooks/useQueries";
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
    Sparkles,
    Wand2,
    ArrowLeft,
    RotateCcw,
    Save,
} from "lucide-react";
import { notify } from "@/lib/notify";
import { formatDuration } from "@/lib/format";

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

// ── AI playlist generation (#240, Manual Mode) ─────────────────────────────
// The LLM only translates the prompt into explicit selection parameters; the
// user then reviews and edits them; track selection is deterministic SQL. A
// prompt call is ALWAYS a dry run — only the user's reviewed parameters with
// apply:true create a playlist.

/** The editable parameter form, kept as strings so optional numbers can be empty. */
interface AiDraft {
    valenceTarget: string;
    arousalTarget: string;
    feelTolerance: string;
    length: string;
    eraFrom: string;
    eraTo: string;
    genreIncludes: string;
    genreExcludes: string;
}

type AiBusy = "idle" | "generating" | "resolving" | "saving";

const toOptNum = (value: string): number | undefined => {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
};

const splitComma = (value: string): string[] =>
    value.split(",").map((t) => t.trim()).filter((t) => t.length > 0);

/** Server-normalized query → editable form (clamped values are reflected back). */
function queryToDraft(q: NormalizedAiVibeQuery): AiDraft {
    return {
        valenceTarget: q.valenceTarget !== undefined ? String(q.valenceTarget) : "",
        arousalTarget: q.arousalTarget !== undefined ? String(q.arousalTarget) : "",
        feelTolerance: String(q.feelTolerance),
        length: String(q.length),
        eraFrom: q.eraFrom !== undefined ? String(q.eraFrom) : "",
        eraTo: q.eraTo !== undefined ? String(q.eraTo) : "",
        genreIncludes: q.genreIncludes.join(", "),
        genreExcludes: q.genreExcludes.join(", "),
    };
}

/** Editable form → the raw query the server validates and clamps. */
function draftToQuery(d: AiDraft): AiVibeQuery {
    const len = toOptNum(d.length);
    const eraTo = toOptNum(d.eraTo);
    return {
        valenceTarget: toOptNum(d.valenceTarget),
        arousalTarget: toOptNum(d.arousalTarget),
        feelTolerance: toOptNum(d.feelTolerance),
        length: len !== undefined ? Math.max(1, Math.round(len)) : undefined,
        eraFrom: toOptNum(d.eraFrom),
        eraTo: eraTo !== undefined ? Math.round(eraTo) : undefined,
        genreIncludes: splitComma(d.genreIncludes),
        genreExcludes: splitComma(d.genreExcludes),
    };
}

/** Mirrors the server's "at least one anchor" rule, for a friendly pre-check. */
const hasAnchor = (q: AiVibeQuery): boolean =>
    q.valenceTarget !== undefined ||
    q.arousalTarget !== undefined ||
    (q.genreIncludes?.length ?? 0) > 0 ||
    q.eraFrom !== undefined ||
    q.eraTo !== undefined;

function AiNumberField({
    label,
    value,
    onChange,
    placeholder,
    min,
    max,
    step,
    className,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
    className?: string;
}) {
    return (
        <label className={`block ${className ?? ""}`}>
            <span className="text-xs text-[var(--text-muted)]">{label}</span>
            <input
                type="number"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                min={min}
                max={max}
                step={step}
                className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm tabular-nums text-white placeholder:text-[var(--text-muted)] focus:border-brand focus:outline-none"
            />
        </label>
    );
}

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

    // AI panel state (#240, Manual Mode)
    const [view, setView] = useState<"grid" | "ai">("grid");
    const [aiPrompt, setAiPrompt] = useState("");
    const [aiBusy, setAiBusy] = useState<AiBusy>("idle");
    const [aiResult, setAiResult] = useState<AiGenerateResult | null>(null);
    const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiName, setAiName] = useState("");
    const [aiApplied, setAiApplied] = useState<{ name: string } | null>(null);

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
            // Reset the panel on close so a fresh open starts clean
            const timeout = setTimeout(() => {
                setIsVisible(false);
                setView("grid");
                setAiResult(null);
                setAiDraft(null);
                setAiError(null);
                setAiApplied(null);
                setAiBusy("idle");
            }, 200);
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

    // ── AI flow handlers ────────────────────────────────────────────────────

    const openAiView = () => {
        setView("ai");
        setAiError(null);
        setAiApplied(null);
    };

    /** Phase 1 — the LLM translates the prompt (dry run, always a preview). */
    const runPrompt = async () => {
        const prompt = aiPrompt.trim();
        if (prompt.length < 2 || aiBusy !== "idle") return;
        setAiBusy("generating");
        setAiError(null);
        setAiApplied(null);
        try {
            const result = await api.aiGeneratePlaylist({ prompt });
            setAiResult(result);
            setAiDraft(queryToDraft(result.vibeQuery));
            if (result.trackCount === 0) {
                setAiError("No library tracks matched this description. Loosen the parameters below or rephrase the prompt.");
            }
        } catch (error: unknown) {
            setAiError(error instanceof Error ? error.message : "AI generation failed");
        } finally {
            setAiBusy("idle");
        }
    };

    /** Phase 2a — re-resolve the user-edited parameters (still a preview). */
    const reResolve = async () => {
        if (!aiDraft || aiBusy !== "idle") return;
        const query = draftToQuery(aiDraft);
        if (!hasAnchor(query)) {
            setAiError("Set at least one selection anchor (mood values, genres, or era) before resolving.");
            return;
        }
        setAiBusy("resolving");
        setAiError(null);
        setAiApplied(null);
        try {
            const result = await api.aiGeneratePlaylist({ vibeQuery: query });
            setAiResult(result);
            // Reflect the server's clamps back into the form (e.g. the
            // admin's max-length guardrail) so the UI never overstates.
            setAiDraft(queryToDraft(result.vibeQuery));
            if (result.trackCount === 0) {
                setAiError("No library tracks matched these parameters. Loosen the filters or remove an exclude.");
            }
        } catch (error: unknown) {
            setAiError(error instanceof Error ? error.message : "Resolving the parameters failed");
        } finally {
            setAiBusy("idle");
        }
    };

    /** Phase 2b — the user's reviewed parameters create the playlist. */
    const applyMix = async () => {
        if (!aiDraft || aiBusy !== "idle") return;
        const query = draftToQuery(aiDraft);
        if (!hasAnchor(query)) {
            setAiError("Set at least one selection anchor (mood values, genres, or era) before saving.");
            return;
        }
        setAiBusy("saving");
        setAiError(null);
        try {
            const result = await api.aiGeneratePlaylist({
                vibeQuery: query,
                name: aiName.trim() || undefined,
                apply: true,
            });
            if (result.playlistId && result.playlistName) {
                setAiApplied({ name: result.playlistName });
                await queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
                window.dispatchEvent(new CustomEvent("mixes-updated"));
            } else {
                setAiError("The server declined to create the playlist — nothing matched the query.");
            }
        } catch (error: unknown) {
            setAiError(error instanceof Error ? error.message : "Saving the playlist failed");
        } finally {
            setAiBusy("idle");
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
                                {view === "ai" ? "Describe it, review it, own it" : "Pick your vibe"}
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
                    {view === "ai" ? (
                        // ── AI panel (#240, Manual Mode) ────────────────────
                        <div className="space-y-5">
                            <button
                                onClick={() => setView("grid")}
                                className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-white transition-colors"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                Back to moods
                            </button>

                            <div>
                                <label htmlFor="ai-prompt" className="text-sm font-semibold text-white">
                                    Describe your mix
                                </label>
                                <textarea
                                    id="ai-prompt"
                                    value={aiPrompt}
                                    onChange={(e) => setAiPrompt(e.target.value)}
                                    rows={3}
                                    maxLength={500}
                                    placeholder="e.g. late-night coding: calm, electronic-leaning, 80s–2000s, no heavy metal"
                                    className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-[var(--text-muted)] focus:border-brand focus:outline-none"
                                />
                                <div className="mt-2 flex items-center justify-between gap-3">
                                    <button
                                        onClick={() => void runPrompt()}
                                        disabled={aiBusy !== "idle" || aiPrompt.trim().length < 2}
                                        className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-black transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {aiBusy === "generating" ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <Wand2 className="w-4 h-4" />
                                        )}
                                        Generate preview
                                    </button>
                                    <span className="text-micro tabular-nums text-[var(--text-muted)]">
                                        {aiPrompt.trim().length}/500
                                    </span>
                                </div>
                                <p className="mt-2 text-xs text-[var(--text-muted)]">
                                    The model only turns this into selection parameters. You review and edit
                                    them below — nothing is created until you save.
                                </p>
                            </div>

                            {aiError && (
                                <div
                                    role="alert"
                                    className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-light"
                                >
                                    {aiError}
                                </div>
                            )}

                            {aiResult && aiDraft && (
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-sm text-[var(--text-secondary)]">
                                            <span className="font-semibold text-white">{aiResult.trackCount}</span>{" "}
                                            {aiResult.trackCount === 1 ? "track matches" : "tracks match"}
                                            {aiResult.source === "llm" ? " (from your description)" : ""}
                                        </p>
                                        <button
                                            onClick={() => void reResolve()}
                                            disabled={aiBusy !== "idle"}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-white hover:border-white/30 transition-colors disabled:opacity-40"
                                        >
                                            {aiBusy === "resolving" ? (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                                <RotateCcw className="w-3.5 h-3.5" />
                                            )}
                                            Re-check
                                        </button>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        <AiNumberField
                                            label="Mood (0 calm-dark → 1 bright) — optional"
                                            value={aiDraft.valenceTarget}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, valenceTarget: v } : d))}
                                            min={0}
                                            max={1}
                                            step={0.05}
                                            placeholder="e.g. 0.2"
                                        />
                                        <AiNumberField
                                            label="Energy (0 mellow → 1 intense) — optional"
                                            value={aiDraft.arousalTarget}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, arousalTarget: v } : d))}
                                            min={0}
                                            max={1}
                                            step={0.05}
                                            placeholder="e.g. 0.4"
                                        />
                                        <AiNumberField
                                            label="Tolerance (σ, 0.25–3; higher = broader)"
                                            value={aiDraft.feelTolerance}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, feelTolerance: v } : d))}
                                            min={0.25}
                                            max={3}
                                            step={0.05}
                                        />
                                        <AiNumberField
                                            label="Length (tracks)"
                                            value={aiDraft.length}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, length: v } : d))}
                                            min={1}
                                            step={1}
                                        />
                                        <AiNumberField
                                            label="From year — optional"
                                            value={aiDraft.eraFrom}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, eraFrom: v } : d))}
                                            min={1900}
                                            max={2100}
                                            step={1}
                                            placeholder="e.g. 1980"
                                        />
                                        <AiNumberField
                                            label="To year — optional"
                                            value={aiDraft.eraTo}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, eraTo: v } : d))}
                                            min={1900}
                                            max={2100}
                                            step={1}
                                            placeholder="e.g. 2005"
                                        />
                                        <AiNumberField
                                            label="Genres — optional, comma-separated"
                                            value={aiDraft.genreIncludes}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, genreIncludes: v } : d))}
                                            placeholder="e.g. electronic, post-punk"
                                            className="col-span-2"
                                        />
                                        <AiNumberField
                                            label="Exclude genres — comma-separated"
                                            value={aiDraft.genreExcludes}
                                            onChange={(v) => setAiDraft((d) => (d ? { ...d, genreExcludes: v } : d))}
                                            placeholder="e.g. classical"
                                            className="col-span-2"
                                        />
                                    </div>

                                    {aiResult.trackCount > 0 ? (
                                        <div className="max-h-60 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5">
                                            {aiResult.tracks.slice(0, 50).map((t) => (
                                                <div key={t.id} className="flex items-center gap-3 px-3 py-2">
                                                    <div className="w-9 h-9 shrink-0 rounded-md overflow-hidden bg-white/5">
                                                        {t.coverUrl ? (
                                                            // eslint-disable-next-line @next/next/no-img-element
                                                            <img src={t.coverUrl} alt="" className="w-full h-full object-cover" />
                                                        ) : null}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm text-white">{t.title}</p>
                                                        <p className="truncate text-xs text-[var(--text-muted)]">
                                                            {t.artistName}
                                                            {t.year ? ` · ${t.year}` : ""} · {t.albumTitle}
                                                        </p>
                                                    </div>
                                                    <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                                                        {formatDuration(t.duration)}
                                                    </span>
                                                </div>
                                            ))}
                                            {aiResult.trackCount > 50 && (
                                                <p className="px-3 py-2 text-xs text-[var(--text-muted)]">
                                                    … plus {aiResult.trackCount - 50} more — the preview shows the
                                                    first 50 in selection order.
                                                </p>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-4 text-center text-xs text-[var(--text-muted)]">
                                            Nothing matches yet. Loosen the tolerance, remove an exclude, or
                                            widen the era — global exclusions from the admin settings always apply.
                                        </div>
                                    )}

                                    <div className="flex items-center gap-3">
                                        <input
                                            value={aiName}
                                            onChange={(e) => setAiName(e.target.value)}
                                            maxLength={200}
                                            placeholder={`AI mix ${new Date().toISOString().slice(0, 10)}`}
                                            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-[var(--text-muted)] focus:border-brand focus:outline-none"
                                        />
                                        <button
                                            onClick={() => void applyMix()}
                                            disabled={aiBusy !== "idle" || aiResult.trackCount === 0}
                                            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-black transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            {aiBusy === "saving" ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <Save className="w-4 h-4" />
                                            )}
                                            Save playlist
                                        </button>
                                    </div>

                                    {aiApplied && (
                                        <p className="text-xs text-success">
                                            “{aiApplied.name}” was created with the parameters above — find it
                                            under Playlists.
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    ) : (
                        <>
                            {/* Mood Grid */}
                            {loading ? (
                                <div className="flex items-center justify-center py-12">
                                    <Loader2 className="w-8 h-8 animate-spin text-brand" />
                                </div>
                            ) : (
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

                                    {/* AI Mix — the manual-mode entry point (#240) */}
                                    <button
                                        onClick={openAiView}
                                        disabled={generating !== null}
                                        className={`
                                            relative group aspect-square rounded-xl overflow-hidden
                                            bg-gradient-to-br from-[var(--color-brand)] to-amber-700
                                            border border-white/10 hover:border-white/30
                                            transition-all duration-200 hover:scale-[1.03] active:scale-[0.97]
                                            disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100
                                            flex flex-col items-center justify-center gap-2 p-3
                                            animate-rise [animation-delay:calc(var(--i)*45ms)]
                                        `}
                                        title="Describe a mix in free text — review the parameters, then save"
                                        style={{ "--i": MOOD_ORDER.length } as CSSProperties}
                                    >
                                        <div className="relative z-(--z-raised)">
                                            <Sparkles className="w-8 h-8 text-black" />
                                        </div>

                                        <span className="relative z-(--z-raised) text-sm font-semibold text-black">
                                            AI Mix
                                        </span>

                                        <span className="relative z-(--z-raised) text-micro font-medium text-black/70">
                                            free text
                                        </span>

                                        {/* Hover overlay with wand icon */}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                                                <Wand2 className="w-6 h-6 text-white" />
                                            </div>
                                        </div>
                                    </button>
                                </div>
                            )}

                            <p className="text-center text-xs text-[var(--text-muted)] mt-4">
                                {pendingTracks > 0
                                    ? `Moods not analysed yet for ${pendingTracks.toLocaleString()} tracks — mixes fill in as analysis finishes`
                                    : "Moods are based on audio analysis of your library"}
                            </p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
