import { useCallback, useLayoutEffect, useRef } from "react";
import { useAudioPlayback, useAudioControls } from "@/lib/audio-context";

/**
 * What pressing play on a song row does. On the row that is current it pauses what is sounding, or resumes what was
 * paused from the same point; on any other row `start` runs, which starts the list from there. Rows of a memoised
 * list may hold an older copy of the callback, so whether audio is sounding is read from a ref, never from the render
 * the callback came from.
 *
 * A double click or double tap is "play this one": on the current row it resumes a paused song and leaves a sounding
 * one alone (it never pauses, which a click, a click and a double click in a row would otherwise do).
 */
export function usePlayRow() {
    const { isPlaying } = useAudioPlayback();
    const { pause, resumeWithGesture } = useAudioControls();
    const playingRef = useRef(isPlaying);
    useLayoutEffect(() => {
        playingRef.current = isPlaying;
    }, [isPlaying]);

    const playRow = useCallback(
        (isCurrent: boolean, start: () => void, gesture: "press" | "double" = "press") => {
            if (!isCurrent) {
                start();
            } else if (playingRef.current) {
                if (gesture === "press") pause();
            } else {
                void resumeWithGesture();
            }
        },
        [pause, resumeWithGesture],
    );

    return { isPlaying, playRow };
}
