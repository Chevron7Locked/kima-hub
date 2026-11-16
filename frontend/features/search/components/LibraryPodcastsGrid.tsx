import { pathFor } from "@/lib/paths";
import { Mic2 } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { cascadeStyle } from "@/lib/motion";
import { Podcast } from "../types";
import { api } from "@/lib/api";

interface LibraryPodcastsGridProps {
    podcasts: Podcast[];
}

export function LibraryPodcastsGrid({ podcasts }: LibraryPodcastsGridProps) {
    return (
        <div className="grid-media" data-tv-section="search-results-podcasts" style={cascadeStyle(Math.min(podcasts.length, 6))}>
            {podcasts.slice(0, 6).map((podcast, index) => {
                const subtitle =
                    podcast.episodeCount && podcast.episodeCount > 0
                        ? `${podcast.author || "Podcast"} • ${podcast.episodeCount} ${podcast.episodeCount === 1 ? "episode" : "episodes"}`
                        : podcast.author || "Podcast";

                return (
                    <MediaCard
                        key={podcast.id}
                        href={pathFor("/podcasts", podcast.id)}
                        title={podcast.title}
                        subtitle={subtitle}
                        imageUrl={
                            podcast.imageUrl
                                ? api.getCoverArtUrl(podcast.imageUrl, 200)
                                : null
                        }
                        fallbackIcon={Mic2}
                        type="podcast"
                        index={index}
                    />
                );
            })}
        </div>
    );
}
