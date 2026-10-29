"use client";

import { useState, useEffect } from "react";
import { Album, ArtistSource } from "../types";
import { MediaCard } from "@/components/cards/MediaCard";
import { Disc3, Download } from "lucide-react";
import { api } from "@/lib/api";
import { isMbid } from "@/lib/mbid";
import { SectionHeader } from "@/components/ui/SectionHeader";

interface AvailableAlbumsProps {
    albums: Album[];
    source: ArtistSource | null;
    /** Absent for someone who may not start downloads: the cards offer no download then. */
    onDownloadAlbum?: (album: Album) => void;
    isPendingDownload: (mbid: string) => boolean;
}

// Component to handle lazy-loading cover art for albums without cached covers
function LazyAlbumCard({
    album,
    source,
    onDownloadAlbum,
    isPendingDownload,
    index,
}: {
    album: Album;
    source: ArtistSource | null;
    onDownloadAlbum?: (album: Album) => void;
    isPendingDownload: (mbid: string) => boolean;
    index: number;
}) {
    const [coverArt, setCoverArt] = useState<string | null>(() => {
        if (source === "library" && album.coverArt) {
            return api.getCoverArtUrl(album.coverArt, 300);
        }
        if (album.coverUrl) {
            return api.getCoverArtUrl(album.coverUrl, 300);
        }
        return null;
    });
    const [fetchAttempted, setFetchAttempted] = useState(false);

    useEffect(() => {
        if (coverArt || fetchAttempted) return;

        const mbid = [album.rgMbid, album.mbid].find(isMbid);
        if (!mbid) return;

        // Fetch cover art from our backend (which caches it)
        const fetchCover = async () => {
            try {
                const response = await api.request<{ coverUrl: string }>(
                    `/library/album-cover/${mbid}`
                );
                if (response.coverUrl) {
                    setCoverArt(api.getCoverArtUrl(response.coverUrl, 300));
                }
            } catch {
                // Cover not found, leave as null
            } finally {
                setFetchAttempted(true);
            }
        };

        // Delay fetch slightly to avoid thundering herd on page load
        const timeoutId = setTimeout(fetchCover, index * 100);
        return () => clearTimeout(timeoutId);
    }, [album, coverArt, fetchAttempted, index]);

    const albumMbid = album.rgMbid || album.mbid || "";

    const subtitleParts: string[] = [];
    if (album.year) subtitleParts.push(String(album.year));
    if (album.type) subtitleParts.push(album.type);
    const subtitle = subtitleParts.join(" • ");

    return (
        <MediaCard
            href={`/album/${album.id}`}
            imageUrl={coverArt}
            title={album.title}
            subtitle={subtitle}
            fallbackIcon={Disc3}
            type="album"
            index={index}
            action={
                onDownloadAlbum && {
                    icon: Download,
                    label: "download",
                    onClick: () => onDownloadAlbum(album),
                    busy: isPendingDownload(albumMbid),
                }
            }
        />
    );
}

function AlbumGrid({
    albums,
    source,
    onDownloadAlbum,
    isPendingDownload,
}: AvailableAlbumsProps) {
    return (
        <div className="grid-media">
            {albums.map((album, index) => (
                <LazyAlbumCard
                    key={album.id}
                    album={album}
                    source={source}
                    onDownloadAlbum={onDownloadAlbum}
                    isPendingDownload={isPendingDownload}
                    index={index}
                />
            ))}
        </div>
    );
}

export function AvailableAlbums({
    albums,
    source,
    onDownloadAlbum,
    isPendingDownload,
}: AvailableAlbumsProps) {
    if (!albums || albums.length === 0) {
        return null;
    }

    const studioAlbums = albums.filter(
        (album) => album.type?.toLowerCase() === "album"
    );
    const epsAndSingles = albums.filter(
        (album) => album.type?.toLowerCase() !== "album"
    );

    return (
        <>
            {studioAlbums.length > 0 && (
                <section>
                    <SectionHeader type="album" title="Albums Available" />
                    <div data-tv-section="available-albums">
                        <AlbumGrid
                            albums={studioAlbums}
                            source={source}
                            onDownloadAlbum={onDownloadAlbum}
                            isPendingDownload={isPendingDownload}
                        />
                    </div>
                </section>
            )}

            {epsAndSingles.length > 0 && (
                <section>
                    <SectionHeader type="album" title="Singles and EPs" />
                    <div data-tv-section="available-eps-singles">
                        <AlbumGrid
                            albums={epsAndSingles}
                            source={source}
                            onDownloadAlbum={onDownloadAlbum}
                            isPendingDownload={isPendingDownload}
                        />
                    </div>
                </section>
            )}
        </>
    );
}
