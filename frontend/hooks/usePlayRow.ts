import { useCallback, useLayoutEffect, useRef } from "react";
import { useAudioPlayback, useAudioControls } from "@/lib/audio-context";

/**
 * What pressing play on a song row does. On the row that is current it pauses what is sounding, or resumes what was
 * paused from the same point; on any other row `start` runs, which starts the list from there. Rows of a memoised
 * list may hold an older copy of the callback, so whether audio is sounding is read from a ref, never from the render
 * the callback came from.
 */
export function usePlayRow() {
    const { isPlaying } = useAudioPlayback();
    const { pause, resumeWithGesture } = useAudioControls();
    const playingRef = useRef(isPlaying);
    useLayoutEffect(() => {
        playingRef.current = isPlaying;
    }, [isPlaying]);

    const playRow = useCallback(
        (isCurrent: boolean, start: () => void) => {
            if (!isCurrent) {
                start();
            } else if (playingRef.current) {
                pause();
            } else {
                void resumeWithGesture();
            }
        },
        [pause, resumeWithGesture],
    );

    return { isPlaying, playRow };
}
