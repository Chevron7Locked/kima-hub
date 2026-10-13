"use client";

import {
    useAudioState,
    useAudioPlayback,
    useAudioControls,
} from "@/lib/audio-context";
import { useDownloadContext } from "@/lib/download-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";

import { useArtistData } from "@/features/artist/hooks/useArtistData";
import { useArtistActions } from "@/features/artist/hooks/useArtistActions";
import { useDownloadActions } from "@/features/artist/hooks/useDownloadActions";
import type { Track, Album } from "@/features/artist/types";
import { usePreview } from "@/hooks/usePreview";

import { ArtistHero } from "@/features/artist/components/ArtistHero";
import { ArtistActionBar } from "@/features/artist/components/ArtistActionBar";
import { ArtistBio } from "@/features/artist/components/ArtistBio";
import { PopularTracks } from "@/features/artist/components/PopularTracks";
import { Discography } from "@/features/artist/components/Discography";
import { AvailableAlbums } from "@/features/artist/components/AvailableAlbums";
import { SimilarArtists } from "@/features/artist/components/SimilarArtists";
import { PageMessage } from "@/components/ui/PageMessage";

export default function ArtistPage() {
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, pause } = useAudioControls();
    const { isPendingByMbid } = useDownloadContext();

    const {
        artist,
        albums,
        loading,
        error,
        source,
        sortBy,
        setSortBy,
        reloadArtist,
    } = useArtistData();

    const { playAll, shufflePlay } = useArtistActions();
    const { downloadArtist, downloadAlbum } = useDownloadActions();
    const preview = usePreview();

    const ownedAlbums = albums.filter((a) => a.owned);
    const availableAlbums = albums.filter((a) => !a.owned);

    // Get image URLs for display and color extraction
    const rawImageUrl =
        artist && source === "library" ?
            artist.coverArt
        :   artist?.image || null;

    // Use a high-res image for the hero section
    const heroImage =
        rawImageUrl ? api.getCoverArtUrl(rawImageUrl, 1200) : null;

    // Use a low-res image for color extraction and background blur to save CPU
    // Include token for CORS access needed by canvas color extraction
    const lowResImage =
        rawImageUrl ? api.getCoverArtUrl(rawImageUrl, 300, true) : null;

    const { colors } = useImageColor(lowResImage || rawImageUrl);

    async function handlePlayAlbum(albumId: string) {
        try {
            const albumData = await api.getAlbum(albumId);
            if (albumData.tracks && albumData.tracks.length > 0) {
                const tracksWithAlbum = albumData.tracks.map((track: Record<string, unknown>) => ({
                    ...track,
                    album: {
                        id: albumData.id,
                        title: albumData.title,
                        coverArt: albumData.coverArt,
                    },
                    artist: albumData.artist,
                }));
                playTracks(tracksWithAlbum, 0);
            }
        } catch {
            notify.error("Failed to play album");
        }
    }

    function handlePlayTrack(track: Track) {
        if (!artist?.topTracks) return;

        const playableTracks = artist.topTracks.filter((t: Track) => t.album?.id);
        const formattedTracks = playableTracks.map((t: Track) => ({
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

        const startIndex = formattedTracks.findIndex(
            (t: { id: string }) => t.id === track.id,
        );
        playTracks(formattedTracks, Math.max(0, startIndex));
    }

    function handleDownloadAlbum(album: Album) {
        downloadAlbum(album, artist?.name || "");
    }

    async function handleStartRadio() {
        if (!artist) return;

        try {
            const response = await api.getRadioTracks("artist", artist.id);

            if (response.tracks && response.tracks.length > 0) {
                // Backend already returns properly formatted tracks - just pass them through
                playTracks(response.tracks, 0);
            } else {
                notify.error(
                    "Not enough similar music in your library for artist radio",
                );
            }
        } catch {
            notify.error("Failed to start artist radio");
        }
    }

    if (loading) {
        return <LoadingScreen message="Loading artist..." />;
    }

    if (error) {
        return (
            <PageMessage
                title="Couldn't load this artist"
                action={{ label: "Try again", onClick: () => reloadArtist() }}
            />
        );
    }

    if (!artist) {
        return (
            <PageMessage
                title="Artist not found"
                description="This artist isn't in your library or on MusicBrainz."
                action={{ label: "Artists", href: "/collection?tab=artists" }}
            />
        );
    }

    return (
        <div className="min-h-screen flex flex-col">
            <ArtistHero
                artist={artist}
                source={source}
                albums={albums}
                heroImage={heroImage}
                backgroundImage={lowResImage}
                colors={colors}
                onReload={reloadArtist}
            >
                <ArtistActionBar
                    albums={albums}
                    source={source}
                    onPlayAll={() => playAll(artist, albums)}
                    onShuffle={() => shufflePlay(artist, albums)}
                    onDownloadAll={() => downloadArtist(artist)}
                    onStartRadio={handleStartRadio}
                    isPendingDownload={isPendingByMbid(artist.mbid || "")}
                    isPlaying={isPlaying}
                    isPlayingThisArtist={
                        currentTrack?.artist?.id === artist.id ||
                        currentTrack?.artist?.name === artist.name
                    }
                    onPause={pause}
                />
            </ArtistHero>

            <div className="relative min-h-[50vh] flex-1 animate-rise">
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background:
                            colors ?
                                `linear-gradient(to bottom, ${colors.vibrant}15 0%, ${colors.vibrant}08 15%, ${colors.darkVibrant}05 30%, transparent 50%)`
                            :   "transparent",
                    }}
                />
                <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,rgba(16,16,16,0.4)_100%)] pointer-events-none" />

                <div className="relative page-shell py-6 space-y-8">
                    {(artist.bio || artist.summary) && (
                        <ArtistBio bio={artist.bio || artist.summary || ""} />
                    )}

                    {artist.topTracks && artist.topTracks.length > 0 && (
                        <PopularTracks
                            tracks={artist.topTracks}
                            artist={artist}
                            currentTrackId={currentTrack?.id}
                            onPlayTrack={handlePlayTrack}
                            previewTrack={preview.previewId}
                            previewPlaying={preview.playing}
                            onPreview={(track: Track) =>
                                preview.toggle(track.id, api.getTrackPreviewStreamUrl(artist.name, track.title))
                            }
                        />
                    )}

                    <Discography
                        albums={ownedAlbums}
                        onPlayAlbum={handlePlayAlbum}
                        sortBy={sortBy}
                        onSortChange={setSortBy}
                    />

                    <AvailableAlbums
                        albums={availableAlbums}
                        source={source}
                        onDownloadAlbum={handleDownloadAlbum}
                        isPendingDownload={isPendingByMbid}
                    />

                    {artist.similarArtists &&
                        artist.similarArtists.length > 0 && (
                            <SimilarArtists
                                similarArtists={artist.similarArtists}
                            />
                        )}
                </div>
            </div>
        </div>
    );
}
