"use client";

import { Music } from "lucide-react";
import { Artist, ArtistSource, Album } from "../types";
import { ReactNode } from "react";
import { MetadataEditControls } from "@/components/MetadataEditControls";
import { getArtistDisplayData } from "@/hooks/useMetadataDisplay";
import type { ColorPalette } from "@/hooks/useImageColor";
import { plural } from "@/lib/format";
import { MediaHero } from "@/components/ui/MediaHero";

interface ArtistHeroProps {
    artist: Artist;
    source: ArtistSource | null;
    albums: Album[];
    heroImage: string | null;
    backgroundImage?: string | null;
    colors: ColorPalette | null;
    onReload: () => void;
    children?: ReactNode;
}

export function ArtistHero({
    artist,
    source,
    albums,
    heroImage,
    backgroundImage,
    colors,
    onReload,
    children,
}: ArtistHeroProps) {
    const displayData = getArtistDisplayData(artist);
    const ownedAlbums = albums.filter((a) => a.owned);
    const listeners = artist.listeners ?? 0;

    // Use background image if provided, otherwise fall back to hero image
    const bgImage = backgroundImage || heroImage;

    return (
        <MediaHero
            image={bgImage}
            coverImage={heroImage}
            alt={displayData.name}
            colors={colors}
            tint="music"
            fallback={["#3d2a1e", "#1a1a1a"]}
            shape="circle"
            fallbackIcon={<Music className="w-16 h-16 text-[var(--text-muted)]" />}
            eyebrowDotClass="bg-type-artist"
            eyebrowLabel="Artist"
            title={displayData.name}
            titleGap="gap-3"
            titleExtra={
                <MetadataEditControls
                    edited={displayData.hasUserOverrides}
                    editable={source === "library"}
                    type="artist"
                    id={artist.id}
                    currentData={{
                        name: displayData.name,
                        bio: displayData.summary ?? undefined,
                        genres: displayData.genres,
                        mbid: artist.mbid,
                        heroUrl: displayData.heroUrl ?? undefined,
                        _originalName: artist.name,
                        _originalBio: artist.summary ?? artist.bio,
                        _originalGenres: artist.genres ?? artist.tags ?? [],
                        _originalHeroUrl: artist.heroUrl ?? artist.image,
                        _hasUserOverrides: displayData.hasUserOverrides,
                    }}
                    onSave={async () => {
                        await onReload();
                    }}
                />
            }
            meta={
                <>
                    {listeners > 0 && (
                        <>
                            <span>{listeners.toLocaleString()} listeners</span>
                            <span className="mx-1">•</span>
                        </>
                    )}
                    {albums.length > 0 && (
                        <>
                            <span>{plural(albums.length, "album")}</span>
                            {ownedAlbums.length > 0 && (
                                <>
                                    <span className="mx-1">•</span>
                                    <span>{ownedAlbums.length} owned</span>
                                </>
                            )}
                        </>
                    )}
                </>
            }
        >
            {children}
        </MediaHero>
    );
}
