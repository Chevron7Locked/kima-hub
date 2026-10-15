"use client";

import { Mic2, Pause, Play } from "lucide-react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { MediaCard } from "@/components/cards/MediaCard";
import { cascadeStyle } from "@/lib/motion";
import { coverArtUrl } from "@/lib/cover-art";
import { usePlayEpisode } from "../hooks/usePlayEpisode";
import type { ListeningRow } from "../types";

/** Episodes partway through, from any followed show, each resumable in place. */
export function ListeningShelf({ rows }: { rows: ListeningRow[] }) {
    const { toggle, isPlayingRow } = usePlayEpisode();
    return (
        <HorizontalCarousel style={cascadeStyle(rows.length)}>
            {rows.map((row, index) => {
                const playing = isPlayingRow(row);
                return (
                    <CarouselItem key={row.episode.id}>
                        <MediaCard
                            href={`/podcasts/${row.podcast.id}`}
                            title={row.episode.title}
                            subtitle={row.podcast.title}
                            imageUrl={coverArtUrl(row.episode.coverUrl || row.podcast.coverUrl)}
                            fallbackIcon={Mic2}
                            type="podcast"
                            index={index}
                            sizes="180px"
                            progress={row.episode.progress?.progress}
                            action={{ icon: playing ? Pause : Play, label: playing ? "pause" : "resume", onClick: () => toggle(row) }}
                            className="mx-1"
                        />
                    </CarouselItem>
                );
            })}
        </HorizontalCarousel>
    );
}
