"use client";

import { useState, useRef, useEffect } from "react";
import { Timer } from "lucide-react";
import { cn } from "@/utils/cn";
import { useSleepTimer } from "@/hooks/useSleepTimer";

const PRESETS = [15, 30, 45, 60, 90, 120] as const;

function formatPreset(mins: number): string {
    if (mins >= 60) return `${mins / 60} hour${mins > 60 ? "s" : ""}`;
    return `${mins} minutes`;
}

interface SleepTimerProps {
    size?: "sm" | "md";
}

export function SleepTimer({ size = "md" }: SleepTimerProps) {
    const { isActive, remainingSeconds, displayRemaining, setTimer, clearTimer } = useSleepTimer();
    const [isOpen, setIsOpen] = useState(false);
    const [customMinutes, setCustomMinutes] = useState("");
    const popoverRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    // Close on outside click or Escape
    useEffect(() => {
        if (!isOpen) return;

        const handleClick = (e: MouseEvent) => {
            if (
                popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsOpen(false);
        };

        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("keydown", handleKey);
        };
    }, [isOpen]);

    const handlePreset = (minutes: number) => {
        setTimer(minutes);
        setIsOpen(false);
    };

    const handleCustom = () => {
        const mins = parseInt(customMinutes);
        if (mins > 0 && mins <= 480) {
            setTimer(mins);
            setCustomMinutes("");
            setIsOpen(false);
        }
    };

    const iconSize = size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4";

    return (
        <div className="relative">
            <button
                ref={buttonRef}
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    "transition-all duration-200 hover:scale-110 flex items-center gap-1",
                    isActive
                        ? "text-brand hover:text-brand-hover"
                        : "text-gray-400 hover:text-white"
                )}
                aria-label={isActive ? `Sleep timer: ${displayRemaining} remaining` : "Sleep timer"}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                title={isActive ? `Sleep timer: ${displayRemaining} remaining` : "Sleep timer"}
            >
                <Timer className={iconSize} />
                {isActive && remainingSeconds !== null && (
                    <span className="text-[10px] font-mono font-medium tabular-nums text-brand">
                        {displayRemaining}
                    </span>
                )}
            </button>

            {isOpen && (
                <div
                    ref={popoverRef}
                    role="dialog"
                    aria-label="Sleep timer options"
                    className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-[#1a1a1a] border border-white/10 rounded-lg shadow-2xl overflow-hidden z-50"
                >
                    <div className="px-3 py-2 border-b border-white/[0.06]">
                        <span className="text-xs text-gray-400 font-medium uppercase tracking-wider">Sleep Timer</span>
                    </div>

                    <div className="p-1.5">
                        {PRESETS.map((mins) => (
                            <button
                                key={mins}
                                onClick={() => handlePreset(mins)}
                                className="w-full text-left px-3 py-1.5 rounded text-sm transition-colors text-gray-300 hover:bg-white/[0.06] hover:text-white"
                            >
                                {formatPreset(mins)}
                            </button>
                        ))}
                    </div>

                    {/* Custom input */}
                    <div className="px-3 py-2 border-t border-white/[0.06]">
                        <div className="flex items-center gap-2">
                            <input
                                type="number"
                                value={customMinutes}
                                onChange={(e) => setCustomMinutes(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleCustom()}
                                placeholder="Custom"
                                min={1}
                                max={480}
                                step={1}
                                aria-label="Custom minutes"
                                className="flex-1 bg-white/[0.06] border border-white/10 rounded px-2 py-1 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand/50 w-0"
                            />
                            <span className="text-xs text-gray-500">min</span>
                        </div>
                    </div>

                    {/* Cancel button when active */}
                    {isActive && (
                        <div className="px-3 py-2 border-t border-white/[0.06]">
                            <button
                                onClick={() => {
                                    clearTimer();
                                    setIsOpen(false);
                                }}
                                className="w-full text-center text-sm text-red-400 hover:text-red-300 py-1 transition-colors"
                            >
                                Cancel Timer
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
