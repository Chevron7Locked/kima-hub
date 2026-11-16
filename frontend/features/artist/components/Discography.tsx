"use client";

import { pathFor } from "@/lib/paths";
import { MediaCard } from "@/components/cards/MediaCard";
import { Disc3, Play } from "lucide-react";
import { api } from "@/lib/api";
import type { Album } from "../types";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { plural } from "@/lib/format";

interface DiscographyProps {
    albums: Album[];
    onPlayAlbum: (albumId: string) => Promise<void>;
    sortBy: "year" | "dateAdded";
    onSortChange: (sortBy: "year" | "dateAdded") => void;
}

export function Discography({
    albums,
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
                type="album"
                title="Discography"
                action={
                    <select
                        value={sortBy}
                        onChange={(e) =>
                            onSortChange(e.target.value as "year" | "dateAdded")
                        }
                        className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-full text-white text-xs focus:outline-none focus:border-white/20 [&>option]:bg-[var(--bg-hover)] [&>option]:text-white"
                    >
                        <option value="year">year (newest)</option>
                        <option value="dateAdded">date added (recent)</option>
                    </select>
                }
            />
            <div
                data-tv-section="discography"
                className="grid-media"
            >
                {albums.map((album, index) => {
                    const subtitle = [
                        album.year,
                        album.trackCount && plural(album.trackCount, "track"),
                    ]
                        .filter(Boolean)
                        .join(" • ");

                    return (
                        <MediaCard
                            key={album.id}
                            href={pathFor("/album", album.id)}
                            imageUrl={album.coverArt ? api.getCoverArtUrl(album.coverArt, 300) : null}
                            title={album.title}
                            subtitle={subtitle}
                            fallbackIcon={Disc3}
                            type="album"
                            index={index}
                            action={{ icon: Play, label: "Play", onClick: () => onPlayAlbum(album.id) }}
                        />
                    );
                })}
            </div>
        </section>
    );
}
