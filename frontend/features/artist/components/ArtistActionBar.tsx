import { Download, Radio, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { MediaActionBar, MediaActionButton } from "@/components/ui/MediaActionBar";
import type { Album, ArtistSource } from "../types";

interface ArtistActionBarProps {
    albums: Album[];
    source: ArtistSource | null;
    onPlayAll: () => void;
    onShuffle: () => void;
    /** Absent for someone who may not start downloads: no download button then. */
    onDownloadAll?: () => void;
    onStartRadio: () => void;
    /** Absent unless the viewer may delete this library artist: no delete button then. */
    onDelete?: () => void;
    isPendingDownload: boolean;
    isPlaying: boolean;
    isPlayingThisArtist: boolean;
    onPause: () => void;
}

export function ArtistActionBar({
    albums,
    source,
    onPlayAll,
    onShuffle,
    onDownloadAll,
    onStartRadio,
    onDelete,
    isPendingDownload,
    isPlaying,
    isPlayingThisArtist,
    onPause,
}: ArtistActionBarProps) {
    const availableAlbums = albums.filter(
        (album) => album.availability !== "unavailable"
    );
    const showDownloadAll = Boolean(onDownloadAll) && (source === "discovery" || availableAlbums.length > 0);
    const showPause = isPlaying && isPlayingThisArtist;
    const showRadio = source === "library";

    return (
        <MediaActionBar
            showPause={showPause}
            onPlayPause={showPause ? onPause : onPlayAll}
            onShuffle={onShuffle}
            secondaryShape="square"
        >
            {showRadio && (
                <MediaActionButton
                    shape="square"
                    icon={<Radio className="w-5 h-5" />}
                    label="start artist radio"
                    onClick={onStartRadio}
                />
            )}

            {onDelete && (
                <MediaActionButton
                    shape="square"
                    icon={<Trash2 className="w-5 h-5" />}
                    label="delete artist"
                    onClick={onDelete}
                />
            )}

            {showDownloadAll && (
                <button
                    onClick={onDownloadAll}
                    disabled={isPendingDownload}
                    className={cn(
                        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                        isPendingDownload
                            ? "bg-white/5 text-[var(--text-secondary)] cursor-not-allowed"
                            : "bg-white/5 hover:bg-white/10 text-[var(--text-primary)] hover:text-white"
                    )}
                >
                    <Download className="w-4 h-4" />
                    <span className="hidden sm:inline">
                        {isPendingDownload ? "Downloading..." : "Download All"}
                    </span>
                </button>
            )}
        </MediaActionBar>
    );
}
