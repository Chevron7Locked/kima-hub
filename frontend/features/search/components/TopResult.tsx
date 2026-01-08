import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { Artist, DiscoverResult } from "../types";
import { formatListeners } from "@/lib/format";

interface TopResultProps {
    libraryArtist?: Artist;
    discoveryArtist?: DiscoverResult;
}

export function TopResult({ libraryArtist, discoveryArtist }: TopResultProps) {
    // Prefer library artist over discovery
    if (!libraryArtist && !discoveryArtist) {
        return null;
    }

    const isLibrary = !!libraryArtist;
    
    // Get the display name
    const name = libraryArtist?.name || discoveryArtist?.name || "";
    
    // Get the artist ID for linking - prefer MBID for consistent URLs
    const artistId = isLibrary
        ? libraryArtist!.mbid || libraryArtist!.id
        : discoveryArtist?.mbid || encodeURIComponent(name);

    // Get the image URL
    const imageUrl = isLibrary 
        ? libraryArtist?.heroUrl 
        : discoveryArtist?.image;

    return (
        <section data-tv-section="search-top-result">
            <h2 className="text-2xl font-bold text-white mb-6">Top result</h2>
            <Link
                href={`/artist/${artistId}`}
                className="bg-[#121212] hover:bg-[#181818] p-6 rounded-lg transition-all flex items-center gap-6 w-full sm:w-96"
                data-tv-card
                data-tv-card-index={0}
                tabIndex={0}
            >
                <div className="relative w-24 h-24 bg-[#181818] rounded-full flex items-center justify-center overflow-hidden shrink-0">
                    {imageUrl ? (
                        <Image
                            src={api.getCoverArtUrl(imageUrl, 300)}
                            alt={name}
                            fill
                            sizes="96px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <Music className="w-12 h-12 text-gray-600" />
                    )}
                </div>
                <div className="flex-1">
                    <h3 className="text-3xl font-bold text-white mb-2">
                        {name}
                    </h3>
                    <p className="text-sm text-white font-bold">Artist</p>
                </div>
            </Link>
        </section>
    );
}
