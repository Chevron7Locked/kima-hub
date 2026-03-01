"use client";

import { Loader2 } from "lucide-react";
import { useLyricsSync } from "@/hooks/useLyricsSync";
import { cn } from "@/utils/cn";

export function LyricsCrawl() {
    const {
        lines,
        activeIndex,
        isLoading,
        hasLyrics,
        isSynced,
        plainLyrics,
    } = useLyricsSync();

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin text-white/30" />
            </div>
        );
    }

    if (!hasLyrics) {
        return (
            <div className="flex items-center justify-center h-full">
                <p className="text-xs text-white/20 font-mono">
                    No lyrics available
                </p>
            </div>
        );
    }

    if (!isSynced && plainLyrics) {
        return (
            <div className="flex items-center justify-center h-full px-4">
                <p className="text-xs text-white/40 leading-relaxed text-center line-clamp-3">
                    {plainLyrics}
                </p>
            </div>
        );
    }

    const prevLine = activeIndex > 0 ? lines[activeIndex - 1] : null;
    const currentLine = activeIndex >= 0 ? lines[activeIndex] : null;
    const nextLine = activeIndex >= 0 && activeIndex < lines.length - 1
        ? lines[activeIndex + 1]
        : null;

    if (!currentLine) {
        return (
            <div className="flex items-center justify-center h-full">
                <p className="text-xs text-white/20 font-mono">...</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-center justify-center gap-1 h-full px-4">
            <p
                className={cn(
                    "text-xs text-white/30 text-center truncate w-full transition-opacity duration-300",
                    !prevLine && "opacity-0"
                )}
            >
                {prevLine?.text ?? "\u00A0"}
            </p>
            <p className="text-sm text-white font-medium text-center truncate w-full">
                {currentLine.text}
            </p>
            <p
                className={cn(
                    "text-xs text-white/30 text-center truncate w-full transition-opacity duration-300",
                    !nextLine && "opacity-0"
                )}
            >
                {nextLine?.text ?? "\u00A0"}
            </p>
        </div>
    );
}
