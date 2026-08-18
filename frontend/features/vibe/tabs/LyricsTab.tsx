"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useLyricsSync } from "@/hooks/useLyricsSync";
import { cn } from "@/utils/cn";

export function LyricsTab() {
    const {
        lines,
        activeIndex,
        isLoading,
        hasLyrics,
        isSynced,
        plainLyrics,
    } = useLyricsSync();

    const activeRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (activeRef.current) {
            activeRef.current.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
        }
    }, [activeIndex]);

    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
            </div>
        );
    }

    if (!hasLyrics) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-[var(--text-muted)]">No lyrics available</p>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto p-5">
            {isSynced && (
                <div className="space-y-1 py-8 overflow-hidden">
                    {lines.map((line, i) => (
                        <div
                            key={`${line.time}-${i}`}
                            ref={i === activeIndex ? activeRef : undefined}
                            className={cn(
                                "px-2 py-1.5 rounded text-base text-white origin-left transition-[transform,opacity] duration-300",
                                i === activeIndex
                                    ? "scale-110 opacity-100"
                                    : "scale-100 opacity-30",
                            )}
                        >
                            {line.text}
                        </div>
                    ))}
                </div>
            )}

            {!isSynced && plainLyrics && (
                <div className="space-y-1 py-8 overflow-hidden">
                    {plainLyrics.split("\n").map((line, i) => (
                        <div
                            key={i}
                            className="px-2 py-1.5 rounded text-base text-white opacity-70"
                        >
                            {line || "\u00A0"}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
