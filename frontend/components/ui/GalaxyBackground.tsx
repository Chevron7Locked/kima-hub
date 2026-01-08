"use client";

import { useMemo } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/**
 * GalaxyBackground Component
 *
 * Creates a cosmic background effect that fades up from the bottom of the page.
 * Features:
 * - Subtle gradient fading from bottom (prominent) to top (transparent)
 * - Floating star-like particles
 * - More prominent at the bottom, fading as it goes higher
 * - Customizable colors from Vibrant.js for artist/album pages
 */

interface GalaxyBackgroundProps {
    /** Primary color extracted from Vibrant.js (e.g., "#8B4789") */
    primaryColor?: string;
    /** Optional secondary color */
    secondaryColor?: string;
}

export function GalaxyBackground({ primaryColor, secondaryColor }: GalaxyBackgroundProps = {}) {
    // Performance optimization: disable animations on mobile and for reduced-motion preference
    const isMobile = useMediaQuery("(max-width: 768px)");
    const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
    const shouldDisableAnimations = isMobile || prefersReducedMotion;

    // Convert hex color to RGB values for opacity control
    const hexToRgb = (hex: string) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };

    // Use provided colors or default purple theme
    const baseColor = primaryColor ? hexToRgb(primaryColor) : null;
    const accentColor = secondaryColor ? hexToRgb(secondaryColor) : null;

    // Memoize particle positions so they don't regenerate on every render
    const particles = useMemo(() => ({
        bottom: Array(30).fill(0).map(() => ({
            left: Math.random() * 100,
            bottom: Math.random() * 30,
            duration: 3 + Math.random() * 4,
            delay: Math.random() * 3,
        })),
        mid: Array(20).fill(0).map(() => ({
            left: Math.random() * 100,
            bottom: 30 + Math.random() * 30,
            duration: 4 + Math.random() * 3,
            delay: Math.random() * 2,
        })),
        top: Array(12).fill(0).map(() => ({
            left: Math.random() * 100,
            bottom: 60 + Math.random() * 40,
            duration: 5 + Math.random() * 3,
            delay: Math.random() * 2,
        })),
        white: Array(18).fill(0).map(() => ({
            left: Math.random() * 100,
            bottom: Math.random() * 50,
            duration: 2 + Math.random() * 3,
            delay: Math.random() * 2,
        })),
        accent: Array(10).fill(0).map(() => ({
            left: Math.random() * 100,
            bottom: Math.random() * 40,
            duration: 4 + Math.random() * 4,
            delay: Math.random() * 3,
        })),
    }), []); // Empty dependency array - generate once and never again

    return (
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
            {/* Subtle gradient - fades from bottom to top */}
            {baseColor ? (
                <>
                    <div
                        className="absolute inset-0 bg-gradient-to-t to-transparent"
                        style={{
                            backgroundImage: `linear-gradient(to top, rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.15), rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.05), transparent)`
                        }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
                </>
            ) : (
                <>
                    <div className="absolute inset-0 bg-gradient-to-t from-purple-950/15 via-purple-950/5 to-transparent" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
                </>
            )}

            {/* Floating Star Particles - only render on desktop with motion enabled */}
            {!shouldDisableAnimations && (
                <>
            {/* Floating Star Particles - more concentrated at bottom */}
            {/* Bottom layer - most prominent */}
            {particles.bottom.map((p, i) => (
                <div
                    key={`bottom-purple-${i}`}
                    className={baseColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-purple-300/35 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(baseColor && {
                            backgroundColor: `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.35)`
                        })
                    }}
                />
            ))}

            {/* Middle layer - medium prominence */}
            {particles.mid.map((p, i) => (
                <div
                    key={`mid-purple-${i}`}
                    className={baseColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-indigo-300/25 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(baseColor && {
                            backgroundColor: `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.25)`
                        })
                    }}
                />
            ))}

            {/* Top layer - subtle and sparse */}
            {particles.top.map((p, i) => (
                <div
                    key={`top-purple-${i}`}
                    className={baseColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-violet-300/15 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(baseColor && {
                            backgroundColor: `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.15)`
                        })
                    }}
                />
            ))}

            {/* Accent white/blue stars scattered throughout */}
            {particles.white.map((p, i) => (
                <div
                    key={`white-star-${i}`}
                    className="absolute w-0.5 h-0.5 bg-white/30 rounded-full blur-[0.3px]"
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyTwinkle ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                    }}
                />
            ))}

            {/* Very subtle accent particles - use secondary color if available */}
            {particles.accent.map((p, i) => (
                <div
                    key={`blue-accent-${i}`}
                    className={accentColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-blue-300/25 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(accentColor && {
                            backgroundColor: `rgba(${accentColor.r}, ${accentColor.g}, ${accentColor.b}, 0.25)`
                        })
                    }}
                />
            ))}
                </>
            )}
        </div>
    );
}
