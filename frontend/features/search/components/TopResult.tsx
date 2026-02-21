import Link from "next/link";
import Image from "next/image";
import { Music, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { Artist, DiscoverResult } from "../types";

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
            className="group relative block overflow-hidden rounded-2xl bg-gradient-to-br from-[#1a1a1a] to-[#0f0f0f] border border-white/5 hover:border-[#eab308]/30 transition-all duration-500 hover:scale-[1.02] hover:shadow-2xl hover:shadow-[#eab308]/10"
            data-tv-card
            data-tv-card-index={0}
            tabIndex={0}
        >
            {/* Background Image with Overlay */}
            <div className="absolute inset-0 opacity-20 group-hover:opacity-30 transition-opacity duration-500">
                {imageUrl ? (
                    <Image
                        src={api.getCoverArtUrl(imageUrl, 400)}
                        alt={name}
                        fill
                        sizes="400px"
                        className="object-cover"
                        loading="lazy"
                        unoptimized
                    />
                ) : null}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/90 to-transparent" />
            </div>

            {/* Content */}
            <div className="relative p-8 flex items-end min-h-[280px]">
                <div className="flex items-center gap-6 w-full">
                    {/* Artist Image */}
                    <div className="relative w-32 h-32 rounded-2xl bg-[#181818] flex items-center justify-center overflow-hidden shrink-0 ring-2 ring-white/10 group-hover:ring-[#eab308]/50 transition-all duration-500">
                        {imageUrl ? (
                            <Image
                                src={api.getCoverArtUrl(imageUrl, 200)}
                                alt={name}
                                fill
                                sizes="128px"
                                className="object-cover group-hover:scale-110 transition-transform duration-500"
                                loading="lazy"
                                unoptimized
                            />
                        ) : (
                            <Music className="w-16 h-16 text-gray-600" />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                    </div>

                    {/* Text Content */}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-bold text-[#eab308] uppercase tracking-wider">
                                Artist
                            </span>
                            <span className="w-1 h-1 rounded-full bg-[#eab308]/50" />
                            <span className="text-xs text-gray-500 uppercase tracking-wider">
                                {isLibrary ? "Your Library" : "Discover"}
                            </span>
                        </div>
                        <h3 className="text-4xl font-black text-white mb-2 leading-tight truncate group-hover:text-[#eab308] transition-colors duration-300">
                            {name}
                        </h3>
                        <div className="flex items-center gap-2 text-gray-400 group-hover:text-gray-300 transition-colors">
                            <span className="text-sm font-medium">View Profile</span>
                            <ExternalLink className="w-4 h-4 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-300" />
                        </div>
                    </div>
                </div>
            </div>

            {/* Accent Line */}
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-[#eab308] via-[#f59e0b] to-[#eab308] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-500 origin-center" />
        </Link>
    );
}
