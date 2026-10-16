import type { Prisma } from "@prisma/client";
import { eventBus } from "./eventBus";

/**
 * Tells a playlist owner's open devices that one of their playlists changed, so their playlist list and that
 * playlist refetch; a deleted one is marked so no device asks for it again. Every writer of playlists calls this;
 * a song deleted from the library reaches it through `playlistsHoldingTracks`.
 */
export function announcePlaylistChange(userId: string, playlistId: string, deleted = false): void {
    eventBus.emit({ type: "playlist:updated", userId, payload: { playlistId, deleted } });
}

/** A playlist and its owner, to be told it changed. */
export interface HeldPlaylist {
    userId: string;
    playlistId: string;
}

/**
 * Before songs are deleted: their playlist entries go with them (the database removes those), so read which playlists
 * hold them and who owns each. Hand the answer to `announcePlaylistsChanged` once the delete is done (after the
 * transaction, when there is one).
 */
export async function playlistsHoldingTracks(
    client: Pick<Prisma.TransactionClient, "playlistItem">,
    tracks: Prisma.TrackWhereInput,
): Promise<HeldPlaylist[]> {
    const held = await client.playlistItem.findMany({
        where: { track: tracks },
        distinct: ["playlistId"],
        select: { playlistId: true, playlist: { select: { userId: true } } },
    });
    return held.map(({ playlistId, playlist }) => ({ userId: playlist.userId, playlistId }));
}

export function announcePlaylistsChanged(playlists: HeldPlaylist[]): void {
    for (const { userId, playlistId } of playlists) announcePlaylistChange(userId, playlistId);
}
