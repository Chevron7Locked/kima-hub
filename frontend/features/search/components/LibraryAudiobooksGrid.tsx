import { pathFor } from "@/lib/paths";
import { Book } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
import { cascadeStyle } from "@/lib/motion";
import { Audiobook } from "../types";
import { api } from "@/lib/api";

interface LibraryAudiobooksGridProps {
    audiobooks: Audiobook[];
}

export function LibraryAudiobooksGrid({
    audiobooks,
}: LibraryAudiobooksGridProps) {
    return (
        <div
            className="grid-media"
            data-tv-section="search-results-audiobooks"
            style={cascadeStyle(Math.min(audiobooks.length, 6))}
        >
            {audiobooks.slice(0, 6).map((audiobook, index) => (
                <MediaCard
                    key={audiobook.id}
                    href={pathFor("/audiobooks", audiobook.id)}
                    title={audiobook.title}
                    subtitle={audiobook.author || "Unknown author"}
                    imageUrl={
                        audiobook.coverUrl
                            ? api.getCoverArtUrl(audiobook.coverUrl, 200)
                            : null
                    }
                    fallbackIcon={Book}
                    type="audiobook"
                    index={index}
                />
            ))}
        </div>
    );
}
