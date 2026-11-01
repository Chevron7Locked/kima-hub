import type { ColorPalette } from "@/hooks/useImageColor";
import { CachedImage } from "@/components/ui/CachedImage";

/**
 * The backdrop melts into the page ground over its lower half instead of
 * ending on a hard edge at the first row.
 */
const FADE_MASK = {
    WebkitMaskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
    maskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
} as const;

const TINTS = {
    music: {
        overImage: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}30 0%, ${c.darkVibrant}60 50%, ${c.darkMuted}90 85%, #0a0a0a 100%)`,
        bare: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}40 0%, ${c.darkVibrant}80 50%, #0a0a0a 100%)`,
    },
    spoken: {
        overImage: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}28 0%, ${c.darkVibrant}55 50%, ${c.darkMuted}90 85%, #0a0a0a 100%)`,
        bare: (c: ColorPalette) =>
            `linear-gradient(to bottom, ${c.vibrant}30 0%, ${c.darkVibrant}60 50%, #0a0a0a 100%)`,
    },
} as const;

interface HeroBackdropProps {
    image: string | null | undefined;
    alt: string;
    colors: ColorPalette | null;
    tint: keyof typeof TINTS;
    /** Top and middle stops used when there is neither an image nor a palette. */
    fallback: [string, string];
}

/** The blurred artwork and palette gradient behind a detail page's hero. */
export function HeroBackdrop({ image, alt, colors, tint, fallback }: HeroBackdropProps) {
    const t = TINTS[tint];

    if (!image) {
        return (
            <div
                className="absolute inset-0"
                style={{
                    ...FADE_MASK,
                    background: colors
                        ? t.bare(colors)
                        : `linear-gradient(to bottom, ${fallback[0]} 0%, ${fallback[1]} 50%, #0a0a0a 100%)`,
                }}
            />
        );
    }

    return (
        <div className="absolute inset-0 overflow-hidden" style={FADE_MASK}>
            {/* The cover, heavily blurred, under a dark scrim so pale sleeves stay legible. No `sizes`: under the blur a
                larger file would only cost bytes, so it keeps the one small size it was asked for. */}
            <div className="absolute inset-0 scale-110 blur-2xl">
                <CachedImage
                    src={image}
                    alt={alt}
                    fill
                    className="object-cover"
                    priority
                />
            </div>
            <div className="absolute inset-0 bg-black/50" />
            <div
                className="absolute inset-0"
                style={{
                    background: colors
                        ? t.overImage(colors)
                        : "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.7) 40%, #0a0a0a 100%)",
                }}
            />
        </div>
    );
}
