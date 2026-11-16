"use client";

import { AudioWaveform, Loader2 } from "lucide-react";
import { useActiveOperation } from "@/lib/audio-state-context";
import { useFeatures } from "@/lib/features-context";
import { useVibeToggle } from "@/hooks/useVibeToggle";
import { cn } from "@/lib/cn";

interface VibeToggleButtonProps {
    /** True when there is no music track to match against. */
    unavailable: boolean;
    /** Hide instead of disabling while unavailable. */
    hideWhenUnavailable?: boolean;
    className: string;
    iconClassName: string;
    idleClassName: string;
    activeClassName: string;
}

/** Starts or stops "match this vibe"; renders nothing unless embeddings are enabled. */
export function VibeToggleButton({
    unavailable,
    hideWhenUnavailable = false,
    className,
    iconClassName,
    idleClassName,
    activeClassName,
}: VibeToggleButtonProps) {
    const activeOperation = useActiveOperation();
    const { vibeEmbeddings, loading } = useFeatures();
    const { handleVibeToggle, isVibeLoading } = useVibeToggle();

    if (loading || !vibeEmbeddings || (unavailable && hideWhenUnavailable)) return null;

    const active = activeOperation.type !== "idle";
    const Icon = isVibeLoading ? Loader2 : AudioWaveform;

    return (
        <button
            onClick={handleVibeToggle}
            disabled={unavailable || isVibeLoading}
            className={cn(
                className,
                unavailable
                    ? "text-[var(--text-muted)] cursor-not-allowed"
                    : active
                      ? activeClassName
                      : idleClassName,
            )}
            aria-label={active ? "Turn off vibe mode" : "Match this vibe"}
            aria-pressed={active}
            title={active ? "turn off vibe mode" : "match this vibe - find similar sounding tracks"}
        >
            <Icon className={cn(iconClassName, isVibeLoading && "animate-spin")} />
        </button>
    );
}
