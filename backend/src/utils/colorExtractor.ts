import sharp from "sharp";
import { logger } from "./logger";

interface ColorPalette {
    vibrant: string;
    darkVibrant: string;
    lightVibrant: string;
    muted: string;
    darkMuted: string;
    lightMuted: string;
}

interface RGBColor {
    r: number;
    g: number;
    b: number;
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

/**
 * Extract dominant colors from an image buffer using sharp
 */
export async function extractColorsFromImage(
    imageBuffer: Buffer
): Promise<ColorPalette> {
    try {
        // Resize image to 100x100 for performance
        const { data, info } = await sharp(imageBuffer)
            .resize(100, 100, { fit: "inside" })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const pixels = data;
        const colorMap = new Map<
            string,
            { count: number; saturation: number }
        >();

        // Count color frequencies
        for (let i = 0; i < pixels.length; i += info.channels) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const a = info.channels === 4 ? pixels[i + 3] : 255;

            // Skip transparent pixels
            if (a < 125) continue;

            // Skip extremely dark and extremely light pixels
            const brightness = (r + g + b) / 3;
            if (brightness < 15 || brightness > 240) continue;

            // Calculate saturation
            const saturation = getSaturation(r, g, b);

            // Reduce color precision for better grouping
            const reducedR = Math.floor(r / 15) * 15;
            const reducedG = Math.floor(g / 15) * 15;
            const reducedB = Math.floor(b / 15) * 15;
            const key = `${reducedR},${reducedG},${reducedB}`;

            const existing = colorMap.get(key);
            if (existing) {
                existing.count += 1;
                existing.saturation = Math.max(existing.saturation, saturation);
            } else {
                colorMap.set(key, { count: 1, saturation });
            }
        }

        // Sort colors by weighted score
        const sortedColors = Array.from(colorMap.entries())
            .sort((a, b) => {
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
            return {
                vibrant: "#1db954",
                darkVibrant: "#121212",
                lightVibrant: "#181818",
                muted: "#535353",
                darkMuted: "#121212",
                lightMuted: "#b3b3b3",
            };
        }

        // Find vibrant color
        const vibrantColor = sortedColors.reduce((prev, curr) => {
            const prevSat = getSaturation(prev.r, prev.g, prev.b);
            const currSat = getSaturation(curr.r, curr.g, curr.b);
            return currSat > prevSat ? curr : prev;
        });

        // Boost vibrant color if too dark
        const vibrantBrightness =
            (vibrantColor.r + vibrantColor.g + vibrantColor.b) / 3;
        let boostFactor: number;

        if (vibrantBrightness < 30) {
            boostFactor = 10.0;
        } else if (vibrantBrightness < 60) {
            boostFactor = 5.0;
        } else if (vibrantBrightness < 100) {
            boostFactor = 3.0;
        } else if (vibrantBrightness < 140) {
            boostFactor = 2.0;
        } else {
            boostFactor = 1.3;
        }

        let boostedVibrant = {
            r: Math.min(255, Math.floor(vibrantColor.r * boostFactor)),
            g: Math.min(255, Math.floor(vibrantColor.g * boostFactor)),
            b: Math.min(255, Math.floor(vibrantColor.b * boostFactor)),
        };

        // Ensure minimum brightness
        const boostedBrightness =
            (boostedVibrant.r + boostedVibrant.g + boostedVibrant.b) / 3;
        if (boostedBrightness < 80) {
            const addAmount = 80 - boostedBrightness;
            boostedVibrant = {
                r: Math.min(255, boostedVibrant.r + addAmount),
                g: Math.min(255, boostedVibrant.g + addAmount),
                b: Math.min(255, boostedVibrant.b + addAmount),
            };
        }

        // Dark vibrant
        const darkVibrantColor = {
            r: Math.floor(vibrantColor.r * 0.6),
            g: Math.floor(vibrantColor.g * 0.6),
            b: Math.floor(vibrantColor.b * 0.6),
        };

        // Light vibrant
        const lightVibrantColor = {
            r: Math.min(255, Math.floor(boostedVibrant.r * 1.2)),
            g: Math.min(255, Math.floor(boostedVibrant.g * 1.2)),
            b: Math.min(255, Math.floor(boostedVibrant.b * 1.2)),
        };

        // Find muted color
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

        return {
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
        };
    } catch (error) {
        logger.error("[ColorExtractor] Failed to extract colors:", error);
        // Return fallback colors
        return {
            vibrant: "#1db954",
            darkVibrant: "#121212",
            lightVibrant: "#181818",
            muted: "#535353",
            darkMuted: "#121212",
            lightMuted: "#b3b3b3",
        };
    }
}
