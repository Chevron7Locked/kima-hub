import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { clampTime } from "@/utils/formatTime";

/**
 * Shared hook for duration, displayTime, and progress calculations.
 * Used by FullPlayer, MiniPlayer, and OverlayPlayer to avoid duplication.
 *
 * - Prefers engine-reported duration over metadata (RSS durations are unreliable)
 * - Shows saved progress for audiobooks/podcasts before playback starts
 * - Clamps all values to prevent invalid display
 */
export function usePlaybackProgress() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
    } = useAudioState();

    const {
        currentTime,
        duration: playbackDuration,
    } = useAudioPlayback();

    const isMultiTrack = playbackType === "audiobook" && (currentAudiobook?.tracks?.length ?? 0) > 1;

    const duration = isMultiTrack
        ? (currentAudiobook?.duration || playbackDuration || 0)
        : playbackDuration > 0
            ? playbackDuration
            : (currentTrack?.duration || currentAudiobook?.duration || currentPodcast?.duration || 0);

    let time = currentTime;
    if (time <= 0) {
        if (playbackType === "audiobook" && currentAudiobook?.progress?.currentTime) {
            time = currentAudiobook.progress.currentTime;
        } else if (playbackType === "podcast" && currentPodcast?.progress?.currentTime) {
            time = currentPodcast.progress.currentTime;
        }
    }
    const displayTime = clampTime(time, duration);

    const progress = duration > 0
        ? Math.min(100, Math.max(0, (displayTime / duration) * 100))
        : 0;

    return { duration, displayTime, progress };
}
