"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./useQueries";

/**
 * On a playlist's page: when that playlist is gone, move to the playlist list once, and drop the playlist from the
 * cache when the page closes (removed while the page reads it, it would be asked for again). Gone means deleted here
 * or on another device (the `playlist-deleted` signal), or the server answering "not found" for a playlist the page
 * has shown (`query` is the page's playlist query), as after a delete this device did not hear about. A link that
 * never loaded stays, so the page can say it was not found.
 */
export function useLeaveDeletedPlaylist(playlistId: string, query: { data: unknown; error: unknown }): void {
    const serverSaysGone = query.data != null && (query.error as { status?: number } | null)?.status === 404;
    const router = useRouter();
    const queryClient = useQueryClient();
    // Read through a ref: the cleanup below must run only when the page closes or shows another playlist, never
    // because the router object changed.
    const routerRef = useRef(router);
    useLayoutEffect(() => {
        routerRef.current = router;
    });
    // The playlist this page found gone, if any.
    const goneRef = useRef<string | null>(null);

    const leave = useCallback((id: string) => {
        if (goneRef.current === id) return;
        goneRef.current = id;
        routerRef.current.replace("/playlists");
    }, []);

    useEffect(() => {
        const onDeleted = (e: Event) => {
            if ((e as CustomEvent<{ playlistId?: string }>).detail?.playlistId === playlistId) leave(playlistId);
        };
        window.addEventListener("playlist-deleted", onDeleted);
        return () => {
            window.removeEventListener("playlist-deleted", onDeleted);
            if (goneRef.current === playlistId) queryClient.removeQueries({ queryKey: queryKeys.playlist(playlistId) });
        };
    }, [playlistId, queryClient, leave]);

    useEffect(() => {
        if (serverSaysGone) leave(playlistId);
    }, [serverSaysGone, playlistId, leave]);
}
