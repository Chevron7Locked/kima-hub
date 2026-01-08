"use client";

import { useState, useRef, useCallback, ReactNode, TouchEvent } from "react";
import { GradientSpinner } from "./GradientSpinner";
import { RefreshCw } from "lucide-react";

interface PullToRefreshProps {
    children: ReactNode;
    threshold?: number;
}

export function PullToRefresh({
    children,
    threshold = 80,
}: PullToRefreshProps) {
    // HOTFIX v1.3.2: Temporarily disabled - blocking mobile scrolling
    // TODO: Fix in v1.4 - Issues: 1) h-full breaks flex layout, 2) touch handlers may interfere
    // Proper fix: Change line 90 className to "relative flex-1 flex flex-col min-h-0"
    return <>{children}</>;

    const [pullDistance, setPullDistance] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const startY = useRef(0);
    const isPulling = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const handleTouchStart = useCallback((e: TouchEvent) => {
        // Only allow pull-to-refresh when scrolled to the top
        const container = containerRef.current;
        if (!container) return;

        // Check if the main element inside is scrolled to top
        const mainElement = container.querySelector("main");
        if (mainElement && mainElement.scrollTop === 0) {
            startY.current = e.touches[0].clientY;
            isPulling.current = true;
        }
    }, []);

    const handleTouchMove = useCallback(
        (e: TouchEvent) => {
            if (!isPulling.current || isRefreshing) return;

            const currentY = e.touches[0].clientY;
            const distance = currentY - startY.current;

            // Only track downward pulls
            if (distance > 0) {
                // Apply resistance factor for smoother feel
                const resistance = 0.5;
                const adjustedDistance = distance * resistance;

                setPullDistance(adjustedDistance);

                // Prevent default scroll behavior when pulling
                if (adjustedDistance > 10) {
                    e.preventDefault();
                }
            }
        },
        [isRefreshing]
    );

    const handleTouchEnd = useCallback(() => {
        if (!isPulling.current) return;

        isPulling.current = false;

        // Check if we've pulled past the threshold
        if (pullDistance >= threshold) {
            setIsRefreshing(true);
            setPullDistance(threshold); // Lock at threshold during refresh

            // Trigger full page reload after a brief delay for visual feedback
            setTimeout(() => {
                window.location.reload();
            }, 300);
        } else {
            // Reset if not past threshold
            setPullDistance(0);
        }
    }, [pullDistance, threshold]);

    // Calculate visual properties based on pull progress
    const pullProgress = Math.min(pullDistance / threshold, 1);
    const showIndicator = pullDistance > 0;
    const shouldRelease = pullDistance >= threshold;

    return (
        <div
            ref={containerRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="relative h-full"
            style={{ touchAction: "pan-y" }}
        >
            {/* Pull-to-refresh indicator */}
            {showIndicator && (
                <div
                    className="absolute top-0 left-0 right-0 z-50 flex flex-col items-center justify-center pointer-events-none"
                    style={{
                        transform: `translateY(${Math.min(pullDistance, threshold + 20)}px)`,
                        opacity: pullProgress,
                        transition: isPulling.current
                            ? "none"
                            : "transform 0.3s ease-out, opacity 0.3s ease-out",
                        willChange: "transform",
                    }}
                >
                    <div className="bg-black/80 backdrop-blur-sm rounded-full p-3 shadow-lg border border-white/10">
                        {isRefreshing ? (
                            <GradientSpinner size="sm" />
                        ) : (
                            <RefreshCw
                                className={`w-5 h-5 text-white transition-transform ${
                                    shouldRelease ? "rotate-180" : ""
                                }`}
                                style={{
                                    transform: `rotate(${pullDistance * 2}deg)`,
                                }}
                            />
                        )}
                    </div>
                    <p className="text-white/80 text-xs mt-2 font-medium">
                        {isRefreshing
                            ? "Refreshing..."
                            : shouldRelease
                            ? "Release to refresh"
                            : "Pull to refresh"}
                    </p>
                </div>
            )}

            {children}
        </div>
    );
}
