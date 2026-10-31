"use client";

import { Disc3 } from "lucide-react";
import Link from "next/link";
import { Album, AlbumSource } from "../types";
import { ReactNode } from "react";
import { MetadataEditControls } from "@/components/MetadataEditControls";
import { getAlbumDisplayData } from "@/hooks/useMetadataDisplay";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatDuration, plural } from "@/lib/format";
import { MediaHero } from "@/components/ui/MediaHero";

interface AlbumHeroProps {
    album: Album;
    source: AlbumSource;
    coverUrl: string | null;
    colors: ColorPalette | null;
    onReload: () => void;
    children?: ReactNode;
}

export function AlbumHero({
    album,
    source,
    coverUrl,
    colors,
    onReload,
    children,
}: AlbumHeroProps) {
    const displayData = getAlbumDisplayData(album);

    const totalDuration = album.duration ? formatDuration(album.duration) : "";
    const trackCount = album.trackCount ?? 0;

    return (
        <MediaHero
            image={coverUrl}
            alt={album.title}
            colors={colors}
            tint="music"
            fallback={["#3d2a1e", "#1a1a1a"]}
            shape="square"
            fallbackIcon={<Disc3 className="w-16 h-16 text-[var(--text-muted)]" />}
            eyebrowDotClass="bg-type-album"
            eyebrowLabel="Album"
            title={displayData.title}
            titleExtra={
                <MetadataEditControls
                    edited={displayData.hasUserOverrides}
                    editable={source === "library"}
                    type="album"
                    id={album.id}
                    currentData={{
                        title: displayData.title,
                        year: displayData.year ?? undefined,
                        genres: displayData.genres,
                        mbid: album.mbid,
                        coverUrl: displayData.coverUrl ?? undefined,
                        _originalTitle: album.title,
                        _originalYear: album.year,
                        _originalGenres: album.genre ? [album.genre] : [],
                        _originalCoverUrl: album.coverUrl,
                        _hasUserOverrides: displayData.hasUserOverrides,
                    }}
                    onSave={async () => {
                        await onReload();
                    }}
                />
            }
            meta={
                <>
                    {album.artist && (
                        <Link
                            href={`/artist/${album.artist.id}`}
                            className="font-medium text-white hover:underline"
                        >
                            {album.artist.name}
                        </Link>
                    )}
                    {!!displayData.year && (
                        <>
                            <span className="mx-1">•</span>
                            <span>{displayData.year}</span>
                        </>
                    )}
                    {trackCount > 0 && (
                        <>
                            <span className="mx-1">•</span>
                            <span>{plural(trackCount, "song")}</span>
                        </>
                    )}
                    {totalDuration && <span>, {totalDuration}</span>}
                </>
            }
            metaExtra={
                album.genre ? (
                    <span className="inline-block px-2 py-0.5 bg-white/10 rounded-full text-xs text-[var(--text-secondary)]">
                        {album.genre}
                    </span>
                ) : undefined
            }
        >
            {children}
        </MediaHero>
    );
}
