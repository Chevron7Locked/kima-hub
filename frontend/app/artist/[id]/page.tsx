"use client";

import { useRouter } from "next/navigation";
import { useAudio } from "@/lib/audio-context";
import { useDownloadContext } from "@/lib/download-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { api } from "@/lib/api";
import { toast } from "sonner";

// Hooks
import { useArtistData } from "@/features/artist/hooks/useArtistData";
import { useArtistActions } from "@/features/artist/hooks/useArtistActions";
import { useDownloadActions } from "@/features/artist/hooks/useDownloadActions";
import { usePreviewPlayer } from "@/features/artist/hooks/usePreviewPlayer";

// Components
import { ArtistHero } from "@/features/artist/components/ArtistHero";
import { ArtistActionBar } from "@/features/artist/components/ArtistActionBar";
import { ArtistBio } from "@/features/artist/components/ArtistBio";
import { PopularTracks } from "@/features/artist/components/PopularTracks";
import { Discography } from "@/features/artist/components/Discography";
import { AvailableAlbums } from "@/features/artist/components/AvailableAlbums";
import { SimilarArtists } from "@/features/artist/components/SimilarArtists";

export default function ArtistPage() {
  const router = useRouter();
  const { currentTrack, playTracks, isPlaying, pause } = useAudio();
  const { isPendingByMbid } = useDownloadContext();

  // Data hook
  const { artist, albums, loading, error, source, sortBy, setSortBy, reloadArtist } = useArtistData();

  // Action hooks
  const { playAll, shufflePlay } = useArtistActions();
  const { downloadArtist, downloadAlbum } = useDownloadActions();
  const { previewTrack, previewPlaying, handlePreview } = usePreviewPlayer();

  // Separate owned and available albums
  const ownedAlbums = albums.filter((a) => a.owned);
  const availableAlbums = albums.filter((a) => !a.owned);

  // Get image URLs for display and color extraction
  const rawImageUrl =
    artist && source === "library"
      ? artist.coverArt
      : artist?.image || null;
  const heroImage = rawImageUrl ? api.getCoverArtUrl(rawImageUrl, 1200) : null;
  const { colors } = useImageColor(heroImage || rawImageUrl);

  // Play album handler
  async function handlePlayAlbum(albumId: string, albumTitle: string) {
    try {
      const albumData = await api.getAlbum(albumId);
      if (albumData.tracks && albumData.tracks.length > 0) {
        const tracksWithAlbum = albumData.tracks.map((track: any) => ({
          ...track,
          album: {
            id: albumData.id,
            title: albumData.title,
            coverArt: albumData.coverArt,
          },
          artist: albumData.artist,
        }));
        playTracks(tracksWithAlbum, 0);
        toast.success(`Playing ${albumTitle}`);
      }
    } catch (error) {
      console.error("Failed to play album:", error);
      toast.error("Failed to play album");
    }
  }

  // Play track handler (for popular tracks)
  function handlePlayTrack(track: any) {
    if (!artist?.topTracks) return;

    const playableTracks = artist.topTracks.filter((t: any) => t.album?.id);
    const formattedTracks = playableTracks.map((t: any) => ({
      id: t.id,
      title: t.title,
      artist: { name: artist.name, id: artist.id },
      album: {
        title: t.album?.title || "Unknown",
        coverArt: t.album?.coverArt,
        id: t.album?.id,
      },
      duration: t.duration,
    }));

    const startIndex = formattedTracks.findIndex((t: any) => t.id === track.id);
    playTracks(formattedTracks, Math.max(0, startIndex));
  }

  // Download album handler
  function handleDownloadAlbum(album: any, e: React.MouseEvent) {
    downloadAlbum(album, artist?.name || "", e);
  }

  // Start artist radio handler
  async function handleStartRadio() {
    if (!artist) return;
    
    try {
      toast.success(`Starting ${artist.name} Radio...`);
      const response = await api.getRadioTracks("artist", artist.id);
      
      if (response.tracks && response.tracks.length > 0) {
        // Backend already returns properly formatted tracks - just pass them through
        playTracks(response.tracks, 0);
        toast.success(`Playing ${artist.name} Radio (${response.tracks.length} tracks)`);
      } else {
        toast.error("Not enough similar music in your library for artist radio");
      }
    } catch (error) {
      console.error("Failed to start artist radio:", error);
      toast.error("Failed to start artist radio");
    }
  }

  // Loading state
  if (loading) {
    return <LoadingScreen message="Loading artist..." />;
  }

  // Error or not found state
  if (error || !artist) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="text-6xl text-white/20">♪</div>
          <h1 className="text-2xl font-semibold text-white">Artist Not Found</h1>
          <p className="text-neutral-400">
            This artist isn&apos;t in your library yet.
          </p>
          <button
            onClick={() => router.back()}
            className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-white transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <ArtistHero
        artist={artist}
        source={source}
        albums={albums}
        heroImage={heroImage}
        colors={colors}
        onReload={reloadArtist}
      >
        {/* Action bar inside hero for visual continuity */}
        <ArtistActionBar
          artist={artist}
          albums={albums}
          source={source}
          colors={colors}
          onPlayAll={() => playAll(artist, albums)}
          onShuffle={() => shufflePlay(artist, albums)}
          onDownloadAll={() => downloadArtist(artist)}
          onStartRadio={handleStartRadio}
          isPendingDownload={isPendingByMbid(artist.mbid || "")}
          isPlaying={isPlaying}
          isPlayingThisArtist={currentTrack?.artist?.id === artist.id || currentTrack?.artist?.name === artist.name}
          onPause={pause}
        />
      </ArtistHero>

      {/* Main Content - fills remaining viewport height */}
      <div className="relative min-h-[50vh] flex-1">
        {/* Dynamic color gradient background */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: colors
              ? `linear-gradient(to bottom, ${colors.vibrant}15 0%, ${colors.vibrant}08 15%, ${colors.darkVibrant}05 30%, transparent 50%)`
              : "transparent",
          }}
        />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,rgba(16,16,16,0.4)_100%)] pointer-events-none" />

        <div className="relative px-4 md:px-8 py-6 space-y-8">
          {/* Bio / About */}
          {(artist.bio || artist.summary) && <ArtistBio bio={artist.bio || artist.summary || ''} />}

          {/* Popular Tracks */}
          {artist.topTracks && artist.topTracks.length > 0 && (
            <PopularTracks
              tracks={artist.topTracks}
              artist={artist}
              currentTrackId={currentTrack?.id}
              colors={colors}
              onPlayTrack={handlePlayTrack}
              previewTrack={previewTrack}
              previewPlaying={previewPlaying}
              onPreview={(track: any, e: React.MouseEvent) =>
                handlePreview(track, artist.name, e)
              }
            />
          )}

          {/* Discography (Owned Albums) */}
          <Discography
            albums={ownedAlbums}
            colors={colors}
            onPlayAlbum={handlePlayAlbum}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />

          {/* Available Albums to Download */}
          <AvailableAlbums
            albums={availableAlbums}
            artistName={artist.name}
            source={source}
            colors={colors}
            onDownloadAlbum={handleDownloadAlbum}
            isPendingDownload={isPendingByMbid}
          />

          {/* Similar Artists */}
          {artist.similarArtists && artist.similarArtists.length > 0 && (
            <SimilarArtists
              similarArtists={artist.similarArtists}
              onNavigate={(id) => router.push(`/artist/${id}`)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
