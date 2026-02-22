"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { X, Plus, Music2 } from "lucide-react";
import { GradientSpinner } from "./GradientSpinner";

interface PlaylistSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectPlaylist: (playlistId: string) => Promise<void>;
    isLoading?: boolean;
    loadingMessage?: string;
}

export function PlaylistSelector({
    isOpen,
    onClose,
    onSelectPlaylist,
    isLoading: isSaving,
    loadingMessage,
}: PlaylistSelectorProps) {
    const [playlists, setPlaylists] = useState<Array<{ id: string; name: string; trackCount?: number }>>([]);
    const [newPlaylistName, setNewPlaylistName] = useState("");
    const [isPublic, setIsPublic] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            loadPlaylists();
        }
    }, [isOpen]);

    const loadPlaylists = async () => {
        try {
            setIsLoading(true);
            const data = await api.getPlaylists();
            setPlaylists(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error("Failed to load playlists:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreatePlaylist = async () => {
        if (!newPlaylistName.trim()) return;

        try {
            setIsCreating(true);
            const playlist = await api.createPlaylist(
                newPlaylistName.trim(),
                isPublic
            );
            await onSelectPlaylist(playlist.id);
            setNewPlaylistName("");
            setIsPublic(false);

            window.dispatchEvent(
                new CustomEvent("playlist-created", { detail: playlist })
            );

            onClose();
        } catch (error) {
            console.error("Failed to create playlist:", error);
        } finally {
            setIsCreating(false);
        }
    };

    const handleSelectPlaylist = async (playlistId: string) => {
        try {
            await onSelectPlaylist(playlistId);
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );
            await loadPlaylists();
            onClose();
        } catch (error) {
            console.error("Failed to add to playlist:", error);
        }
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/80 flex items-center justify-center z-[80] p-4"
            onClick={onClose}
        >
            <div
                className="bg-linear-to-b from-[#121212] to-[#121212] rounded-xl max-w-md w-full max-h-[80vh] overflow-hidden flex flex-col border border-white/10 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-6 border-b border-white/10">
                    <h2 className="text-2xl font-bold text-white">
                        Add to Playlist
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white/10 rounded-full transition-colors"
                    >
                        <X className="w-5 h-5 text-gray-400" />
                    </button>
                </div>

                {isSaving && (
                    <div className="px-6 py-3 flex items-center gap-3 bg-black/30 border-b border-white/10 text-sm text-gray-300">
                        <GradientSpinner size="sm" />
                        <span>{loadingMessage || "Adding..."}</span>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <GradientSpinner size="md" />
                        </div>
                    ) : playlists.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <Music2 className="w-12 h-12 text-gray-600 mb-3" />
                            <p className="text-gray-400">No playlists yet</p>
                            <p className="text-gray-500 text-sm mt-1">
                                Create one below to get started
                            </p>
                        </div>
                    ) : (
                        playlists.map((playlist) => (
                            <button
                                key={playlist.id}
                                onClick={() =>
                                    handleSelectPlaylist(playlist.id)
                                }
                                className="w-full text-left px-4 py-4 rounded-lg bg-white/5 hover:bg-white/10 transition-all border border-white/5 hover:border-white/10 group"
                                disabled={isSaving}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-white font-semibold truncate group-hover:text-[#ecb200] transition-colors">
                                            {playlist.name}
                                        </p>
                                        <p className="text-xs text-gray-400 mt-1">
                                            {playlist.trackCount || 0}{" "}
                                            {playlist.trackCount === 1
                                                ? "track"
                                                : "tracks"}
                                        </p>
                                    </div>
                                    <Plus className="w-5 h-5 text-gray-400 group-hover:text-[#ecb200] transition-colors ml-2 shrink-0" />
                                </div>
                            </button>
                        ))
                    )}
                </div>

                <div className="p-6 border-t border-white/10 bg-[#0a0a0a]/50">
                    <p className="text-sm text-gray-400 mb-3 font-medium">
                        Create New Playlist
                    </p>
                    <div className="flex gap-2 mb-3">
                        <input
                            type="text"
                            placeholder="Enter playlist name..."
                            value={newPlaylistName}
                            onChange={(e) => setNewPlaylistName(e.target.value)}
                            onKeyDown={(e) =>
                                e.key === "Enter" && handleCreatePlaylist()
                            }
                            className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-[#ecb200] focus:bg-white/10 transition-all"
                        />
                        <button
                            onClick={handleCreatePlaylist}
                            disabled={
                                !newPlaylistName.trim() ||
                                isCreating ||
                                isSaving
                            }
                            className="px-5 py-3 bg-[#ecb200] hover:bg-[#d4a000] disabled:bg-gray-700 disabled:cursor-not-allowed text-black font-bold rounded-lg transition-all flex items-center gap-2 disabled:text-gray-500"
                        >
                            <Plus className="w-5 h-5" />
                            <span className="hidden sm:inline">Create</span>
                        </button>
                    </div>
                    <label className="flex items-center gap-3 cursor-pointer group">
                        <div className="relative">
                            <input
                                type="checkbox"
                                checked={isPublic}
                                onChange={(e) => setIsPublic(e.target.checked)}
                                className="sr-only peer"
                            />
                            <div className="w-10 h-5 bg-white/10 rounded-full peer-checked:bg-[#ecb200] transition-colors" />
                            <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
                        </div>
                        <span className="text-sm text-gray-400 group-hover:text-gray-300 transition-colors">
                            Share with other users
                        </span>
                    </label>
                </div>
            </div>
        </div>
    );
}
