"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/cn";

interface SeekSliderProps {
    /** Current progress percentage (0-100) */
    progress: number;
    /** Duration in seconds */
    duration: number;
    /** Callback when seeking to a new position */
    onSeek: (time: number) => void;
    /** Whether the slider has media loaded */
    hasMedia: boolean;
    /** Custom class name for the container */
    className?: string;
    /** Whether to show the drag handle on hover/drag */
    showHandle?: boolean;
    /** The desktop bar's look, or the full-screen player's. */
    variant?: "default" | "overlay";
}

export function SeekSlider({
    progress,
    duration,
    onSeek,
    hasMedia,
    className,
    showHandle = true,
    variant = "default",
}: SeekSliderProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [previewProgress, setPreviewProgress] = useState<number | null>(null);
    const sliderRef = useRef<HTMLDivElement>(null);
    const touchIdentifierRef = useRef<number | null>(null);

    const calculateProgress = useCallback((clientX: number): number => {
        if (!sliderRef.current) return 0;
        const rect = sliderRef.current.getBoundingClientRect();
        const x = clientX - rect.left;
        const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
        return percentage;
    }, []);

    const handleTouchStart = useCallback(
        (e: React.TouchEvent<HTMLDivElement>) => {
            // Store the touch identifier to track this specific touch
            const touch = e.touches[0];
            touchIdentifierRef.current = touch.identifier;

            setIsDragging(true);
            const newProgress = calculateProgress(touch.clientX);
            setPreviewProgress(newProgress);

            // Prevent default to avoid scrolling and stop propagation to prevent parent swipe handlers
            e.preventDefault();
            e.stopPropagation();
        },
        [calculateProgress]
    );

    const handleTouchMove = useCallback(
        (e: React.TouchEvent<HTMLDivElement>) => {
            if (!isDragging) return;

            const touch = Array.from(e.touches).find(
                (t) => t.identifier === touchIdentifierRef.current
            );

            if (!touch) return;

            const newProgress = calculateProgress(touch.clientX);
            setPreviewProgress(newProgress);

            // Prevent default to avoid scrolling and stop propagation to prevent parent swipe handlers
            e.preventDefault();
            e.stopPropagation();
        },
        [isDragging, calculateProgress]
    );

    const handleTouchEnd = useCallback(
        (e: React.TouchEvent<HTMLDivElement>) => {
            if (!isDragging) return;

            const touchEnded = !Array.from(e.touches).some(
                (t) => t.identifier === touchIdentifierRef.current
            );

            if (!touchEnded) return;

            if (previewProgress !== null) {
                const newTime = (previewProgress / 100) * duration;
                onSeek(newTime);
            }

            setIsDragging(false);
            setPreviewProgress(null);
            touchIdentifierRef.current = null;

            // Stop propagation to prevent parent swipe handlers
            e.stopPropagation();
        },
        [isDragging, previewProgress, duration, onSeek]
    );

    const handleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            setIsDragging(true);
            const newProgress = calculateProgress(e.clientX);
            setPreviewProgress(newProgress);
        },
        [calculateProgress]
    );

    const handleMouseMove = useCallback(
        (e: MouseEvent) => {
            if (!isDragging) return;

            const newProgress = calculateProgress(e.clientX);
            setPreviewProgress(newProgress);
        },
        [isDragging, calculateProgress]
    );

    const handleMouseUp = useCallback(() => {
        if (!isDragging) return;

        if (previewProgress !== null) {
            const newTime = (previewProgress / 100) * duration;
            onSeek(newTime);
        }

        setIsDragging(false);
        setPreviewProgress(null);
    }, [isDragging, previewProgress, duration, onSeek]);

    const handleClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            // Don't handle click if we just finished dragging
            if (isDragging) return;
            const newProgress = calculateProgress(e.clientX);
            const newTime = (newProgress / 100) * duration;
            onSeek(newTime);
        },
        [isDragging, calculateProgress, duration, onSeek]
    );

    useEffect(() => {
        if (isDragging) {
            window.addEventListener("mousemove", handleMouseMove);
            window.addEventListener("mouseup", handleMouseUp);

            return () => {
                window.removeEventListener("mousemove", handleMouseMove);
                window.removeEventListener("mouseup", handleMouseUp);
            };
        }
    }, [isDragging, handleMouseMove, handleMouseUp]);

    const displayProgress =
        previewProgress !== null ? previewProgress : progress;

    const getTooltipText = () => {
        if (!hasMedia) return undefined;
        return isDragging ? "release to seek" : "click or drag to seek";
    };

    const getVariantStyles = () => {
        switch (variant) {
            case "overlay":
                return {
                    container: "h-1",
                    track: "bg-white/20",
                    progress: hasMedia
                        ? "bg-gradient-to-r from-brand to-brand-dark"
                        : "bg-white/40",
                };
            default:
                return {
                    container: "h-1",
                    track: "bg-white/[0.15]",
                    progress: hasMedia ? "bg-brand" : "bg-gray-600",
                };
        }
    };

    const styles = getVariantStyles();

    return (
        <div
            ref={sliderRef}
            className={cn(
                "relative rounded-full transition-all",
                styles.container,
                styles.track,
                hasMedia ? "cursor-pointer group" : "cursor-not-allowed",
                isDragging && "h-2", // Expand when dragging
                className
            )}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleMouseDown}
            onClick={handleClick}
            title={getTooltipText()}
        >
            <div
                className={cn(
                    "h-full rounded-full relative",
                    !isDragging && "transition-[width] duration-150",
                    styles.progress
                )}
                style={{ width: `${displayProgress}%` }}
            >
                {showHandle && hasMedia && (
                    <div
                        className={cn(
                            "absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-brand rounded-full transition-opacity ",
                            isDragging
                                ? "opacity-100 scale-125"
                                : "opacity-0 group-hover:opacity-100"
                        )}
                    />
                )}
            </div>

            {isDragging && (
                <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded pointer-events-none whitespace-nowrap">
                    {Math.floor((displayProgress / 100) * duration)}s
                </div>
            )}
        </div>
    );
}
