"use client";

import { useMemo } from "react";
import { Download, CheckCircle, Music } from "lucide-react";
import { LibraryTracksList } from "./LibraryTracksList";
import { getQualityBadge, parseFilename } from "./soulseekHelpers";
import type { LibraryTrack, SoulseekResult } from "../types";

interface UnifiedSongsListProps {
    tracks: LibraryTrack[];
    soulseekResults: SoulseekResult[];
    downloadingFiles: Set<string>;
    onDownload: (result: SoulseekResult) => void;
    canAcquire: boolean;
    maxTotal?: number;
    maxLibrary?: number;
}

function sortByQuality(a: SoulseekResult, b: SoulseekResult): number {
    const scoreA = a.format === "flac" ? 10000 : a.bitrate;
    const scoreB = b.format === "flac" ? 10000 : b.bitrate;
    return scoreB - scoreA;
}

export function UnifiedSongsList({
    tracks,
    soulseekResults,
    downloadingFiles,
    onDownload,
    canAcquire,
    maxTotal = 6,
    maxLibrary = 4,
}: UnifiedSongsListProps) {
    const librarySlice = tracks.slice(0, maxLibrary);
    const soulseekSlots = maxTotal - librarySlice.length;
    const soulseekSlice = useMemo(
        () => [...soulseekResults].sort(sortByQuality).slice(0, Math.max(0, soulseekSlots)),
        [soulseekResults, soulseekSlots],
    );

    if (librarySlice.length === 0 && soulseekSlice.length === 0) {
        return null;
    }

    return (
        <div className="space-y-1">
            <LibraryTracksList tracks={tracks} limit={maxLibrary} />

            {soulseekSlice.map((result, index) => {
                const parsed = result.parsedArtist
                    ? {
                          artist: result.parsedArtist,
                          title:
                              result.filename
                                  .split("\\")
                                  .pop()
                                  ?.split(" - ")
                                  .slice(1)
                                  .join(" - ") || result.filename,
                      }
                    : parseFilename(result.filename);
                const downloadKey = `${result.username}:${result.path}`;
                const isDownloading = downloadingFiles.has(downloadKey);

                return (
                    <div
                        key={`slsk-${result.username}-${result.filename}-${index}`}
                        className="flex items-center gap-3 p-2 rounded-md hover:bg-white/5 transition-colors"
                    >
                        <button
                            onClick={() => canAcquire && !isDownloading && onDownload(result)}
                            disabled={!canAcquire || isDownloading}
                            title={canAcquire ? "download" : "downloads are operator-only — an admin can allow members in settings"}
                            aria-label={canAcquire ? "download from soulseek" : "downloads are operator-only"}
                            className="w-10 h-10 flex items-center justify-center flex-shrink-0 disabled:opacity-40"
                        >
                            {isDownloading ? (
                                <CheckCircle className="w-4 h-4 text-success" />
                            ) : (
                                <Download className="w-4 h-4 text-brand" />
                            )}
                        </button>

                        <div className="w-10 h-10 bg-[#181818] rounded flex items-center justify-center flex-shrink-0">
                            <Music className="w-5 h-5 text-[var(--text-secondary)]" />
                        </div>

                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white truncate">
                                {parsed.title}
                            </p>
                            <p className="text-xs text-[var(--text-secondary)] truncate">
                                {parsed.artist}
                            </p>
                        </div>

                        <div className="flex-shrink-0">
                            {getQualityBadge(result)}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
