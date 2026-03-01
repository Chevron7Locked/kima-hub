"use client";

import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo } from "react";
import { PopularArtist } from "../types";

interface PopularArtistsGridProps {
    artists: PopularArtist[];
}

interface PopularArtistCardProps {
    artist: PopularArtist;
    index: number;
}

const PopularArtistCard = memo(function PopularArtistCard({
    artist,
    index,
}: PopularArtistCardProps) {
    const imageUrl = artist.image ? api.getCoverArtUrl(artist.image, 300) : null;

    return (
        <CarouselItem>
            <Link
                href={`/search?q=${encodeURIComponent(artist.name)}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="group block"
            >
                <div className="relative bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#ec4899]/40 transition-all duration-300 hover:shadow-lg hover:shadow-[#ec4899]/10 mx-1">
                    <div className="relative aspect-square">
                        <div className="w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden">
                            {imageUrl ? (
                                <Image
                                    src={imageUrl}
                                    alt={artist.name}
                                    fill
                                    sizes="180px"
                                    className="object-cover group-hover:scale-110 transition-transform duration-150"
                                    unoptimized
                                />
                            ) : (
                                <Music className="w-10 h-10 text-gray-700" />
                            )}
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#ec4899] to-[#db2777] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                    </div>
                    <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-black text-white truncate tracking-tight">
                            {artist.name}
                        </h3>
                        <p className="text-xs font-mono text-gray-500 uppercase tracking-wider mt-0.5">
                            {artist.listeners?.toLocaleString()} listeners
                        </p>
                    </div>
                </div>
            </Link>
        </CarouselItem>
    );
});

export const PopularArtistsGrid = memo(function PopularArtistsGrid({
    artists,
}: PopularArtistsGridProps) {
    return (
        <HorizontalCarousel>
            {artists.map((artist, index) => (
                <PopularArtistCard
                    key={artist.id || artist.name}
                    artist={artist}
                    index={index}
                />
            ))}
        </HorizontalCarousel>
    );
});
