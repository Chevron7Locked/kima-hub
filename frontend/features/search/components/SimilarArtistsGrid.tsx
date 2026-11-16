import { pathFor } from "@/lib/paths";
import { Music } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { cascadeStyle } from "@/lib/motion";
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
        <div
            className="grid-media"
            data-tv-section="search-results-artists"
            style={cascadeStyle(Math.min(similarArtists.length, 6))}
        >
            {similarArtists.map((result, index) => {
                const artistId = result.mbid || result.name;
                const imageUrl = result.image
                    ? api.getCoverArtUrl(result.image, 200)
                    : null;

                return (
                    <MediaCard
                        key={`artist-${artistId}-${index}`}
                        href={pathFor("/artist", artistId)}
                        title={result.name}
                        subtitle={formatListeners(result.listeners)}
                        imageUrl={imageUrl}
                        fallbackIcon={Music}
                        type="artist"
                        index={index}
                    />
                );
            })}
        </div>
    );
}
