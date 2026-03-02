"use client";

import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useImageColor } from "@/hooks/useImageColor";
import { api } from "@/lib/api";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { useDownloadContext } from "@/lib/download-context";

// Custom hooks
import { useAlbumData } from "@/features/album/hooks/useAlbumData";
import { useAlbumActions } from "@/features/album/hooks/useAlbumActions";
import { useTrackPreview } from "@/hooks/useTrackPreview";
import type { MissingTrack, Track as AlbumTrack } from "@/features/album/types";

// Components
import { AlbumHero } from "@/features/album/components/AlbumHero";
import { AlbumActionBar } from "@/features/album/components/AlbumActionBar";
import { TrackList } from "@/features/album/components/TrackList";
import { SimilarAlbums } from "@/features/album/components/SimilarAlbums";

interface AlbumPageProps {
    params: Promise<{
        id: string;
    }>;
}

export default function AlbumPage({ params }: AlbumPageProps) {
    const { id } = use(params);
    const router = useRouter();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { pause } = useAudioControls();

    // State
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [pendingTrackIds, setPendingTrackIds] = useState<string[]>([]);
    const [, setIsBulkAdd] = useState(false);
    const [, setIsAddingToPlaylist] = useState(false);

    // Custom hooks
    const { album, source, loading, reloadAlbum } = useAlbumData(id);
    const { playAlbum, shufflePlay, addToQueue, downloadAlbum } =
        useAlbumActions();
    const { isPendingByMbid } = useDownloadContext();
    const { previewTrack, previewPlaying, handlePreview } = useTrackPreview();

    const combinedTracks = useMemo<AlbumTrack[]>(() => {
        const ownedTracks = (album?.tracks || []).map((track) => ({
            ...track,
            trackNumber: track.trackNumber ?? track.trackNo,
            isMissing: false,
            previewUrl: null,
        }));

        const missingTracks = (album?.missingTracks || []).map(
            (track: MissingTrack, index: number) => ({
                id: `missing-${track.trackNumber ?? "x"}-${index}-${track.title}`,
                title: track.title,
                duration: 0,
                trackNumber: track.trackNumber ?? undefined,
                isMissing: true,
                previewUrl: track.previewUrl,
            })
        );

        const orderedOwnedTracks = [...ownedTracks].sort((a, b) => {
            const aNum =
                typeof a.trackNumber === "number"
                    ? a.trackNumber
                    : Number.MAX_SAFE_INTEGER;
            const bNum =
                typeof b.trackNumber === "number"
                    ? b.trackNumber
                    : Number.MAX_SAFE_INTEGER;
            return aNum - bNum;
        });

        const numberedMissing = missingTracks
            .filter((track) => typeof track.trackNumber === "number")
            .sort(
                (a, b) =>
                    (a.trackNumber as number) - (b.trackNumber as number)
            );

        const unnumberedMissing = missingTracks.filter(
            (track) => typeof track.trackNumber !== "number"
        );

        const merged: AlbumTrack[] = [];
        let missingIndex = 0;

        for (const ownedTrack of orderedOwnedTracks) {
            const ownedTrackNumber =
                typeof ownedTrack.trackNumber === "number"
                    ? ownedTrack.trackNumber
                    : Number.MAX_SAFE_INTEGER;

            while (missingIndex < numberedMissing.length) {
                const missingTrack = numberedMissing[missingIndex];
                const missingTrackNumber = missingTrack.trackNumber as number;

                if (missingTrackNumber > ownedTrackNumber) break;

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

    // Get cover URL for display and color extraction
    // Proxy through API to handle native: URLs and CORS
    const rawCoverUrl =
        album?.coverUrl || album?.coverArt || "/placeholder-album.png";
    const coverUrl =
        rawCoverUrl === "/placeholder-album.png"
            ? rawCoverUrl
            : api.getCoverArtUrl(rawCoverUrl, 1200);
    // Separate URL with token for color extraction (CORS access for canvas)
    const colorExtractionUrl =
        rawCoverUrl === "/placeholder-album.png"
            ? rawCoverUrl
            : api.getCoverArtUrl(rawCoverUrl, 300, true);

    // Extract colors
    const { colors } = useImageColor(colorExtractionUrl);

    // Loading and error states
    if (loading) {
        return <LoadingScreen />;
    }

    if (!album) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <h1 className="text-2xl font-bold mb-4">
                        Error Loading Album
                    </h1>
                    <p className="text-gray-400 mb-4">Album not found</p>
                    <button
                        onClick={() => router.push("/albums")}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                    >
                        Back to Albums
                    </button>
                </div>
            </div>
        );
    }

    // Event handlers
    const handlePlayTrack = (track: AlbumTrack, index: number) => {
        const ownedTrackIndex = (album.tracks || []).findIndex(
            (ownedTrack: AlbumTrack) => ownedTrack.id === track.id
        );
        playAlbum(album, ownedTrackIndex >= 0 ? ownedTrackIndex : index);
    };

    const openPlaylistSelector = (trackIds: string[], bulk = false) => {
        if (!trackIds.length) return;
        setPendingTrackIds(trackIds);
        setIsBulkAdd(bulk);
        setShowPlaylistSelector(true);
    };

    const handleAddAlbumToPlaylist = () => {
        if (!album?.tracks?.length) return;
        const trackIds = album.tracks
            .map((track: AlbumTrack) => track.id)
            .filter(Boolean);
        openPlaylistSelector(trackIds, true);
    };

    const handleAddToPlaylist = (trackId: string) => {
        openPlaylistSelector([trackId]);
    };

    const handlePlaylistSelected = async (playlistId: string) => {
        if (!pendingTrackIds.length) return;

        try {
            setIsAddingToPlaylist(true);
            for (const trackId of pendingTrackIds) {
                await api.addTrackToPlaylist(playlistId, trackId);
            }
            setPendingTrackIds([]);
            setIsBulkAdd(false);
            setShowPlaylistSelector(false);
        } catch (error) {
            console.error("Failed to add track(s) to playlist:", error);
        } finally {
            setIsAddingToPlaylist(false);
        }
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
                    colors={colors}
                    onPlayAll={() => playAlbum(album, 0)}
                    onShuffle={() => shufflePlay(album)}
                    onDownloadAlbum={() => downloadAlbum(album)}
                    onAddToPlaylist={handleAddAlbumToPlaylist}
                    isPendingDownload={isPendingByMbid(
                        album?.mbid || album?.rgMbid || ""
                    )}
                    isPlaying={isPlaying}
                    isPlayingThisAlbum={currentTrack?.album?.id === album.id}
                    onPause={pause}
                />
            </AlbumHero>

            {/* Main Content - fills remaining viewport height */}
            <div className="relative min-h-[50vh] flex-1">
                {/* Dynamic color gradient */}
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background: `linear-gradient(180deg,
              ${(colors || {}).vibrant}15 0%,
              ${(colors || {}).darkVibrant}08 50%,
              transparent 100%)`,
                    }}
                />

                {/* Texture overlay */}
                <div
                    className="absolute inset-0 pointer-events-none opacity-[0.015]"
                    style={{
                        backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
                        backgroundSize: "30px 30px",
                    }}
                />

                <div className="relative px-4 md:px-8 py-6 space-y-8">
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
                            previewTrack={previewTrack}
                            previewPlaying={previewPlaying}
                            onPreview={(track: AlbumTrack, e: React.MouseEvent) =>
                                handlePreview(
                                    track,
                                    album.artist?.name || "",
                                    e
                                )
                            }
                        />
                    )}

                    {album.similarAlbums && album.similarAlbums.length > 0 && (
                        <SimilarAlbums
                            similarAlbums={album.similarAlbums}
                            colors={colors}
                            onNavigate={(id) => router.push(`/album/${id}`)}
                        />
                    )}
                </div>
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => {
                    setShowPlaylistSelector(false);
                    setPendingTrackIds([]);
                    setIsBulkAdd(false);
                }}
                onSelectPlaylist={handlePlaylistSelected}
            />
        </div>
    );
}
