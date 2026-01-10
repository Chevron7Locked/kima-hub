"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/utils/cn";

interface SeekSliderProps {
    /** Current progress percentage (0-100) */
    progress: number;
    /** Duration in seconds */
    duration: number;
    /** Current time in seconds */
    currentTime: number;
    /** Callback when seeking to a new position */
    onSeek: (time: number) => void;
    /** Whether seeking is enabled */
    canSeek: boolean;
    /** Whether the slider has media loaded */
    hasMedia: boolean;
    /** Download progress (0-100) if downloading */
    downloadProgress?: number | null;
    /** Custom class name for the container */
    className?: string;
    /** Whether to show the drag handle on hover/drag */
    showHandle?: boolean;
    /** Variant styling */
    variant?: "default" | "minimal" | "overlay";
}

export function SeekSlider({
    progress,
    duration,
    currentTime,
    onSeek,
    canSeek,
    hasMedia,
    downloadProgress,
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
            if (!canSeek) return;

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
        [canSeek, calculateProgress]
    );

    const handleTouchMove = useCallback(
        (e: React.TouchEvent<HTMLDivElement>) => {
            if (!isDragging || !canSeek) return;

            // Find the touch that we're tracking
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
        [isDragging, canSeek, calculateProgress]
    );

    const handleTouchEnd = useCallback(
        (e: React.TouchEvent<HTMLDivElement>) => {
            if (!isDragging || !canSeek) return;

            // Check if the touch we're tracking ended
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
        [isDragging, canSeek, previewProgress, duration, onSeek]
    );

    const handleMouseDown = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (!canSeek) return;

            setIsDragging(true);
            const newProgress = calculateProgress(e.clientX);
            setPreviewProgress(newProgress);
        },
        [canSeek, calculateProgress]
    );

    const handleMouseMove = useCallback(
        (e: MouseEvent) => {
            if (!isDragging || !canSeek) return;

            const newProgress = calculateProgress(e.clientX);
            setPreviewProgress(newProgress);
        },
        [isDragging, canSeek, calculateProgress]
    );

    const handleMouseUp = useCallback(() => {
        if (!isDragging || !canSeek) return;

        if (previewProgress !== null) {
            const newTime = (previewProgress / 100) * duration;
            onSeek(newTime);
        }

        setIsDragging(false);
        setPreviewProgress(null);
    }, [isDragging, canSeek, previewProgress, duration, onSeek]);

    const handleClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            // Don't handle click if we just finished dragging
            if (isDragging) return;
            if (!canSeek) return;

            const newProgress = calculateProgress(e.clientX);
            const newTime = (newProgress / 100) * duration;
            onSeek(newTime);
        },
        [isDragging, canSeek, calculateProgress, duration, onSeek]
    );

    // Add global mouse event listeners when dragging
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
    const isActive = canSeek && hasMedia;

    // Determine tooltip text
    const getTooltipText = () => {
        if (!hasMedia) return undefined;
        if (!canSeek) {
            return downloadProgress !== null
                ? `Downloading ${downloadProgress}%... Seek will be available when cached`
                : "Downloading... Seeking will be available when cached";
        }
        return isDragging ? "Release to seek" : "Click or drag to seek";
    };

    // Variant-specific styles
    const getVariantStyles = () => {
        switch (variant) {
            case "minimal":
                return {
                    container: "h-1",
                    track: "bg-white/[0.15]",
                    progress: isActive
                        ? "bg-white"
                        : hasMedia
                        ? "bg-white/50"
                        : "bg-gray-600",
                };
            case "overlay":
                return {
                    container: "h-1",
                    track: "bg-white/20",
                    progress: isActive
                        ? "bg-gradient-to-r from-[#f5c518] to-[#a855f7]"
                        : "bg-white/40",
                };
            default:
                return {
                    container: "h-1",
                    track: "bg-white/[0.15]",
                    progress: isActive
                        ? "bg-white group-hover:bg-white"
                        : hasMedia
                        ? "bg-white/50"
                        : "bg-gray-600",
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
                isActive ? "cursor-pointer group" : "cursor-not-allowed",
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
                    !isDragging && "transition-all duration-150",
                    styles.progress
                )}
                style={{ width: `${displayProgress}%` }}
            >
                {showHandle && isActive && (
                    <div
                        className={cn(
                            "absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full transition-opacity shadow-lg shadow-white/50",
                            isDragging
                                ? "opacity-100 scale-125"
                                : "opacity-0 group-hover:opacity-100"
                        )}
                    />
                )}
            </div>

            {/* Visual feedback when dragging */}
            {isDragging && (
                <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded pointer-events-none whitespace-nowrap">
                    {Math.floor((displayProgress / 100) * duration)}s
                </div>
            )}
        </div>
    );
}
