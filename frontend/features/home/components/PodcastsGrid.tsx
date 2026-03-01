"use client";

import Link from "next/link";
import Image from "next/image";
import { Disc } from "lucide-react";
import { Podcast } from "../types";
import { memo } from "react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";

interface PodcastsGridProps {
    podcasts: Podcast[];
}

interface PodcastCardProps {
    podcast: Podcast;
    index: number;
}

const getProxiedImageUrl = (podcast: Podcast): string | null => {
    const imageUrl = podcast.coverUrl || podcast.coverArt || podcast.imageUrl;
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

const PodcastCard = memo(
    function PodcastCard({ podcast, index }: PodcastCardProps) {
        const imageUrl = getProxiedImageUrl(podcast);

        return (
            <CarouselItem>
                <Link
                    href={`/podcasts/${podcast.id}`}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                    className="group block"
                >
                    <div className="relative bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#3b82f6]/40 transition-all duration-300 hover:shadow-lg hover:shadow-[#3b82f6]/10 mx-1">
                        <div className="relative aspect-square">
                            <div className="w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden">
                                {imageUrl ? (
                                    <Image
                                        src={imageUrl}
                                        alt={podcast.title}
                                        fill
                                        sizes="180px"
                                        className="object-cover group-hover:scale-110 transition-transform duration-150"
                                        unoptimized
                                    />
                                ) : (
                                    <Disc className="w-10 h-10 text-gray-700" />
                                )}
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#3b82f6] to-[#2563eb] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                        </div>
                        <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                            <h3 className="text-sm font-black text-white truncate tracking-tight">
                                {podcast.title}
                            </h3>
                            <p className="text-xs font-mono text-gray-500 uppercase tracking-wider truncate mt-0.5">
                                {podcast.author || "Podcast"}
                            </p>
                        </div>
                    </div>
                </Link>
            </CarouselItem>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.podcast.id === nextProps.podcast.id && prevProps.index === nextProps.index;
    }
);

const PodcastsGrid = memo(function PodcastsGrid({
    podcasts,
}: PodcastsGridProps) {
    return (
        <HorizontalCarousel>
            {podcasts.map((podcast, index) => (
                <PodcastCard key={podcast.id} podcast={podcast} index={index} />
            ))}
        </HorizontalCarousel>
    );
});

export { PodcastsGrid };
