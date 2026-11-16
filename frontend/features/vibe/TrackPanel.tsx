"use client";

import { pathFor } from "@/lib/paths";
import Link from "next/link";
import { AudioWaveform, Play, Sparkles, Waypoints, X } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import { normalizeNFC } from "@/lib/format";
import { MOOD_COLORS, moodLabel } from "./mapUtils";
import type { MapTrack } from "./types";

interface TrackPanelProps {
    track: MapTrack;
    songPathActive: boolean;
    onClose: () => void;
    onPlay: () => void;
    onVibe: () => void;
    onSimilar: () => void;
    onSongPath: () => void;
}

const ACTION = "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";
const ACTION_PLAIN = `${ACTION} border-white/10 bg-white/[0.06] hover:bg-white/[0.12]`;

/**
 * The selected track, floating over the right side of the map. It does not
 * cover the map, so the next star is one click away and a double-click still
 * reaches the field. Everything shown comes from the map payload itself.
 */
export function TrackPanel({ track, songPathActive, onClose, onPlay, onVibe, onSimilar, onSongPath }: TrackPanelProps) {
    const moods = Object.entries(track.moods ?? {})
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
    const strongest = moods[0]?.[1] || 1;

    return (
        <aside
            id="vibe-track-panel"
            role="region"
            aria-labelledby="vibe-track-panel-title"
            className="vibe-glass absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(4.5rem,calc(env(safe-area-inset-top)+4.5rem))] z-(--z-scene) w-[min(20rem,calc(100%-2rem))] max-h-[calc(100%-6rem)] overflow-y-auto overscroll-contain rounded-2xl p-4 animate-slide-in"
        >
            <div className="flex items-start gap-3">
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-white/5">
                    <CachedImage src={track.coverUrl ? api.getCoverArtUrl(track.coverUrl, 128) : null} alt="" fill className="object-cover" sizes="64px" />
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                    <p id="vibe-track-panel-title" className="truncate text-sm font-semibold text-[var(--text-primary)]">
                        {normalizeNFC(track.title)}
                    </p>
                    {track.artistId ? (
                        <Link href={pathFor("/artist", track.artistId)} className="block truncate text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline-offset-2 hover:underline">
                            {normalizeNFC(track.artist)}
                        </Link>
                    ) : (
                        <p className="truncate text-xs text-[var(--text-secondary)]">{normalizeNFC(track.artist)}</p>
                    )}
                    {track.albumId && (
                        <Link href={pathFor("/album", track.albumId)} className="mt-0.5 inline-block text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] underline-offset-2 hover:underline">
                            Open album
                        </Link>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close track details"
                    className="-mr-1.5 -mt-1 rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {moods.length > 0 && (
                <div className="mt-4 space-y-1.5">
                    {moods.map(([key, score]) => {
                        const [r, g, b] = MOOD_COLORS[key] ?? MOOD_COLORS.neutral;
                        return (
                            <div key={key} className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-[11px]">
                                <span className="text-[var(--text-secondary)]">{moodLabel(key)}</span>
                                <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]">
                                    <div className="h-full rounded-full" style={{ width: `${(score / strongest) * 100}%`, background: `rgb(${r} ${g} ${b} / 0.85)` }} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {(track.energy != null || track.valence != null) && (
                <dl className="mt-4 grid grid-cols-2 gap-2">
                    {track.energy != null && (
                        <div className="rounded-lg bg-white/[0.04] px-3 py-2">
                            <dt className="text-micro tracking-[0.12em] text-[var(--text-muted)]">Energy</dt>
                            <dd className="text-sm font-medium tabular-nums text-[var(--text-primary)]">{Math.round(track.energy * 100)}%</dd>
                        </div>
                    )}
                    {track.valence != null && (
                        <div className="rounded-lg bg-white/[0.04] px-3 py-2">
                            <dt className="text-micro tracking-[0.12em] text-[var(--text-muted)]">Positivity</dt>
                            <dd className="text-sm font-medium tabular-nums text-[var(--text-primary)]">{Math.round(track.valence * 100)}%</dd>
                        </div>
                    )}
                </dl>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2">
                <button type="button" onClick={onPlay} aria-label="Play this track" className={`${ACTION} border-[var(--color-brand)]/40 bg-[var(--color-brand)]/15 hover:bg-[var(--color-brand)]/25`}>
                    <Play className="h-3.5 w-3.5 fill-current" /> Play
                </button>
                <button type="button" onClick={onVibe} aria-label="Build vibe playlist from this track" className={ACTION_PLAIN}>
                    <Sparkles className="h-3.5 w-3.5" /> Match Vibe
                </button>
                <button type="button" onClick={onSimilar} aria-label="Find tracks similar to this one" className={ACTION_PLAIN}>
                    <AudioWaveform className="h-3.5 w-3.5" /> Similar
                </button>
                <button
                    type="button"
                    onClick={onSongPath}
                    aria-label="Start song path from this track"
                    aria-pressed={songPathActive}
                    className={songPathActive ? `${ACTION} border-[var(--color-brand)]/60 bg-[var(--color-brand)]/15` : ACTION_PLAIN}
                >
                    <Waypoints className="h-3.5 w-3.5" /> Song Path
                </button>
            </div>
            {songPathActive && (
                <p className="mt-2 text-center text-[11px] text-[var(--text-secondary)]">Now click the track the path should end on.</p>
            )}
        </aside>
    );
}
