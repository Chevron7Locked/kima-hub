"use client";

import { use, useMemo, useState } from "react";
import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { api } from "@/lib/api";
import { useAddToPlaylistMutation, usePublicConfig } from "@/hooks/useQueries";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { useDownloadContext } from "@/lib/download-context";

import { useAlbumData } from "@/features/album/hooks/useAlbumData";
import { useAlbumActions } from "@/features/album/hooks/useAlbumActions";
import { usePreview } from "@/hooks/usePreview";
import type { MissingTrack, Track as AlbumTrack } from "@/features/album/types";

import { AlbumHero } from "@/features/album/components/AlbumHero";
import { AlbumActionBar } from "@/features/album/components/AlbumActionBar";
import { TrackList } from "@/features/album/components/TrackList";
import { SimilarAlbums } from "@/features/album/components/SimilarAlbums";
import { PageMessage } from "@/components/ui/PageMessage";

interface AlbumPageProps {
    params: Promise<{
        id: string;
    }>;
}

export default function AlbumPage({ params }: AlbumPageProps) {
    const { id } = use(params);
    const addToPlaylist = useAddToPlaylistMutation();
    const { canAcquire } = usePublicConfig();
    // Split hooks avoid re-renders from currentTime updates.
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { pause } = useAudioControls();

    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [pendingTrackIds, setPendingTrackIds] = useState<string[]>([]);

    const { album, source, loading, failed, notFound, reloadAlbum } = useAlbumData(id);
    const { playAlbum, shufflePlay, addToQueue, downloadAlbum } =
        useAlbumActions();
    const { isPendingByMbid } = useDownloadContext();
    const preview = usePreview();

    const combinedTracks = useMemo<AlbumTrack[]>(() => {
        const ownedTracks = (album?.tracks || []).map((track: AlbumTrack) => ({
            ...track,
            trackNumber: track.trackNumber ?? track.trackNo,
            discNumber: track.discNumber ?? null,
            discSubtitle: track.discSubtitle ?? null,
            isMissing: false,
            previewUrl: null,
        }));

        const missingTracks = (album?.missingTracks || []).map(
            (track: MissingTrack, index: number) => ({
                id: `missing-${track.trackNumber ?? "x"}-${index}-${track.title}`,
                title: track.title,
                duration: 0,
                trackNumber: track.trackNumber ?? undefined,
                discNumber: null,
                discSubtitle: null,
                isMissing: true,
                previewUrl: track.previewUrl,
            })
        );

        const compareTrackOrder = (a: AlbumTrack, b: AlbumTrack) => {
            const aDisc = typeof a.discNumber === "number" ? a.discNumber : 1;
            const bDisc = typeof b.discNumber === "number" ? b.discNumber : 1;

            if (aDisc !== bDisc) {
                return aDisc - bDisc;
            }

            const aTrack = a.trackNumber ?? Number.MAX_SAFE_INTEGER;
            const bTrack = b.trackNumber ?? Number.MAX_SAFE_INTEGER;
            return aTrack - bTrack;
        };

        const orderedOwnedTracks = [...ownedTracks].sort(compareTrackOrder);

        const numberedMissing = missingTracks
            .filter((track: AlbumTrack) => typeof track.trackNumber === "number")
            .sort(compareTrackOrder);

        const unnumberedMissing = missingTracks.filter(
            (track: AlbumTrack) => typeof track.trackNumber !== "number"
        );

        const merged: AlbumTrack[] = [];
        let missingIndex = 0;

        for (const ownedTrack of orderedOwnedTracks) {
            while (missingIndex < numberedMissing.length) {
                const missingTrack = numberedMissing[missingIndex];

                if (compareTrackOrder(missingTrack, ownedTrack) > 0) break;

                merged.push(missingTrack);
                missingIndex += 1;
            }

            merged.push(ownedTrack);
        }

        while (missingIndex < numberedMissing.length) {
            merged.push(numberedMissing[missingIndex]);
            missingIndex += 1;
        }

        return [...merged, ...unnumberedMissing];
    }, [album?.tracks, album?.missingTracks]);

    const rawCoverUrl = album?.coverUrl || album?.coverArt || null;
    const coverUrl = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 1200) : null;
    const colorExtractionUrl = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 300, true) : null;

    const { colors } = useImageColor(colorExtractionUrl);

    if (loading) {
        return <LoadingScreen />;
    }

    if (failed && !notFound) {
        return (
            <PageMessage
                title="Couldn't load this album"
                action={{ label: "Try again", onClick: () => reloadAlbum() }}
            />
        );
    }

    if (!album) {
        return (
            <PageMessage
                title="Album not found"
                action={{ label: "Albums", href: "/collection?tab=albums" }}
            />
        );
    }

    const handlePlayTrack = (track: AlbumTrack, index: number) => {
        const ownedTrackIndex = (album.tracks || []).findIndex(
            (ownedTrack: AlbumTrack) => ownedTrack.id === track.id
        );
        playAlbum(album, ownedTrackIndex >= 0 ? ownedTrackIndex : index);
    };

    const openPlaylistSelector = (trackIds: string[]) => {
        if (!trackIds.length) return;
        setPendingTrackIds(trackIds);
        setShowPlaylistSelector(true);
    };

    const handleAddAlbumToPlaylist = () => {
        if (!album?.tracks?.length) return;
        const trackIds = album.tracks
            .map((track: AlbumTrack) => track.id)
            .filter(Boolean);
        openPlaylistSelector(trackIds);
    };

    const handleAddToPlaylist = (trackId: string) => {
        openPlaylistSelector([trackId]);
    };

    const handlePlaylistSelected = async (playlistId: string) => {
        if (!pendingTrackIds.length) return;

        // Errors propagate to the selector, which reports them and stays
        // open. Swallowing here closed the dialog and made a rejected add
        // look like success.
        await addToPlaylist.mutateAsync({ playlistId, trackIds: pendingTrackIds });
        setPendingTrackIds([]);
        setShowPlaylistSelector(false);
    };

    return (
        <div className="min-h-screen flex flex-col">
            <AlbumHero
                album={album}
                source={source || "discovery"}
                coverUrl={coverUrl}
                colors={colors}
                onReload={reloadAlbum}
            >
                <AlbumActionBar
                    album={album}
                    source={source || "discovery"}
                    onPlayAll={() => playAlbum(album, 0)}
                    onShuffle={() => shufflePlay(album)}
                    onDownloadAlbum={canAcquire ? () => downloadAlbum(album) : undefined}
                    onAddToPlaylist={handleAddAlbumToPlaylist}
                    isPendingDownload={isPendingByMbid(
                        album?.mbid || album?.rgMbid || ""
                    )}
                    isPlaying={isPlaying}
                    isPlayingThisAlbum={currentTrack?.album?.id === album.id}
                    onPause={pause}
                />
            </AlbumHero>

            <div className="relative min-h-[50vh] flex-1 animate-rise">
                {colors && (
                    <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                            background: `linear-gradient(180deg, ${colors.vibrant}15 0%, ${colors.darkVibrant}08 50%, transparent 100%)`,
                        }}
                    />
                )}

                <div className="relative page-shell py-6 space-y-8">
                    {combinedTracks.length > 0 && (
                        <TrackList
                            tracks={combinedTracks}
                            album={album}
                            source={source || "discovery"}
                            currentTrackId={currentTrack?.id}
                            colors={colors}
                            onPlayTrack={handlePlayTrack}
                            onAddToQueue={(track: AlbumTrack) =>
                                addToQueue(track, album)
                            }
                            onAddToPlaylist={handleAddToPlaylist}
                            previewTrack={preview.previewId}
                            previewPlaying={preview.playing}
                            onPreview={(track: AlbumTrack) =>
                                preview.toggle(track.id, api.getTrackPreviewStreamUrl(album.artist?.name || "", track.title))
                            }
                        />
                    )}

                    {album.similarAlbums && album.similarAlbums.length > 0 && (
                        <SimilarAlbums
                            similarAlbums={album.similarAlbums}
                        />
                    )}
                </div>
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => {
                    setShowPlaylistSelector(false);
                    setPendingTrackIds([]);
                }}
                onSelectPlaylist={handlePlaylistSelected}
            />
        </div>
    );
}
