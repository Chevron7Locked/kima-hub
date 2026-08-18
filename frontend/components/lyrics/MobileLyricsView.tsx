"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useLyricsSync } from "@/hooks/useLyricsSync";
import { cn } from "@/utils/cn";

export function MobileLyricsView() {
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
            <div className="w-full h-full flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
            </div>
        );
    }

    if (!hasLyrics) {
        return (
            <div className="w-full h-full flex items-center justify-center">
                <p className="text-xs text-[var(--text-muted)]">
                    No lyrics available
                </p>
            </div>
        );
    }

    if (isSynced) {
        return (
            <div
                className="w-full h-full overflow-y-auto px-5 scrollbar-hide"
                style={{
                    maskImage: "linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)",
                    WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)",
                }}
            >
                <div className="space-y-1 py-[40%]">
                    {lines.map((line, i) => (
                        <div
                            key={`${line.time}-${i}`}
                            ref={i === activeIndex ? activeRef : undefined}
                            className={cn(
                                "px-1 py-1.5 rounded text-sm origin-left transition-all duration-300",
                                i === activeIndex
                                    ? "text-white scale-105 opacity-100"
                                    : "text-white scale-100 opacity-25"
                            )}
                        >
                            {line.text}
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div
            className="w-full h-full overflow-y-auto px-5 scrollbar-hide"
            style={{
                maskImage: "linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)",
                WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)",
            }}
        >
            <div className="space-y-1 py-[40%]">
                {plainLyrics?.split("\n").map((line, i) => (
                    <div
                        key={i}
                        className="px-1 py-1.5 rounded text-sm text-white opacity-60"
                    >
                        {line || "\u00A0"}
                    </div>
                ))}
            </div>
        </div>
    );
}
