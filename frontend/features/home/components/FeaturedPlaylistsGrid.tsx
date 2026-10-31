"use client";

import { Music2 } from "lucide-react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { cascadeStyle } from "@/lib/motion";
import { memo } from "react";
import { PlaylistPreview } from "../types";
import { DeezerIcon } from "./DeezerIcon";
import { MediaCard } from "@/components/cards/MediaCard";
import { plural } from "@/lib/format";

interface FeaturedPlaylistsGridProps {
    playlists: PlaylistPreview[];
}

export function FeaturedPlaylistsSkeleton() {
    return (
        <div className="flex gap-(--card-gap) overflow-hidden animate-fade-soft">
            {[...Array(8)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-[140px] sm:w-[160px] md:w-(--card-w)">
                    <div className="bg-[var(--bg-primary)] border border-white/10 rounded-lg overflow-hidden">
                        <div className="aspect-square bg-[#181818] animate-pulse" />
                        <div className="p-3">
                            <div className="h-4 bg-white/5 rounded animate-pulse w-3/4 mb-2" />
                            <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

export const FeaturedPlaylistsGrid = memo(function FeaturedPlaylistsGrid({
    playlists,
}: FeaturedPlaylistsGridProps) {
    if (!playlists || playlists.length === 0) {
        return null;
    }

    return (
        <HorizontalCarousel style={cascadeStyle(Math.min(playlists.length, 20))}>
            {playlists.slice(0, 20).map((playlist, index) => (
                <CarouselItem key={`home-playlist-${playlist.id}-${index}`}>
                    <MediaCard
                        href={`/browse/playlists/${playlist.id}`}
                        title={playlist.title}
                        subtitle={plural(playlist.trackCount, "track")}
                        imageUrl={playlist.imageUrl || null}
                        fallbackIcon={Music2}
                        type="track"
                        index={index}
                        sizes="180px"
                        badge={
                            <span className="block p-1 bg-black/60 rounded">
                                <DeezerIcon className="w-3.5 h-3.5 text-brand" />
                            </span>
                        }
                    />
                </CarouselItem>
            ))}
        </HorizontalCarousel>
    );
});
