import { useQueueState } from "@/lib/audio-context";

/**
 * Where a queue came from: the album, artist, mix, playlist or Discover playlist whose play button started it. The
 * big play button of that page is current only while the loaded queue came from it, not whenever a song of it is
 * loaded; a paused song of this album that was started from a playlist leaves the album's button saying play.
 */
export const queueSource = {
    album: (id: string) => `album:${id}`,
    artist: (id: string) => `artist:${id}`,
    mix: (id: string) => `mix:${id}`,
    playlist: (id: string) => `playlist:${id}`,
    discover: "discover",
} as const;

/** Whether the loaded queue, with a song of it playing or paused, came from this source. */
export function useQueueFrom(source: string): boolean {
    return useQueueState().currentQueueSource === source;
}
