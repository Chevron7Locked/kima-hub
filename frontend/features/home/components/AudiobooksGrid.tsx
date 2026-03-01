"use client";

import Link from "next/link";
import Image from "next/image";
import { BookOpen } from "lucide-react";
import { api } from "@/lib/api";
import { Audiobook } from "../types";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo } from "react";

interface AudiobooksGridProps {
    audiobooks: Audiobook[];
}

interface AudiobookCardProps {
    audiobook: Audiobook;
    index: number;
}

const AudiobookCard = memo(function AudiobookCard({
    audiobook,
    index,
}: AudiobookCardProps) {
    return (
        <CarouselItem>
            <Link
                href={`/audiobooks/${audiobook.id}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="group block"
            >
                <div className="relative bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#f59e0b]/40 transition-all duration-300 hover:shadow-lg hover:shadow-[#f59e0b]/10 mx-1">
                    <div className="relative aspect-square">
                        <div className="w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden">
                            {audiobook.coverUrl ? (
                                <Image
                                    src={api.getCoverArtUrl(audiobook.coverUrl, 300)}
                                    alt={audiobook.title}
                                    fill
                                    sizes="180px"
                                    className="object-cover group-hover:scale-110 transition-transform duration-150"
                                    unoptimized
                                />
                            ) : (
                                <BookOpen className="w-10 h-10 text-gray-700" />
                            )}
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#f59e0b] to-[#d97706] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                    </div>
                    <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-black text-white truncate tracking-tight">
                            {audiobook.title}
                        </h3>
                        <p className="text-xs font-mono text-gray-500 uppercase tracking-wider truncate mt-0.5">
                            {audiobook.author || "Audiobook"}
                        </p>
                    </div>
                </div>
            </Link>
        </CarouselItem>
    );
});

const AudiobooksGrid = memo(function AudiobooksGrid({ audiobooks }: AudiobooksGridProps) {
    return (
        <HorizontalCarousel>
            {audiobooks.map((audiobook, index) => (
                <AudiobookCard
                    key={audiobook.id}
                    audiobook={audiobook}
                    index={index}
                />
            ))}
        </HorizontalCarousel>
    );
});

export { AudiobooksGrid };
