import { Music } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";
import { formatListeners } from "@/lib/format";

interface SimilarArtistsGridProps {
    similarArtists: DiscoverResult[];
}

export function SimilarArtistsGrid({
    similarArtists,
}: SimilarArtistsGridProps) {
    if (similarArtists.length === 0) {
        return null;
    }

    return (
        <div>
            <div
                className="grid-media"
                data-tv-section="search-results-artists"
            >
                {similarArtists.map((result, index) => {
                    const artistId = result.mbid || encodeURIComponent(result.name);
                    const imageUrl = result.image
                        ? api.getCoverArtUrl(result.image, 200)
                        : null;

                    return (
                        <MediaCard
                            key={`artist-${artistId}-${index}`}
                            href={`/artist/${artistId}`}
                            title={result.name}
                            subtitle={formatListeners(result.listeners)}
                            imageUrl={imageUrl}
                            fallbackIcon={Music}
                            accentColor={{
                                border: "hover:border-[#fca200]/50",
                                gradient: "bg-gradient-to-r from-[#fca200] to-[#d48c00]",
                                button: "bg-[#fca200] text-white",
                                shadow: "",
                            }}
                            index={index}
                        />
                    );
                })}
            </div>
        </div>
    );
}
