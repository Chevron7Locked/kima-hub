/** What the window is told about playlists, and what each signal carries. The playlists page refreshes on all three. */
interface PlaylistEvents {
    "playlist-created": { id: string } | undefined;
    "playlist-updated": { playlistId: string };
    "playlist-deleted": { playlistId: string };
}

export function announcePlaylistEvent<K extends keyof PlaylistEvents>(
    name: K,
    ...detail: undefined extends PlaylistEvents[K] ? [detail?: PlaylistEvents[K]] : [detail: PlaylistEvents[K]]
) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail[0] }));
}
