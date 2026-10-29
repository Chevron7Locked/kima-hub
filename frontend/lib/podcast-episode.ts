import type { Podcast } from "./audio-state-context";
import type { Episode } from "@/features/podcast/types";

/** A show as fetched, with its episodes: what the player's restores read. */
export type ShowWithEpisodes = { title: string; coverUrl: string | null; episodes?: Episode[] };

/**
 * An episode as the player holds it. Its id joins the show's and the episode's ("podcastId:episodeId"); the cover is
 * the show's unless the caller has the episode's own.
 */
export function episodeForPlayer(
    podcastId: string,
    show: { title: string; coverUrl: string | null },
    episode: Pick<Episode, "id" | "title" | "duration" | "progress">,
    coverUrl: string | null = show.coverUrl,
): Podcast {
    return {
        id: `${podcastId}:${episode.id}`,
        title: episode.title,
        podcastTitle: show.title,
        coverUrl,
        duration: episode.duration,
        progress: episode.progress ?? null,
    };
}
