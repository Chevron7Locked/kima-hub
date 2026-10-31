"use client";

import { Music } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";
import { Mix } from "../types";
import { memo } from "react";
import { cascadeStyle } from "@/lib/motion";

interface MixesGridProps {
    mixes: Mix[];
}

const MixesGrid = memo(function MixesGrid({ mixes }: MixesGridProps) {
    return (
        <HorizontalCarousel style={cascadeStyle(mixes.length)}>
            {mixes.map((mix, index) => (
                <CarouselItem key={mix.id}>
                    <MediaCard
                        href={`/mix/${mix.id}`}
                        title={mix.name}
                        subtitle={plural(mix.trackCount, "track")}
                        imageUrl={mix.coverUrls.slice(0, 4).map((url) => api.getCoverArtUrl(url, 300))}
                        fallbackIcon={Music}
                        type="track"
                        index={index}
                    />
                </CarouselItem>
            ))}
        </HorizontalCarousel>
    );
});

export { MixesGrid };
