"use client";

import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { memo } from "react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { cascadeStyle } from "@/lib/motion";
import { MediaCard } from "@/components/cards/MediaCard";
import type { Artist, PopularArtist } from "../types";

interface ArtistTile {
    key: string;
    name: string;
    href: string;
    coverArt?: string;
    subtitle: string;
}

function ArtistTileGrid({ tiles }: { tiles: ArtistTile[] }) {
    return (
        <HorizontalCarousel style={cascadeStyle(tiles.length)}>
            {tiles.map((tile, index) => (
                <CarouselItem key={tile.key}>
                    <MediaCard
                        href={tile.href}
                        title={tile.name}
                        subtitle={tile.subtitle}
                        imageUrl={tile.coverArt ? api.getCoverArtUrl(tile.coverArt, 300) : null}
                        fallbackIcon={Music}
                        type="artist"
                        index={index}
                        sizes="180px"
                    />
                </CarouselItem>
            ))}
        </HorizontalCarousel>
    );
}

export const ArtistsGrid = memo(function ArtistsGrid({ artists }: { artists: Artist[] }) {
    return (
        <ArtistTileGrid
            tiles={artists.map((a) => ({
                key: a.id,
                name: a.name,
                href: `/artist/${a.id}`,
                coverArt: a.coverArt,
                subtitle: "Artist",
            }))}
        />
    );
});

// Popular artists come from outside the library, so they open a search rather than an artist page.
export const PopularArtistsGrid = memo(function PopularArtistsGrid({
    artists,
}: {
    artists: PopularArtist[];
}) {
    return (
        <ArtistTileGrid
            tiles={artists.map((a) => ({
                key: a.id || a.name,
                name: a.name,
                href: `/search?q=${encodeURIComponent(a.name)}`,
                coverArt: a.image,
                subtitle: `${a.listeners?.toLocaleString()} listeners`,
            }))}
        />
    );
});
