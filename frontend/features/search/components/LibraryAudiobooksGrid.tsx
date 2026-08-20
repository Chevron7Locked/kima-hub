import { Book } from "lucide-react";
import { MediaCard } from "@/components/cards/MediaCard";
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
        >
            {audiobooks.slice(0, 6).map((audiobook, index) => (
                <MediaCard
                    key={audiobook.id}
                    href={`/audiobooks/${audiobook.id}`}
                    title={audiobook.title}
                    subtitle={audiobook.author || "Unknown author"}
                    imageUrl={
                        audiobook.coverUrl
                            ? api.getCoverArtUrl(audiobook.coverUrl, 200)
                            : null
                    }
                    fallbackIcon={Book}
                    accentColor={{
                        border: "hover:border-[#f59e0b]/50",
                        gradient: "bg-gradient-to-r from-[#f59e0b] to-[#d97706]",
                        button: "bg-[#f59e0b] text-black",
                        shadow: "hover:shadow-[#f59e0b]/10",
                    }}
                    index={index}
                />
            ))}
        </div>
    );
}
