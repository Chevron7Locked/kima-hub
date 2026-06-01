import { Play, Pause, Shuffle, Download, Radio } from "lucide-react";
import { cn } from "@/utils/cn";
import type { Artist } from "../types";
import type { Album } from "../types";
import type { ArtistSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";

interface ArtistActionBarProps {
    artist: Artist;
    albums: Album[];
    source: ArtistSource | null;
    colors: ColorPalette | null;
    onPlayAll: () => void;
    onShuffle: () => void;
    onDownloadAll: () => void;
    onStartRadio?: () => void;
    isPendingDownload: boolean;
    isPlaying?: boolean;
    isPlayingThisArtist?: boolean;
    onPause?: () => void;
}

export function ArtistActionBar({
    artist: _artist,
    albums,
    source,
    colors: _colors,
    onPlayAll,
    onShuffle,
    onDownloadAll,
    onStartRadio,
    isPendingDownload,
    isPlaying = false,
    isPlayingThisArtist = false,
    onPause,
}: ArtistActionBarProps) {
    const availableAlbums = albums.filter(
        (album) => album.availability !== "unavailable"
    );
    const showDownloadAll = source === "discovery" || availableAlbums.length > 0;
    const showPause = isPlaying && isPlayingThisArtist;
    const showRadio = source === "library" && onStartRadio;

    const handlePlayPauseClick = () => {
        if (showPause && onPause) {
            onPause();
        } else {
            onPlayAll();
        }
    };

    return (
        <div className="flex items-center gap-4">
            {/* Play Button */}
            <button
                onClick={handlePlayPauseClick}
                className="h-12 w-12 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105 bg-brand"
            >
                {showPause ? (
                    <Pause className="w-5 h-5 fill-current text-black" />
                ) : (
                    <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                )}
            </button>

            {/* Shuffle Button */}
            <button
                onClick={onShuffle}
                className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                title="Shuffle play"
            >
                <Shuffle className="w-5 h-5" />
            </button>

            {/* Radio Button - Only for library artists */}
            {showRadio && (
                <button
                    onClick={onStartRadio}
                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title="Start artist radio"
                >
                    <Radio className="w-5 h-5" />
                </button>
            )}

            {/* Download All Button */}
            {showDownloadAll && (
                <button
                    onClick={onDownloadAll}
                    disabled={isPendingDownload}
                    className={cn(
                        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                        isPendingDownload
                            ? "bg-white/5 text-white/50 cursor-not-allowed"
                            : "bg-white/5 hover:bg-white/10 text-white/80 hover:text-white"
                    )}
                >
                    <Download className="w-4 h-4" />
                    <span className="hidden sm:inline">
                        {isPendingDownload ? "Downloading..." : "Download All"}
                    </span>
                </button>
            )}
        </div>
    );
}
