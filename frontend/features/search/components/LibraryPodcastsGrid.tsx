import { Music } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { Podcast } from "../types";
import { api } from "@/lib/api";

interface LibraryPodcastsGridProps {
    podcasts: Podcast[];
}

export function LibraryPodcastsGrid({ podcasts }: LibraryPodcastsGridProps) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4" data-tv-section="search-results-podcasts">
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
                            gradient: "bg-gradient-to-r from-[#3b82f6] to-[#2563eb]",
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
