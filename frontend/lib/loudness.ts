/**
 * Loudness normalization for the web player. The analyzer stores each track's
 * integrated loudness in LUFS (EBU R128); leveling plays every song toward
 * one reference so volume stops jumping between masters.
 *
 * Attenuation only: element volume cannot boost, and without true-peak data
 * boosting could clip. Since almost every modern master is louder than the
 * reference, leveling in practice means turning loud tracks down.
 */

export const WEB_TARGET_LUFS = -18;

/** Real integrated loudness lives in (-60, 0]; anything else is unmeasured. */
export function isValidLoudness(loudness: unknown): loudness is number {
    return (
        typeof loudness === "number" &&
        Number.isFinite(loudness) &&
        loudness > -60 &&
        loudness <= 0
    );
}

/**
 * The multiplier element volume scales by: 1 when normalization is off or
 * the track is unmeasured, otherwise 10^(dB/20) with dB = target − loudness
 * clamped to never boost. The valid range caps attenuation at 18 dB by
 * construction (0 LUFS is the loudest possible reading).
 */
export function loudnessFactor(
    loudness: number | null | undefined,
    enabled: boolean
): number {
    if (!enabled || !isValidLoudness(loudness)) return 1;
    const db = Math.min(0, WEB_TARGET_LUFS - loudness);
    return Math.pow(10, db / 20);
}
