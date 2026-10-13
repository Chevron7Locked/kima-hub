import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useAudioControls } from '@/lib/audio-context';
import type { Track as PlaybackTrack } from '@/lib/audio-context';
import { toPlaybackTrack, PlayableRow } from '@/lib/playback-track';
import { Artist, Album, Track } from '../types';
import { shuffleArray } from '@/lib/shuffle';

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
  // Rows enter the player through the canonical mapper; keep the player's own contract as the type.
  const allTracks: PlaybackTrack[] = [];

  albumsData.forEach((albumData, index) => {
    if (!albumData || !albumData.tracks) return;

    const album = ownedAlbums[index];
    const formattedTracks = albumData.tracks.map((track: Record<string, unknown>) => ({
      ...track,
      discNumber: Number(track.discNumber ?? 1),
      trackNumber: Number(track.trackNumber ?? 0),
    })) as (PlayableRow & { discNumber: number; trackNumber: number })[];

    // Sort by disc, then track number.
    formattedTracks.sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
    allTracks.push(
      ...formattedTracks.map((track) =>
        toPlaybackTrack({
          ...track,
          artist: { id: artist.id, name: artist.name },
          album: { id: album.id, title: album.title, coverArt: album.coverArt },
        })
      )
    );
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
      playTrackFromContext(
        toPlaybackTrack({
          ...track,
          artist: { name: artist.name, id: artist.id },
        })
      );
    },
    [playTrackFromContext]
  );

  return {
    playAll,
    shufflePlay,
    playTrack,
  };
}
