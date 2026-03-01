import { useEffect, useState } from "react";

export interface ColorPalette {
    vibrant: string;
    darkVibrant: string;
    lightVibrant: string;
    muted: string;
    darkMuted: string;
    lightMuted: string;
}

/**
 * Extract dominant colors from an image using Canvas API
 */
function extractColorsFromImage(imageUrl: string): Promise<ColorPalette> {
    return new Promise((resolve, reject) => {
        const img = new Image();

        // ALWAYS set crossOrigin for images that need color extraction
        // This is required for Canvas.getImageData() to work
        // The backend must send Access-Control-Allow-Origin header
        img.crossOrigin = "anonymous";

        img.onload = () => {
            try {
                // Create canvas and get context
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    throw new Error("Could not get canvas context");
                }

                // Scale down for performance
                const scaleFactor = 0.1;
                canvas.width = img.width * scaleFactor;
                canvas.height = img.height * scaleFactor;

                // Draw image
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                // Get image data
                const imageData = ctx.getImageData(
                    0,
                    0,
                    canvas.width,
                    canvas.height
                );
                const pixels = imageData.data;

                // Count color frequencies, prioritizing saturated colors
                const colorMap = new Map<
                    string,
                    { count: number; saturation: number }
                >();
                for (let i = 0; i < pixels.length; i += 4) {
                    const r = pixels[i];
                    const g = pixels[i + 1];
                    const b = pixels[i + 2];
                    const a = pixels[i + 3];

                    // Skip transparent pixels
                    if (a < 125) continue;

                    // Skip extremely dark and extremely light pixels
                    const brightness = (r + g + b) / 3;
                    if (brightness < 15 || brightness > 240) continue;

                    // Calculate saturation to favor colorful pixels
                    const saturation = getSaturation(r, g, b);

                    // Reduce color precision for better grouping
                    const reducedR = Math.floor(r / 15) * 15;
                    const reducedG = Math.floor(g / 15) * 15;
                    const reducedB = Math.floor(b / 15) * 15;
                    const key = `${reducedR},${reducedG},${reducedB}`;

                    const existing = colorMap.get(key);
                    if (existing) {
                        existing.count += 1;
                        existing.saturation = Math.max(
                            existing.saturation,
                            saturation
                        );
                    } else {
                        colorMap.set(key, { count: 1, saturation });
                    }
                }

                // Sort colors by a weighted score (frequency + saturation)
                const sortedColors = Array.from(colorMap.entries())
                    .sort((a, b) => {
                        // Weight both frequency and saturation
                        const scoreA = a[1].count * (1 + a[1].saturation * 2);
                        const scoreB = b[1].count * (1 + b[1].saturation * 2);
                        return scoreB - scoreA;
                    })
                    .map(([color]) => {
                        const [r, g, b] = color.split(",").map(Number);
                        return { r, g, b };
                    });

                if (sortedColors.length === 0) {
                    // Fallback colors
                    resolve({
                        vibrant: "#1db954",
                        darkVibrant: "#121212",
                        lightVibrant: "#181818",
                        muted: "#535353",
                        darkMuted: "#121212",
                        lightMuted: "#b3b3b3",
                    });
                    return;
                }

                // Find vibrant color (highest saturation) and boost if too dark
                const vibrantColor = sortedColors.reduce((prev, curr) => {
                    const prevSat = getSaturation(prev.r, prev.g, prev.b);
                    const currSat = getSaturation(curr.r, curr.g, curr.b);
                    return currSat > prevSat ? curr : prev;
                });

                // Boost vibrant color if it's too dark - be VERY aggressive
                const vibrantBrightness =
                    (vibrantColor.r + vibrantColor.g + vibrantColor.b) / 3;
                let boostFactor: number;

                if (vibrantBrightness < 30) {
                    // Extremely dark - boost by 8-10x
                    boostFactor = 10.0;
                } else if (vibrantBrightness < 60) {
                    // Very dark - boost by 4-5x
                    boostFactor = 5.0;
                } else if (vibrantBrightness < 100) {
                    // Dark - boost by 2-3x
                    boostFactor = 3.0;
                } else if (vibrantBrightness < 140) {
                    // Somewhat dark - boost by 1.5-2x
                    boostFactor = 2.0;
                } else {
                    // Normal brightness
                    boostFactor = 1.3;
                }

                let boostedVibrant = {
                    r: Math.min(255, Math.floor(vibrantColor.r * boostFactor)),
                    g: Math.min(255, Math.floor(vibrantColor.g * boostFactor)),
                    b: Math.min(255, Math.floor(vibrantColor.b * boostFactor)),
                };

                // Ensure minimum brightness - if still too dark, add a base amount
                const boostedBrightness =
                    (boostedVibrant.r + boostedVibrant.g + boostedVibrant.b) /
                    3;
                if (boostedBrightness < 80) {
                    const addAmount = 80 - boostedBrightness;
                    boostedVibrant = {
                        r: Math.min(255, boostedVibrant.r + addAmount),
                        g: Math.min(255, boostedVibrant.g + addAmount),
                        b: Math.min(255, boostedVibrant.b + addAmount),
                    };
                }

                // Find dark vibrant (vibrant but darker than original, not boosted)
                const darkVibrantColor = {
                    r: Math.floor(vibrantColor.r * 0.6),
                    g: Math.floor(vibrantColor.g * 0.6),
                    b: Math.floor(vibrantColor.b * 0.6),
                };

                // Find light vibrant (from boosted vibrant)
                const lightVibrantColor = {
                    r: Math.min(255, Math.floor(boostedVibrant.r * 1.2)),
                    g: Math.min(255, Math.floor(boostedVibrant.g * 1.2)),
                    b: Math.min(255, Math.floor(boostedVibrant.b * 1.2)),
                };

                // Find muted color (low saturation)
                const mutedColor = sortedColors.reduce((prev, curr) => {
                    const prevSat = getSaturation(prev.r, prev.g, prev.b);
                    const currSat = getSaturation(curr.r, curr.g, curr.b);
                    return currSat < prevSat ? curr : prev;
                });

                // Dark muted
                const darkMutedColor = {
                    r: Math.floor(mutedColor.r * 0.4),
                    g: Math.floor(mutedColor.g * 0.4),
                    b: Math.floor(mutedColor.b * 0.4),
                };

                // Light muted
                const lightMutedColor = {
                    r: Math.min(255, Math.floor(mutedColor.r * 1.5)),
                    g: Math.min(255, Math.floor(mutedColor.g * 1.5)),
                    b: Math.min(255, Math.floor(mutedColor.b * 1.5)),
                };

                resolve({
                    vibrant: rgbToHex(
                        boostedVibrant.r,
                        boostedVibrant.g,
                        boostedVibrant.b
                    ),
                    darkVibrant: rgbToHex(
                        darkVibrantColor.r,
                        darkVibrantColor.g,
                        darkVibrantColor.b
                    ),
                    lightVibrant: rgbToHex(
                        lightVibrantColor.r,
                        lightVibrantColor.g,
                        lightVibrantColor.b
                    ),
                    muted: rgbToHex(mutedColor.r, mutedColor.g, mutedColor.b),
                    darkMuted: rgbToHex(
                        darkMutedColor.r,
                        darkMutedColor.g,
                        darkMutedColor.b
                    ),
                    lightMuted: rgbToHex(
                        lightMutedColor.r,
                        lightMutedColor.g,
                        lightMutedColor.b
                    ),
                });
            } catch (error) {
                reject(error);
            }
        };

        img.onerror = () => {
            reject(new Error("Failed to load image"));
        };

        img.src = imageUrl;
    });
}

/**
 * Calculate saturation of an RGB color
 */
function getSaturation(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    return max === 0 ? 0 : delta / max;
}

/**
 * Convert RGB to hex color
 */
function rgbToHex(r: number, g: number, b: number): string {
    return (
        "#" +
        [r, g, b]
            .map((x) => {
                const hex = x.toString(16);
                return hex.length === 1 ? "0" + hex : hex;
            })
            .join("")
    );
}

const PLACEHOLDER_PALETTE: ColorPalette = {
    vibrant: "#1db954",
    darkVibrant: "#121212",
    lightVibrant: "#181818",
    muted: "#535353",
    darkMuted: "#121212",
    lightMuted: "#b3b3b3",
};

function resolveSync(url: string | null | undefined): { colors: ColorPalette | null; needsAsync: boolean } {
    if (!url) return { colors: null, needsAsync: false };
    if (url.includes("placeholder") || url.startsWith("/placeholder")) {
        return { colors: PLACEHOLDER_PALETTE, needsAsync: false };
    }
    if (typeof window !== "undefined") {
        try {
            const cached = localStorage.getItem(`color_cache_${url}`);
            if (cached) return { colors: JSON.parse(cached) as ColorPalette, needsAsync: false };
        } catch { /* ignore */ }
    }
    return { colors: null, needsAsync: true };
}

export function useImageColor(imageUrl: string | null | undefined) {
    const initial = resolveSync(imageUrl);
    const [colors, setColors] = useState<ColorPalette | null>(initial.colors);
    const [isLoading, setIsLoading] = useState(initial.needsAsync);

    // Render-time adjustment when imageUrl changes
    const [prevUrl, setPrevUrl] = useState(imageUrl);
    if (imageUrl !== prevUrl) {
        setPrevUrl(imageUrl);
        const resolved = resolveSync(imageUrl);
        setColors(resolved.colors);
        setIsLoading(resolved.needsAsync);
    }

    // Async extraction for cache misses
    useEffect(() => {
        if (!imageUrl) return;
        if (imageUrl.includes("placeholder") || imageUrl.startsWith("/placeholder")) return;

        const cacheKey = `color_cache_${imageUrl}`;
        try {
            if (localStorage.getItem(cacheKey)) return;
        } catch { /* ignore */ }

        let cancelled = false;

        extractColorsFromImage(imageUrl)
            .then((palette: ColorPalette) => {
                if (cancelled) return;
                setColors(palette);
                setIsLoading(false);
                try {
                    const MAX_COLOR_CACHE = 500;
                    const allKeys = Object.keys(localStorage).filter(k => k.startsWith("color_cache_"));
                    if (allKeys.length >= MAX_COLOR_CACHE) {
                        const toRemove = allKeys.slice(0, Math.ceil(MAX_COLOR_CACHE * 0.2));
                        toRemove.forEach(k => localStorage.removeItem(k));
                    }
                    localStorage.setItem(cacheKey, JSON.stringify(palette));
                } catch { /* ignore */ }
            })
            .catch((error) => {
                if (cancelled) return;
                console.error("[useImageColor] Failed to extract colors:", error.message || error);
                setColors(PLACEHOLDER_PALETTE);
                setIsLoading(false);
                try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
            });

        return () => { cancelled = true; };
    }, [imageUrl]);

    return { colors, isLoading };
}

/**
 * Generate a gradient style object from extracted colors
 */
export function createGradient(
    colors: ColorPalette | null,
    fallbackColor: string = "#1db954"
): React.CSSProperties {
    if (!colors) {
        return {
            background: `linear-gradient(180deg, ${fallbackColor}40 0%, rgba(0, 0, 0, 0) 100%)`,
        };
    }

    // Create a gradient from dark vibrant to transparent black
    return {
        background: `linear-gradient(180deg, ${colors.darkVibrant} 0%, ${colors.darkMuted} 40%, rgba(0, 0, 0, 0.8) 70%, #000000 100%)`,
    };
}

/**
 * Generate a hero gradient (for the top section)
 */
export function createHeroGradient(
    colors: ColorPalette | null,
    fallbackColor: string = "#1db954"
): React.CSSProperties {
    if (!colors) {
        return {
            background: `linear-gradient(180deg, ${fallbackColor}60 0%, rgba(18, 18, 18, 0.9) 100%)`,
        };
    }

    // Create a more vibrant gradient for the hero section
    return {
        background: `linear-gradient(180deg, ${colors.vibrant}40 0%, ${colors.darkVibrant}80 50%, rgba(18, 18, 18, 0.95) 100%)`,
    };
}

/**
 * Calculate relative luminance for contrast ratio
 * Based on WCAG 2.0 formula: https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function getLuminance(r: number, g: number, b: number): number {
    const [rs, gs, bs] = [r, g, b].map((c) => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors
 * Returns a value between 1 and 21 (higher is better contrast)
 * WCAG AA requires 4.5:1 for normal text, 3:1 for large text
 */
function getContrastRatio(hex1: string, hex2: string): number {
    const rgb1 = hexToRgb(hex1);
    const rgb2 = hexToRgb(hex2);

    if (!rgb1 || !rgb2) return 1;

    const lum1 = getLuminance(rgb1.r, rgb1.g, rgb1.b);
    const lum2 = getLuminance(rgb2.r, rgb2.g, rgb2.b);

    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);

    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? {
              r: parseInt(result[1], 16),
              g: parseInt(result[2], 16),
              b: parseInt(result[3], 16),
          }
        : null;
}

/**
 * Get the best icon color (black or white) for a given background color
 * Returns 'black' or 'white' based on contrast ratio
 */
export function getIconColor(backgroundColor: string): "black" | "white" {
    const whiteContrast = getContrastRatio(backgroundColor, "#ffffff");
    const blackContrast = getContrastRatio(backgroundColor, "#000000");

    // Return the color with better contrast
    // Use white if contrast is close (within 1.5), as it looks better on colorful backgrounds
    return whiteContrast > blackContrast - 1.5 ? "white" : "black";
}

/**
 * Get play button styles based on vibrant color
 * Returns background color and icon color with proper contrast
 */
export function getPlayButtonStyles(colors: ColorPalette | null): {
    backgroundColor: string;
    iconColor: "black" | "white";
} {
    if (!colors) {
        return {
            backgroundColor: "#facc15", // Yellow fallback
            iconColor: "black",
        };
    }

    // Use the vibrant color for the button
    const bgColor = colors.vibrant;
    const iconColor = getIconColor(bgColor);

    return {
        backgroundColor: bgColor,
        iconColor,
    };
}
