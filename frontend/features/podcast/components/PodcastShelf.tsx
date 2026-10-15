"use client";

import { Mic2 } from "lucide-react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { MediaCard } from "@/components/cards/MediaCard";
import { cascadeStyle } from "@/lib/motion";
import { coverArtUrl } from "@/lib/cover-art";
import type { DiscoveryPodcast } from "../types";

/** A row of shows from the charts; `ranked` numbers them by chart position. */
export function PodcastShelf({ podcasts, ranked = false }: { podcasts: DiscoveryPodcast[]; ranked?: boolean }) {
    return (
        <HorizontalCarousel style={cascadeStyle(podcasts.length)}>
            {podcasts.map((p, index) => (
                <CarouselItem key={p.itunesId}>
                    <PodcastCard podcast={p} index={index} ranked={ranked} sizes="180px" className="mx-1" />
                </CarouselItem>
            ))}
        </HorizontalCarousel>
    );
}

/** One show from Apple's catalog, opening its page; `ranked` shows its chart position. */
export function PodcastCard({
    podcast,
    index,
    ranked = false,
    sizes,
    className,
}: {
    podcast: DiscoveryPodcast;
    index: number;
    ranked?: boolean;
    sizes?: string;
    className?: string;
}) {
    return (
        <MediaCard
            href={`/podcasts/${podcast.itunesId}`}
            title={podcast.title}
            subtitle={podcast.author}
            imageUrl={coverArtUrl(podcast.coverUrl)}
            fallbackIcon={Mic2}
            type="podcast"
            index={index}
            sizes={sizes}
            badge={ranked && podcast.chartRank ? <RankBadge rank={podcast.chartRank} /> : undefined}
            className={className}
        />
    );
}

export function RankBadge({ rank }: { rank: number }) {
    return (
        <span className="min-w-6 h-6 px-1.5 inline-flex items-center justify-center rounded-md bg-black/70 text-xs font-semibold tabular-nums text-white">
            {rank}
        </span>
    );
}
