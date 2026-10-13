import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useAudioControls } from '@/lib/audio-context';
import { Artist, Album, Track } from '../types';
import { shuffleArray } from '@/lib/shuffle';

interface FormattedTrack {
  id: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  artist: { name: string; id: string };
  album: { title: string; coverArt?: string; id: string; year?: number };
  duration: number;
}

async function loadAllOwnedTracks(artist: Artist, albums: Album[]) {
  const ownedAlbums = albums
    .filter((album) => album.owned)
    .sort((a, b) => (b.year || 0) - (a.year || 0));

  if (ownedAlbums.length === 0) {
    return [];
  }

  const albumDataPromises = ownedAlbums.map((album) =>
    api.getAlbum(album.id).catch(() => null)
  );

  const albumsData = await Promise.all(albumDataPromises);

  // Combine all tracks, maintaining album order (newest first)
  const allTracks: FormattedTrack[] = [];

  albumsData.forEach((albumData, index) => {
    if (!albumData || !albumData.tracks) return;

    const album = ownedAlbums[index];
    const formattedTracks = albumData.tracks.map((track: Record<string, unknown>) => ({
      id: track.id,
      title: track.title,
      trackNumber: Number(track.trackNumber ?? 0),
      discNumber: Number(track.discNumber ?? 1),
      artist: { name: artist.name, id: artist.id },
      album: {
        title: album.title,
        coverArt: album.coverArt,
        id: album.id,
        year: album.year,
      },
      duration: track.duration,
    }));

    // Sort tracks within album by disc number then track number
    formattedTracks.sort((a: FormattedTrack, b: FormattedTrack) =>
      a.discNumber - b.discNumber || a.trackNumber - b.trackNumber
    );
    allTracks.push(...formattedTracks);
  });

  return allTracks;
}

export function useArtistActions() {
  // Use controls-only hook to avoid re-renders from playback state changes
  const { playTrack: playTrackFromContext, playTracks } = useAudioControls();

  const playOwnedTracks = useCallback(
    async (artist: Artist | null, albums: Album[], shuffle: boolean) => {
      if (!artist) {
        return;
      }

      try {
        const allTracks = await loadAllOwnedTracks(artist, albums);

        if (allTracks.length === 0) {
          return;
        }

        // Unshuffled order is newest album first, track 1 to end, then the next album
        playTracks(shuffle ? shuffleArray(allTracks) : allTracks);
      } catch (error) {
        console.error('Failed to play artist:', error);
      }
    },
    [playTracks]
  );

  const playAll = useCallback(
    (artist: Artist | null, albums: Album[]) => playOwnedTracks(artist, albums, false),
    [playOwnedTracks]
  );

  const shufflePlay = useCallback(
    (artist: Artist | null, albums: Album[]) => playOwnedTracks(artist, albums, true),
    [playOwnedTracks]
  );

  const playTrack = useCallback(
    (track: Track, artist: Artist) => {
      playTrackFromContext({
        id: track.id,
        title: track.title,
        artist: { name: artist.name, id: artist.id },
        album: {
          title: track.album?.title || 'Unknown Album',
          coverArt: track.album?.coverArt,
          id: track.album?.id,
        },
        duration: track.duration,
      });
    },
    [playTrackFromContext]
  );

  return {
    playAll,
    shufflePlay,
    playTrack,
  };
}
