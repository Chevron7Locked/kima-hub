"use client";

import { PlayableCard } from "@/components/ui/PlayableCard";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import type { Album } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { SectionHeader } from "@/features/home/components/SectionHeader";

interface DiscographyProps {
    albums: Album[];
    colors: ColorPalette | null;
    onPlayAlbum: (albumId: string, albumTitle: string) => Promise<void>;
    sortBy: "year" | "dateAdded";
    onSortChange: (sortBy: "year" | "dateAdded") => void;
}

export function Discography({
    albums,
    colors,
    onPlayAlbum,
    sortBy,
    onSortChange,
}: DiscographyProps) {
    if (!albums || albums.length === 0) {
        return null;
    }

    return (
        <section>
            <SectionHeader
                color="albums"
                title="Discography"
                rightAction={
                    <select
                        value={sortBy}
                        onChange={(e) =>
                            onSortChange(e.target.value as "year" | "dateAdded")
                        }
                        className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-full text-white text-xs focus:outline-none focus:border-white/20 [&>option]:bg-[var(--bg-hover)] [&>option]:text-white"
                    >
                        <option value="year">Year (Newest)</option>
                        <option value="dateAdded">Date Added (Recent)</option>
                    </select>
                }
            />
            <div
                data-tv-section="discography"
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4"
            >
                {albums.map((album, index) => {
                    const subtitle = [
                        album.year,
                        album.trackCount && `${album.trackCount} tracks`,
                    ]
                        .filter(Boolean)
                        .join(" • ");

                    return (
                        <PlayableCard
                            key={album.id}
                            href={`/album/${album.id}`}
                            coverArt={
                                album.coverArt
                                    ? api.getCoverArtUrl(album.coverArt, 300)
                                    : null
                            }
                            title={album.title}
                            subtitle={subtitle}
                            placeholderIcon={
                                <Disc3 className="w-12 h-12 text-gray-600" />
                            }
                            badge="owned"
                            circular={false}
                            colors={colors}
                            onPlay={() => onPlayAlbum(album.id, album.title)}
                            tvCardIndex={index}
                        />
                    );
                })}
            </div>
        </section>
    );
}
