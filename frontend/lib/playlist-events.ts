/** What the window is told about playlists, and what each signal carries. The playlists page refreshes on both. */
interface PlaylistEvents {
    "playlist-created": { id: string } | undefined;
    "playlist-deleted": { playlistId: string };
}

export function announcePlaylistEvent<K extends keyof PlaylistEvents>(
    name: K,
    ...detail: undefined extends PlaylistEvents[K] ? [detail?: PlaylistEvents[K]] : [detail: PlaylistEvents[K]]
) {
    window.dispatchEvent(new CustomEvent(name, { detail: detail[0] }));
}

/** Listens for one playlist signal, its detail typed (null when it carried none); returns the function that stops listening. */
export function subscribePlaylistEvent<K extends keyof PlaylistEvents>(
    name: K,
    handler: (detail: PlaylistEvents[K] | null) => void
): () => void {
    const listener = (e: Event) => handler((e as CustomEvent<PlaylistEvents[K] | null>).detail);
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
}
