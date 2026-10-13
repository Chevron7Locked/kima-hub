/**
 * The one track shape the player accepts. Every surface that starts a queue maps
 * through here, so a field the player reads — loudness for normalization above all —
 * cannot be dropped by a hand-written per-page whitelist again.
 */

import type { Track } from "./audio-context";

/** A name or an {id, name} pair — routes hand back either. */
type NamedRef = { id?: string | null; name?: string | null } | string | null | undefined;

/** Anything a route hands back for one row of a playable list. */
export interface PlayableRow {
    id: string;
    title?: string | null;
    displayTitle?: string | null;
    duration?: number | null;
    loudness?: number | null;
    artist?: NamedRef;
    album?:
        | { id?: string | null; title?: string | null; coverArt?: string | null; coverUrl?: string | null; artist?: NamedRef }
        | string
        | null;
    albumId?: string | null;
    albumTitle?: string | null;
    albumCoverUrl?: string | null;
    artistName?: string | null;
    artistId?: string | null;
    coverUrl?: string | null;
}

const refId = (ref: NamedRef): string | undefined =>
    typeof ref === "object" && ref !== null ? ref.id ?? undefined : undefined;
const refName = (ref: NamedRef): string | null =>
    typeof ref === "string" ? ref : ref?.name ?? null;

/** Maps one row from any queue-feeder route into the player's Track. loudness is carried by structure, never by memory. */
export function toPlaybackTrack(row: PlayableRow): Track {
    const album = typeof row.album === "object" && row.album !== null ? row.album : null;
    const albumTitle = typeof row.album === "string" ? row.album : album?.title ?? null;
    const artist = row.artist ?? album?.artist ?? null;
    return {
        id: row.id,
        title: row.displayTitle || row.title || "",
        duration: row.duration ?? 0,
        loudness: row.loudness ?? null,
        artist: {
            id: refId(artist) ?? row.artistId ?? undefined,
            name: refName(artist) ?? row.artistName ?? "Unknown Artist",
        },
        album: {
            id: album?.id ?? row.albumId ?? "",
            title: albumTitle ?? row.albumTitle ?? "Unknown Album",
            coverArt: album?.coverArt ?? album?.coverUrl ?? row.coverUrl ?? row.albumCoverUrl ?? undefined,
        },
    };
}

export function toPlaybackTracks(rows: PlayableRow[]): Track[] {
    return rows.map(toPlaybackTrack);
}
