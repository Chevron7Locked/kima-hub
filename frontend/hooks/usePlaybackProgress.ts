import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { clampTime, playbackLength } from "@/lib/format";

/**
 * Duration, display time and progress for every player. Prefers the engine's
 * duration over metadata (RSS durations are unreliable), shows saved progress
 * for audiobooks and podcasts before playback starts, and clamps everything.
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

    const duration = playbackLength({
        multiFile: isMultiTrack,
        stored: currentTrack?.duration || currentAudiobook?.duration || currentPodcast?.duration || 0,
        engine: playbackDuration,
    });

    let time = currentTime;
    if (time <= 0) {
        if (playbackType === "audiobook" && currentAudiobook?.progress?.currentTime) {
            time = currentAudiobook.progress.currentTime;
        } else if (playbackType === "podcast" && currentPodcast?.progress?.currentTime) {
            time = currentPodcast.progress.currentTime;
        }
    }
    // Without the engine's length the metadata's stands in, and it can be short (a feed's length
    // misses stitched-in ads): the clock keeps running past it instead of freezing there.
    const shownDuration = playbackDuration > 0 || isMultiTrack ? duration : Math.max(duration, time);
    const displayTime = clampTime(time, shownDuration);

    const progress = shownDuration > 0
        ? Math.min(100, Math.max(0, (displayTime / shownDuration) * 100))
        : 0;

    return { duration: shownDuration, displayTime, progress };
}
