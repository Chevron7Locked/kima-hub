import Link from "next/link";
import { Music, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { Artist, DiscoverResult } from "../types";
import { CachedImage } from "@/components/ui/CachedImage";

interface TopResultProps {
    libraryArtist?: Artist;
    discoveryArtist?: DiscoverResult;
}

export function TopResult({ libraryArtist, discoveryArtist }: TopResultProps) {
    if (!libraryArtist && !discoveryArtist) {
        return null;
    }

    const isLibrary = !!libraryArtist;
    const name = libraryArtist?.name || discoveryArtist?.name || "";
    const artistId = isLibrary
        ? libraryArtist!.id
        : discoveryArtist?.mbid || encodeURIComponent(name);
    const imageUrl = isLibrary
        ? libraryArtist?.heroUrl
        : discoveryArtist?.image;

    return (
        <Link
            href={`/artist/${artistId}`}
            className="group relative block overflow-hidden rounded-2xl bg-gradient-to-br from-[#1a1a1a] to-[#0f0f0f] border border-white/5 hover:border-brand/30 transition-colors duration-200"
            data-tv-card
            data-tv-card-index={0}
        >
            <div className="absolute inset-0 opacity-20 group-hover:opacity-30 transition-opacity duration-200">
                {imageUrl ? (
                    <CachedImage
                        src={api.getCoverArtUrl(imageUrl, 400)}
                        alt={name}
                        fill
                        className="object-cover"
                        loading="lazy"
                    />
                ) : null}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/90 to-transparent" />
            </div>

            <div className="relative p-5 md:p-8 flex items-end md:min-h-[280px]">
                <div className="flex items-center gap-4 md:gap-6 w-full">
                    <div className="relative w-20 h-20 md:w-32 md:h-32 rounded-2xl bg-[#181818] flex items-center justify-center overflow-hidden shrink-0 ring-2 ring-white/10 group-hover:ring-brand/50 transition-all duration-200">
                        {imageUrl ? (
                            <CachedImage
                                src={api.getCoverArtUrl(imageUrl, 200)}
                                alt={name}
                                fill
                                sizes="128px"
                                className="object-cover cover-zoom"
                                loading="lazy"
                            />
                        ) : (
                            <Music className="w-10 h-10 md:w-16 md:h-16 text-[var(--text-muted)]" />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-semibold text-brand">
                                Artist
                            </span>
                            <span className="w-1 h-1 rounded-full bg-brand/50" />
                            <span className="text-xs text-[var(--text-muted)]">
                                {isLibrary ? "Your library" : "Discover"}
                            </span>
                        </div>
                        <h3 className="text-2xl md:text-4xl font-bold text-white mb-2 leading-tight line-clamp-2 break-words group-hover:text-brand transition-colors duration-200">
                            {name}
                        </h3>
                        <div className="flex items-center gap-2 text-[var(--text-secondary)] group-hover:text-gray-300 transition-colors">
                            <span className="text-sm font-medium">View profile</span>
                            <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-150" />
                        </div>
                    </div>
                </div>
            </div>

            <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-brand via-brand-dark to-brand transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150 origin-center" />
        </Link>
    );
}
