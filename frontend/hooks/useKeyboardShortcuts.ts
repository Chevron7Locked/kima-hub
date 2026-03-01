import { useEffect, useRef } from 'react';
import { useAudio } from "@/lib/audio-context";
import { useIsTV } from '@/lib/tv-utils';

/**
 * Global keyboard shortcuts for media playback
 *
 * Shortcuts:
 * - Space: Play/Pause
 * - Arrow Right: Seek forward 10s
 * - Arrow Left: Seek backward 10s
 * - Arrow Up: Volume up 10%
 * - Arrow Down: Volume down 10%
 * - M: Toggle mute
 * - N: Next track
 * - P: Previous track
 * - S: Toggle shuffle
 */
export function useKeyboardShortcuts() {
  const isTV = useIsTV();
  const {
    isPlaying,
    resumeWithGesture,
    pause,
    next,
    previous,
    seek,
    currentTime,
    setVolume,
    volume,
    toggleMute,
    toggleShuffle,
    playbackType,
    currentTrack,
    currentAudiobook,
    currentPodcast,
  } = useAudio();

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const pauseRef = useRef(pause);
  useEffect(() => { pauseRef.current = pause; }, [pause]);

  const resumeWithGestureRef = useRef(resumeWithGesture);
  useEffect(() => { resumeWithGestureRef.current = resumeWithGesture; }, [resumeWithGesture]);

  const nextRef = useRef(next);
  useEffect(() => { nextRef.current = next; }, [next]);

  const previousRef = useRef(previous);
  useEffect(() => { previousRef.current = previous; }, [previous]);

  const seekRef = useRef(seek);
  useEffect(() => { seekRef.current = seek; }, [seek]);

  const currentTimeRef = useRef(currentTime);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  const setVolumeRef = useRef(setVolume);
  useEffect(() => { setVolumeRef.current = setVolume; }, [setVolume]);

  const volumeRef = useRef(volume);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  const toggleMuteRef = useRef(toggleMute);
  useEffect(() => { toggleMuteRef.current = toggleMute; }, [toggleMute]);

  const toggleShuffleRef = useRef(toggleShuffle);
  useEffect(() => { toggleShuffleRef.current = toggleShuffle; }, [toggleShuffle]);

  const currentTrackRef = useRef(currentTrack);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);

  const currentAudiobookRef = useRef(currentAudiobook);
  useEffect(() => { currentAudiobookRef.current = currentAudiobook; }, [currentAudiobook]);

  const currentPodcastRef = useRef(currentPodcast);
  useEffect(() => { currentPodcastRef.current = currentPodcast; }, [currentPodcast]);

  useEffect(() => {
    // Disable keyboard shortcuts on TV - use remote's media keys instead
    if (isTV) return;

    // Don't add shortcuts if nothing is loaded
    if (!playbackType) return;

    const handleKeyPress = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      // Prevent default for media keys to avoid conflicts
      if ([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
      }

      switch (e.key.toLowerCase()) {
        case ' ': // Space - Play/Pause
          if (isPlayingRef.current) {
            pauseRef.current();
          } else {
            resumeWithGestureRef.current();
          }
          break;

        case 'arrowright': // Right arrow - Seek forward 10s
          if (playbackType === 'track' || playbackType === 'audiobook' || playbackType === 'podcast') {
            const duration = currentTrackRef.current?.duration || currentAudiobookRef.current?.duration || currentPodcastRef.current?.duration || 0;
            seekRef.current(Math.min(currentTimeRef.current + 10, duration));
          }
          break;

        case 'arrowleft': // Left arrow - Seek backward 10s
          if (playbackType === 'track' || playbackType === 'audiobook' || playbackType === 'podcast') {
            seekRef.current(Math.max(currentTimeRef.current - 10, 0));
          }
          break;

        case 'arrowup': // Up arrow - Volume up 10%
          setVolumeRef.current(Math.min(volumeRef.current + 0.1, 1));
          break;

        case 'arrowdown': // Down arrow - Volume down 10%
          setVolumeRef.current(Math.max(volumeRef.current - 0.1, 0));
          break;

        case 'm': // M - Toggle mute
          toggleMuteRef.current();
          break;

        case 'n': // N - Next track
          if (playbackType === 'track') {
            nextRef.current();
          }
          break;

        case 'p': // P - Previous track
          if (playbackType === 'track' && !e.shiftKey) { // Avoid conflict with Shift+P
            previousRef.current();
          }
          break;

        case 's': // S - Toggle shuffle
          if (playbackType === 'track') {
            toggleShuffleRef.current();
          }
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isTV, playbackType]);
}
