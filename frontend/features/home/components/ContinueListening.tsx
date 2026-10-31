"use client";

import { Music, Disc, BookOpen } from "lucide-react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { MediaCard } from "@/components/cards/MediaCard";
import { cascadeStyle } from "@/lib/motion";
import { memo } from "react";
import { ListenedItem } from "../types";

interface ContinueListeningProps {
    items: ListenedItem[];
}

function imageFor(item: ListenedItem) {
    if (item.type === "audiobook") {
        return api.getCoverArtUrl(`/audiobooks/${item.id}/cover`, 300);
    }
    return item.coverArt ? api.getCoverArtUrl(item.coverArt, 300) : null;
}

const VIEWS = {
    podcast: { href: "/podcasts/", icon: Disc, label: "Podcast" },
    audiobook: { href: "/audiobooks/", icon: BookOpen, label: "Audiobook" },
    artist: { href: "/artist/", icon: Music, label: "Artist" },
} as const;

const ContinueListening = memo(function ContinueListening({ items }: ContinueListeningProps) {
    return (
        <HorizontalCarousel style={cascadeStyle(items.length)}>
            {items.map((item, index) => {
                const type = item.type === "podcast" || item.type === "audiobook" ? item.type : "artist";
                const view = VIEWS[type];
                return (
                    <CarouselItem key={`${item.type}-${item.id}`}>
                        <MediaCard
                            href={`${view.href}${item.id}`}
                            title={item.name}
                            subtitle={type === "artist" ? view.label : item.author || view.label}
                            imageUrl={imageFor(item)}
                            fallbackIcon={view.icon}
                            type={type}
                            index={index}
                            sizes="180px"
                            progress={type === "artist" ? undefined : item.progress ?? undefined}
                        />
                    </CarouselItem>
                );
            })}
        </HorizontalCarousel>
    );
});

export { ContinueListening };
