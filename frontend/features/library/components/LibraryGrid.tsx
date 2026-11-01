import { memo, type ReactNode } from "react";
import { Disc3, Music, Play, type LucideIcon } from "lucide-react";
import type { Album, Artist } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { MediaCard } from "@/components/cards/MediaCard";
import { api } from "@/lib/api";
import { cascadeStyle } from "@/lib/motion";
import { plural } from "@/lib/format";

/** One card of the collection's album or artist grid. */
export interface LibraryCard {
    id: string;
    href: string;
    title: string;
    subtitle?: string;
    coverArt?: string;
}

export const albumCard = (album: Album): LibraryCard => ({
    id: album.id,
    href: `/album/${album.id}`,
    title: album.title,
    subtitle: album.artist?.name,
    coverArt: album.coverArt,
});

export const artistCard = (artist: Artist): LibraryCard => ({
    id: artist.id,
    href: `/artist/${artist.id}`,
    title: artist.name,
    subtitle: plural(artist.albumCount || 0, "album"),
    coverArt: artist.coverArt,
});

const KINDS: Record<"album" | "artist", { icon: LucideIcon; empty: string; section: string }> = {
    album: { icon: Disc3, empty: "No albums yet", section: "library-albums" },
    artist: { icon: Music, empty: "No artists yet", section: "library-artists" },
};

/** What a collection list shows before it has items: a spinner while loading, or the empty library message. */
export function LibraryListStatus({ isLoading, icon, emptyTitle }: { isLoading: boolean; icon: ReactNode; emptyTitle: string }) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }
    return <EmptyState icon={icon} title={emptyTitle} description="Your library is empty. Sync your music to get started." />;
}

const GridCard = memo(
    function GridCard({
        card,
        kind,
        index,
        onPlay,
        moodKey,
    }: {
        card: LibraryCard;
        kind: "album" | "artist";
        index: number;
        onPlay: (id: string) => Promise<void>;
        moodKey?: string;
    }) {
        return (
            <MediaCard
                href={card.href}
                title={card.title}
                subtitle={card.subtitle}
                imageUrl={card.coverArt ? api.getCoverArtUrl(card.coverArt, 200) : null}
                fallbackIcon={KINDS[kind].icon}
                type={kind}
                index={index}
                action={{ icon: Play, label: "Play", onClick: () => onPlay(card.id) }}
                moodKey={moodKey}
            />
        );
    },
    // The mood arrives later than the card; a same-id card must still update for it.
    (prev, next) => prev.card.id === next.card.id && prev.moodKey === next.moodKey,
);

/** The collection's album or artist grid: a card per item, with its play action, and mood dot. */
export function LibraryGrid({
    kind,
    cards,
    onPlay,
    moodByKey,
    isLoading = false,
}: {
    kind: "album" | "artist";
    cards: LibraryCard[];
    onPlay: (id: string) => Promise<void>;
    /** The mood each item shares with its tracks, from the vibe map. */
    moodByKey?: Map<string, string>;
    isLoading?: boolean;
}) {
    const { icon: Icon, empty, section } = KINDS[kind];
    if (isLoading || cards.length === 0) {
        return <LibraryListStatus isLoading={isLoading} icon={<Icon className="w-12 h-12" />} emptyTitle={empty} />;
    }
    return (
        <div data-tv-section={section} className="grid-media" style={cascadeStyle(cards.length)}>
            {cards.map((card, index) => (
                <GridCard
                    key={card.id}
                    card={card}
                    kind={kind}
                    index={index}
                    onPlay={onPlay}
                    moodKey={moodByKey?.get(card.id)}
                />
            ))}
        </div>
    );
}
