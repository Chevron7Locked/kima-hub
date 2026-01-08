import { Audiobook } from "../types";
import { AudiobookCard } from "@/components/ui/AudiobookCard";
import { api } from "@/lib/api";

interface LibraryAudiobooksGridProps {
    audiobooks: Audiobook[];
}

export function LibraryAudiobooksGrid({
    audiobooks,
}: LibraryAudiobooksGridProps) {
    const getCoverUrl = (coverUrl: string | null, size = 300) => {
        if (!coverUrl) return null;
        return api.getCoverArtUrl(coverUrl, size);
    };

    return (
        <div
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-4"
            data-tv-section="search-results-audiobooks"
        >
            {audiobooks.slice(0, 6).map((audiobook, index) => (
                <AudiobookCard
                    key={audiobook.id}
                    id={audiobook.id}
                    title={audiobook.title}
                    author={audiobook.author || "Unknown Author"}
                    coverUrl={audiobook.coverUrl}
                    index={index}
                    getCoverUrl={getCoverUrl}
                />
            ))}
        </div>
    );
}
