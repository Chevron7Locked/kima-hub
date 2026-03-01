"use client";

import { useEffect, useRef } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useLyricsSync } from "@/hooks/useLyricsSync";
import { cn } from "@/utils/cn";

interface LyricsPanelProps {
    onBack: () => void;
}

export function LyricsPanel({ onBack }: LyricsPanelProps) {
    const {
        lines,
        activeIndex,
        isLoading,
        hasLyrics,
        isSynced,
        plainLyrics,
    } = useLyricsSync();

    const activeRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to active line
    useEffect(() => {
        if (activeRef.current) {
            activeRef.current.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
        }
    }, [activeIndex]);

    return (
        <div className="h-full flex flex-col bg-[#0a0a0a]">
            {/* Header with back button */}
            <div className="flex items-center gap-3 px-5 py-4 border-b-2 border-white/20">
                <button
                    onClick={onBack}
                    className="border border-white/20 p-2 hover:border-[#a855f7] hover:bg-white/5 transition-colors"
                    title="Back to activity"
                >
                    <ArrowLeft className="w-4 h-4 text-white/60" />
                </button>
                <h3 className="text-sm font-black uppercase tracking-wider text-white">
                    Lyrics
                </h3>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-5">
                {isLoading && (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-white/40" />
                    </div>
                )}

                {!isLoading && !hasLyrics && (
                    <div className="flex items-center justify-center py-20">
                        <p className="text-sm text-white/30 font-mono">
                            No lyrics available
                        </p>
                    </div>
                )}

                {!isLoading && isSynced && (
                    <div className="space-y-1 py-8 overflow-hidden">
                        {lines.map((line, i) => (
                            <div
                                key={`${line.time}-${i}`}
                                ref={i === activeIndex ? activeRef : undefined}
                                className={cn(
                                    "px-2 py-1.5 rounded text-base text-white origin-left transition-[transform,opacity] duration-300",
                                    i === activeIndex
                                        ? "scale-110 opacity-100"
                                        : "scale-100 opacity-30"
                                )}
                            >
                                {line.text}
                            </div>
                        ))}
                    </div>
                )}

                {!isLoading && !isSynced && plainLyrics && (
                    <div className="py-4 whitespace-pre-wrap text-sm text-white/70 leading-relaxed font-mono">
                        {plainLyrics}
                    </div>
                )}
            </div>
        </div>
    );
}
