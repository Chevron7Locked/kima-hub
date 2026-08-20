import { Music } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { Podcast } from "../types";
import { api } from "@/lib/api";

interface LibraryPodcastsGridProps {
    podcasts: Podcast[];
}

export function LibraryPodcastsGrid({ podcasts }: LibraryPodcastsGridProps) {
    return (
        <div className="grid-media" data-tv-section="search-results-podcasts">
            {podcasts.slice(0, 6).map((podcast, index) => {
                const subtitle =
                    podcast.episodeCount && podcast.episodeCount > 0
                        ? `${podcast.author || "Podcast"} • ${podcast.episodeCount} ${podcast.episodeCount === 1 ? "episode" : "episodes"}`
                        : podcast.author || "Podcast";

                return (
                    <MediaCard
                        key={podcast.id}
                        href={`/podcasts/${podcast.id}`}
                        title={podcast.title}
                        subtitle={subtitle}
                        imageUrl={
                            podcast.imageUrl
                                ? api.getCoverArtUrl(podcast.imageUrl, 200)
                                : null
                        }
                        fallbackIcon={Music}
                        accentColor={{
                            border: "hover:border-[#3b82f6]/50",
                            button: "bg-[#3b82f6] text-white",
                            shadow: "hover:shadow-[#3b82f6]/10",
                        }}
                        index={index}
                    />
                );
            })}
        </div>
    );
}
