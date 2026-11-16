"use client";

import { pathFor } from "@/lib/paths";
import { SimilarArtist } from "../types";
import { Music, Library } from "lucide-react";
import { plural } from "@/lib/format";
import { api } from "@/lib/api";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { MediaCard } from "@/components/cards/MediaCard";

interface SimilarArtistsProps {
    similarArtists: SimilarArtist[];
}

export function SimilarArtists({ similarArtists }: SimilarArtistsProps) {
    if (!similarArtists || similarArtists.length === 0) {
        return null;
    }

    return (
        <section>
            <SectionHeader type="artist" title="Fans Also Like" />
            <div
                data-tv-section="similar-artists"
                className="grid-media"
            >
                {similarArtists.map((artist, index) => {
                    const rawImage = artist.coverArt || artist.image;
                    const imageUrl = rawImage
                        ? api.getCoverArtUrl(rawImage, 300)
                        : null;
                    const matchPercentage = artist.weight
                        ? Math.round(artist.weight * 100)
                        : null;

                    const navigationId = artist.inLibrary
                        ? artist.id
                        : artist.mbid || artist.id;

                    const libraryLine =
                        artist.ownedAlbumCount && artist.ownedAlbumCount > 0
                            ? `${plural(artist.ownedAlbumCount, "album")} in library`
                            : "Artist";

                    return (
                        <MediaCard
                            key={artist.id || artist.name}
                            href={pathFor("/artist", navigationId)}
                            title={artist.name}
                            subtitle={matchPercentage !== null ? `${libraryLine} · ${matchPercentage}% match` : libraryLine}
                            imageUrl={imageUrl}
                            fallbackIcon={Music}
                            type="artist"
                            index={index}
                            corner={
                                artist.inLibrary && (
                                    <span className="block bg-brand rounded-full p-1" title="in your library">
                                        <Library className="w-3 h-3 text-black" />
                                    </span>
                                )
                            }
                        />
                    );
                })}
            </div>
        </section>
    );
}
