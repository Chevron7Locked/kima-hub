"use client";

import Link from "next/link";
import Image from "next/image";
import { Music, Disc, BookOpen } from "lucide-react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo } from "react";
import { ListenedItem } from "../types";

interface ContinueListeningProps {
    items: ListenedItem[];
}

const getImageForItem = (item: ListenedItem) => {
    if (item.type === "audiobook") {
        return api.getCoverArtUrl(`/audiobooks/${item.id}/cover`, 300);
    }
    if (item.coverArt) {
        return api.getCoverArtUrl(item.coverArt, 300);
    }
    return null;
};

const getDescriptionLabel = (item: ListenedItem) => {
    if (item.type === "podcast") {
        if (
            item.author &&
            item.author.trim().length > 0 &&
            item.author.trim().toLowerCase() !== item.name.trim().toLowerCase()
        ) {
            return item.author;
        }
        return "Podcast";
    }
    if (item.type === "audiobook") {
        return item.author && item.author.trim().length > 0
            ? item.author
            : "Audiobook";
    }
    return "Artist";
};

const TYPE_COLORS: Record<string, { border: string; accent: string; gradient: string }> = {
    artist: {
        border: "hover:border-[#ec4899]/40",
        accent: "from-[#ec4899] to-[#db2777]",
        gradient: "hover:shadow-[#ec4899]/10",
    },
    podcast: {
        border: "hover:border-[#3b82f6]/40",
        accent: "from-[#3b82f6] to-[#2563eb]",
        gradient: "hover:shadow-[#3b82f6]/10",
    },
    audiobook: {
        border: "hover:border-[#f59e0b]/40",
        accent: "from-[#f59e0b] to-[#d97706]",
        gradient: "hover:shadow-[#f59e0b]/10",
    },
};

interface ContinueListeningCardProps {
    item: ListenedItem;
    index: number;
}

const ContinueListeningCard = memo(function ContinueListeningCard({
    item,
    index,
}: ContinueListeningCardProps) {
    const isPodcast = item.type === "podcast";
    const isAudiobook = item.type === "audiobook";
    const imageSrc = getImageForItem(item);
    const href = isPodcast
        ? `/podcasts/${item.id}`
        : isAudiobook
        ? `/audiobooks/${item.id}`
        : `/artist/${item.id}`;
    const hasProgress =
        (isPodcast || isAudiobook) &&
        item.progress &&
        item.progress > 0;
    const colors = TYPE_COLORS[item.type] || TYPE_COLORS.artist;

    return (
        <CarouselItem>
            <Link
                href={href}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="group block"
            >
                <div className={`relative bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden ${colors.border} transition-all duration-300 hover:shadow-lg ${colors.gradient} mx-1`}>
                    <div className="relative aspect-square overflow-hidden">
                        <div className="w-full h-full bg-[#181818] flex items-center justify-center">
                            {imageSrc ? (
                                <Image
                                    src={imageSrc}
                                    alt={item.name}
                                    fill
                                    className="object-cover group-hover:scale-110 transition-transform duration-500"
                                    sizes="180px"
                                    priority={false}
                                    unoptimized
                                />
                            ) : isPodcast ? (
                                <Disc className="w-10 h-10 text-gray-700" />
                            ) : isAudiobook ? (
                                <BookOpen className="w-10 h-10 text-gray-700" />
                            ) : (
                                <Music className="w-10 h-10 text-gray-700" />
                            )}
                        </div>
                        {hasProgress && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                                <div
                                    className={`h-full bg-gradient-to-r ${colors.accent}`}
                                    style={{ width: `${item.progress}%` }}
                                />
                            </div>
                        )}
                        {!hasProgress && (
                            <div className={`absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r ${colors.accent} transform scale-x-0 group-hover:scale-x-100 transition-transform duration-300`} />
                        )}
                    </div>
                    <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-black text-white truncate tracking-tight">
                            {item.name}
                        </h3>
                        <p className="text-xs font-mono text-gray-500 uppercase tracking-wider truncate mt-0.5">
                            {getDescriptionLabel(item)}
                        </p>
                    </div>
                </div>
            </Link>
        </CarouselItem>
    );
});

const ContinueListening = memo(function ContinueListening({ items }: ContinueListeningProps) {
    return (
        <HorizontalCarousel>
            {items.map((item, index) => (
                <ContinueListeningCard
                    key={`${item.type}-${item.id}`}
                    item={item}
                    index={index}
                />
            ))}
        </HorizontalCarousel>
    );
});

export { ContinueListening };
