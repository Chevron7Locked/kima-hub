/** Seconds as m:ss, or h:mm:ss from an hour up. */
export function formatTime(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, "0")}:${secs
            .toString()
            .padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format seconds into a human-readable duration string
 * Always shows full format for clarity (e.g., "2h 30m" or "45m")
 */
export function formatDuration(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0m";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        if (mins > 0) {
            return `${hours}h ${mins}m`;
        }
        return `${hours}h`;
    }
    return `${mins}m`;
}

/**
 * How long what is playing is, for the progress bar and for seeking alike. A multi-file audiobook is its whole
 * stored length (the engine sees one file at a time). Anything else is the engine's length once it has one (a feed's
 * stored length misses stitched-in ads, a tag can be off), and the stored length until then.
 */
export function playbackLength({ multiFile, stored, engine }: { multiFile: boolean; stored: number; engine: number }): number {
    if (multiFile) return stored > 0 ? stored : 0;
    return engine > 0 ? engine : stored > 0 ? stored : 0;
}

/**
 * Clamp a time value to be within valid bounds
 * Ensures currentTime never exceeds duration
 */
export function clampTime(currentTime: number, duration: number): number {
    if (duration <= 0) return Math.max(0, currentTime);
    return Math.min(Math.max(0, currentTime), duration);
}

/** Remaining time as -m:ss or -h:mm:ss; nothing left reads as 0:00. */
function formatTimeRemaining(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return "0:00";
    return `-${formatTime(seconds)}`;
}

/** Spoken media counts down; music shows total length. */
export function formatMediaDuration(
    playbackType: string | null,
    duration: number,
    currentTime: number,
): string {
    return playbackType === "podcast" || playbackType === "audiobook"
        ? formatTimeRemaining(Math.max(0, duration - currentTime))
        : formatTime(duration);
}

export function formatNumber(num: number): string {
    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
        return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
}

/** Listener counts in compact form ("5.1M listeners"); no count reads as "Artist". */
export function formatListeners(count: number | undefined): string {
    if (!count || count === 0) return "Artist";

    if (count >= 1000000) {
        return `${(count / 1000000).toFixed(1)}M listeners`;
    }

    if (count >= 1000) {
        return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K listeners`;
    }

    return `${count.toLocaleString()} listeners`;
}

export function normalizeNFC(str: string): string {
    return str.normalize("NFC");
}

export function plural(n: number, word: string): string {
    return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** A version as people say it: 1.12.0 → 1.12. */
export function shortVersion(version: string): string {
    return version.split(".").slice(0, 2).join(".");
}

/** A length of time as "2 hr 5 min", or "45 min" under an hour. */
export function formatHoursMinutes(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`;
}
