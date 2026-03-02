"use client";

import { Music2, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo, useCallback } from "react";
import Image from "next/image";
import { PlaylistPreview } from "../types";

interface FeaturedPlaylistsGridProps {
    playlists: PlaylistPreview[];
}

const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

interface PlaylistCardProps {
    playlist: PlaylistPreview;
    index: number;
    onClick: (playlistId: string) => void;
}

const PlaylistCard = memo(function PlaylistCard({
    playlist,
    index,
    onClick,
}: PlaylistCardProps) {
    return (
        <CarouselItem>
            <div
                onClick={() => onClick(playlist.id)}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className="group block cursor-pointer"
            >
                <div className="relative bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden hover:border-[#a855f7]/40 transition-all duration-300 hover:shadow-lg hover:shadow-[#a855f7]/10 mx-1">
                    <div className="relative aspect-square">
                        <div className="w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden">
                            {playlist.imageUrl ? (
                                <Image
                                    src={playlist.imageUrl}
                                    alt={playlist.title}
                                    fill
                                    className="object-cover group-hover:scale-110 transition-transform duration-150"
                                    unoptimized
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#a855f7]/20 to-[#a855f7]/5">
                                    <Music2 className="w-10 h-10 text-gray-700" />
                                </div>
                            )}
                        </div>
                        <div className="absolute top-2 left-2 p-1 bg-black/60 rounded">
                            <DeezerIcon className="w-3.5 h-3.5 text-[#a855f7]" />
                        </div>
                        <button className="absolute bottom-3 right-3 w-10 h-10 rounded-lg bg-[#a855f7] flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 transition-all duration-200 hover:scale-110 hover:bg-[#9333ea]">
                            <Play className="w-4 h-4 fill-current ml-0.5 text-white" />
                        </button>
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#a855f7] to-[#c026d3] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150" />
                    </div>
                    <div className="p-3 bg-gradient-to-b from-[#0a0a0a] to-[#0f0f0f]">
                        <h3 className="text-sm font-black text-white truncate tracking-tight">
                            {playlist.title}
                        </h3>
                        <p className="text-xs font-mono text-gray-500 uppercase tracking-wider mt-0.5">
                            {playlist.trackCount} tracks
                        </p>
                    </div>
                </div>
            </div>
        </CarouselItem>
    );
});

export function FeaturedPlaylistsSkeleton() {
    return (
        <div className="flex gap-3 overflow-hidden">
            {[...Array(8)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px]">
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-lg overflow-hidden mx-1">
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
    const router = useRouter();

    const handlePlaylistClick = useCallback(
        (playlistId: string) => {
            router.push(`/browse/playlists/${playlistId}`);
        },
        [router]
    );

    if (!playlists || playlists.length === 0) {
        return null;
    }

    return (
        <HorizontalCarousel>
            {playlists.slice(0, 20).map((playlist, index) => (
                <PlaylistCard
                    key={`home-playlist-${playlist.id}-${index}`}
                    playlist={playlist}
                    index={index}
                    onClick={handlePlaylistClick}
                />
            ))}
        </HorizontalCarousel>
    );
});
