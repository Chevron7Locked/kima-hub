import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "@/lib/notify";
import { useAudioController } from "@/lib/audio-controller-context";
import { useAudioState } from "@/lib/audio-state-context";

/**
 * The page's one song preview. Starting one stops any other and pauses the main player, which resumes
 * when the preview is stopped, ends or fails, never when another preview takes its place; the main player
 * starting ends the preview. The preview lives in a ref, so a quick second click acts on the first before
 * the next render. A preview that failed is not asked again on this page.
 */
export function usePreview() {
    const controller = useAudioController();
    const { volume, isMuted } = useAudioState();
    const [previewId, setPreviewId] = useState<string | null>(null);
    const [playing, setPlaying] = useState(false);
    const current = useRef<{ id: string; audio: HTMLAudioElement } | null>(null);
    const pausedMain = useRef(false);
    const failed = useRef(new Set<string>());
    const level = useRef(isMuted ? 0 : volume);
    const controllerRef = useRef(controller);

    useEffect(() => {
        controllerRef.current = controller;
    }, [controller]);

    useEffect(() => {
        level.current = isMuted ? 0 : volume;
        if (current.current) current.current.audio.volume = level.current;
    }, [volume, isMuted]);

    const end = useCallback((resumeMain: boolean) => {
        const ending = current.current;
        current.current = null;
        if (ending) {
            ending.audio.onended = null;
            ending.audio.onerror = null;
            ending.audio.pause();
            ending.audio.src = "";
            ending.audio.load();
        }
        setPreviewId(null);
        setPlaying(false);
        if (resumeMain && pausedMain.current) {
            pausedMain.current = false;
            controllerRef.current?.play();
        }
    }, []);

    useEffect(() => {
        let previous: string | null = null;
        const unsubscribe = controller?.subscribe((snap) => {
            if (snap.status === "playing" && previous !== "playing" && current.current) {
                pausedMain.current = false;
                end(false);
            }
            previous = snap.status;
        });
        return () => unsubscribe?.();
    }, [controller, end]);

    useEffect(() => () => end(true), [end]);

    /** Start the preview `id` from `url`, or stop it when it is the one playing; `what` names it in messages. */
    const toggle = useCallback(
        (id: string, url: string, what = "song") => {
            if (current.current?.id === id) {
                end(true);
                return;
            }
            if (failed.current.has(id)) {
                notify.info(`No preview for this ${what}`);
                return;
            }
            end(false);
            if (controllerRef.current?.isPlaying()) {
                controllerRef.current.pause();
                pausedMain.current = true;
            }
            const audio = new Audio(url);
            audio.volume = level.current;
            current.current = { id, audio };
            setPreviewId(id);
            const isCurrent = () => current.current?.audio === audio;
            const fail = (message: string) => {
                failed.current.add(id);
                notify.info(message);
                end(true);
            };
            audio.onended = () => {
                if (isCurrent()) end(true);
            };
            audio.onerror = () => {
                if (isCurrent()) fail(`No preview for this ${what}`);
            };
            // A preview stopped before it started rejects too; only the current one is a failure.
            audio.play().then(
                () => {
                    if (isCurrent()) setPlaying(true);
                },
                () => {
                    if (isCurrent()) fail("Couldn't play this preview");
                },
            );
        },
        [end],
    );

    const stop = useCallback(() => end(true), [end]);

    return { previewId, playing, toggle, stop };
}
