"use client";

import { useCallback } from "react";
import { useAudio } from "@/lib/audio-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState } from "@/lib/audio-state-context";
import { notify } from "@/lib/notify";
import { api } from "@/lib/api";
import type { Audiobook } from "../types";

export function useAudiobookActions(
  audiobookId: string,
  audiobook: Audiobook | null,
  refetch: () => void
) {
  const {
    currentAudiobook,
    playbackType,
    isPlaying,
    pause,
    resumeWithGesture,
    playAudiobook,
    currentTime,
    updateCurrentTime,
    seek,
  } = useAudio();
  const { playAudiobookAt } = useAudioControls();
  const { setCurrentAudiobook } = useAudioState();

  const isThisBookPlaying =
    currentAudiobook?.id === audiobookId && playbackType === "audiobook";

  const handlePlayPause = useCallback(() => {
    if (!audiobook) return;

    // If no audiobook playing, or a DIFFERENT audiobook is playing, start this one
    if (!currentAudiobook || currentAudiobook.id !== audiobookId) {
      playAudiobook(audiobook);
    } else if (isPlaying) {
      // Same audiobook is playing - pause it
      pause();
    } else {
      // Same audiobook is paused - resume it
      resumeWithGesture();
    }
  }, [audiobook, audiobookId, currentAudiobook, isPlaying, pause, resumeWithGesture, playAudiobook]);

  const handleMarkAsCompleted = useCallback(async () => {
    if (!audiobook) return;

    try {
      const isCurrentlyPlaying =
        currentAudiobook?.id === audiobookId && playbackType === "audiobook";

      if (isCurrentlyPlaying && isPlaying) {
        pause();
      }

      await api.updateAudiobookProgress(
        audiobookId,
        audiobook.duration || 0,
        audiobook.duration || 0,
        true
      );

      if (currentAudiobook?.id === audiobookId) {
        const finalDuration = audiobook.duration || currentAudiobook.duration || 0;
        setCurrentAudiobook({
          ...currentAudiobook,
          progress: {
            currentTime: finalDuration,
            progress: finalDuration > 0 ? 100 : 0,
            isFinished: true,
            lastPlayedAt: new Date(),
          },
        });
      }

      refetch();
    } catch (error) {
      console.error("Failed to mark as completed:", error);
      notify.error("Failed to mark as completed");
    }
  }, [
    audiobook,
    audiobookId,
    currentAudiobook,
    playbackType,
    isPlaying,
    pause,
    setCurrentAudiobook,
    refetch,
  ]);

  const handleResetProgress = useCallback(async () => {
    try {
      const isCurrentlyPlaying =
        currentAudiobook?.id === audiobookId && playbackType === "audiobook";

      if (isCurrentlyPlaying && isPlaying) {
        pause();
      }

      await api.deleteAudiobookProgress(audiobookId);

      if (currentAudiobook?.id === audiobookId) {
        // The type stays, as a cleared queue's does: it carries the save that tells the server the book is gone.
        setCurrentAudiobook(null);
        updateCurrentTime(0);
      }

      refetch();
    } catch (error) {
      console.error("Failed to reset progress:", error);
      notify.error("Failed to reset progress");
    }
  }, [
    audiobookId,
    currentAudiobook,
    playbackType,
    isPlaying,
    pause,
    setCurrentAudiobook,
    updateCurrentTime,
    refetch,
  ]);

  const seekToSection = useCallback(
    (startTime: number) => {
      if (!audiobook) return;

      if (!isThisBookPlaying) {
        playAudiobookAt(audiobook, startTime);
        return;
      }

      seek(startTime);
    },
    [audiobook, isThisBookPlaying, playAudiobookAt, seek]
  );

  return {
    isThisBookPlaying,
    isPlaying,
    currentTime,
    handlePlayPause,
    handleMarkAsCompleted,
    handleResetProgress,
    seekToSection,
  };
}
