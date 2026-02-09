import type { SoulseekResult } from "../types";

export const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const getQualityBadge = (result: SoulseekResult) => {
    if (result.format === "flac") {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-purple-600/20 text-purple-400 rounded">
                FLAC
            </span>
        );
    }
    if (result.bitrate >= 320) {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-green-600/20 text-green-400 rounded">
                320 kbps
            </span>
        );
    }
    if (result.bitrate >= 256) {
        return (
            <span className="px-2 py-1 text-xs font-semibold bg-blue-600/20 text-blue-400 rounded">
                256 kbps
            </span>
        );
    }
    return (
        <span className="px-2 py-1 text-xs font-semibold bg-gray-600/20 text-gray-400 rounded">
            {result.bitrate} kbps
        </span>
    );
};

export const parseFilename = (
    filename: string,
): { artist: string; title: string } => {
    const match = filename.match(/([^/\\]+)\.(?:mp3|flac|m4a|wav)$/i);
    if (match) {
        const nameWithoutExt = match[1];
        const parts = nameWithoutExt.split(" - ");
        if (parts.length >= 2) {
            return {
                artist: parts[0].trim(),
                title: parts.slice(1).join(" - ").trim(),
            };
        }
        return { artist: "Unknown", title: nameWithoutExt };
    }
    return { artist: "Unknown", title: filename };
};
