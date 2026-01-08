/**
 * Format seconds into a human-readable time string
 * For durations under 1 hour: m:ss (e.g., 5:32)
 * For durations 1 hour or more: h:mm:ss (e.g., 1:05:32)
 */
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
 * Clamp a time value to be within valid bounds
 * Ensures currentTime never exceeds duration
 */
export function clampTime(currentTime: number, duration: number): number {
    if (duration <= 0) return Math.max(0, currentTime);
    return Math.min(Math.max(0, currentTime), duration);
}

/**
 * Format remaining time with negative prefix
 * For durations under 1 hour: -m:ss (e.g., -5:32)
 * For durations 1 hour or more: -h:mm:ss (e.g., -1:05:32)
 */
export function formatTimeRemaining(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return "0:00";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `-${hours}:${mins.toString().padStart(2, "0")}:${secs
            .toString()
            .padStart(2, "0")}`;
    }
    return `-${mins}:${secs.toString().padStart(2, "0")}`;
}
