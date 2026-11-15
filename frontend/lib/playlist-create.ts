import { useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { newRequestKey } from "@/lib/request-key";

type Held = { key: string; name: string; isPublic: boolean };

/**
 * Making a playlist from a form, safe to retry. A create that failed (its answer may only have been lost) is retried
 * with the same key, so the server returns the playlist the first try made instead of a second one. The server refuses
 * a key that comes again with another name or visibility, so an edited form is a new create with a new key; so is the
 * next create once one went through. `forget` drops the key, for a form that starts afresh.
 */
export function usePlaylistCreate() {
    const held = useRef<Held | null>(null);

    const create = useCallback(async (name: string, isPublic = false) => {
        const last = held.current;
        const sending = last && last.name === name && last.isPublic === isPublic ? last : { key: newRequestKey(), name, isPublic };
        held.current = sending;
        const playlist = await api.createPlaylist(name, isPublic, sending.key);
        held.current = null;
        return playlist;
    }, []);

    const forget = useCallback(() => {
        held.current = null;
    }, []);

    return { create, forget };
}
